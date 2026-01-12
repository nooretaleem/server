const db = require('../models/db');

// Helper function to check and mark trip as Completed if all payments, recoveries are cleared and all fuel is sold
async function checkAndCloseTrip(connection, tripId) {
    try {
        // Check if all trip_depos are fully paid (paid_amount >= payable_amount)
        // This covers both payments and recoveries since both update trip_depos.paid_amount
        const [tripDeposCheck] = await connection.execute(
            `SELECT COUNT(*) as total_count,
                    SUM(CASE WHEN paid_amount >= payable_amount THEN 1 ELSE 0 END) as paid_count
             FROM trip_depos
             WHERE trip_id = ? AND Active = 1`,
            [tripId]
        );
        
        const totalCount = parseInt(tripDeposCheck[0]?.total_count || 0);
        const paidCount = parseInt(tripDeposCheck[0]?.paid_count || 0);
        
        // Check if all fuel is sold (sum of quantity_ltr from trip_products equals sum of fuel from pol_sale)
        const [fuelCheck] = await connection.execute(
            `SELECT 
                COALESCE((SELECT SUM(quantity_ltr) FROM trip_products WHERE trip_id = ? AND Active = 1), 0) as total_fuel,
                COALESCE((SELECT SUM(fuel) FROM pol_sale WHERE trip_id = ? AND Active = 1), 0) as sold_fuel
            `,
            [tripId, tripId]
        );
        
        const totalFuel = parseFloat(fuelCheck[0]?.total_fuel || 0);
        const soldFuel = parseFloat(fuelCheck[0]?.sold_fuel || 0);
        
        // If all payments/recoveries are cleared and all fuel is sold, update status to 'Completed'
        // Also allow completing if there's no fuel to sell (totalFuel = 0) and all payments are cleared
        if (totalCount > 0 && paidCount === totalCount && (totalFuel === 0 || (totalFuel > 0 && soldFuel >= totalFuel))) {
            await connection.execute(
                `UPDATE trips 
                 SET status = 'Completed', 
                     completed_at = NOW(),
                     MD = NOW()
                 WHERE id = ? AND status != 'Completed' AND status != 'Cancelled'`,
                [tripId]
            );
            console.log(`Trip ${tripId} status updated to Completed - all payments/recoveries cleared and all fuel sold`);
        }
    } catch (err) {
        console.error(`Error checking/completing trip ${tripId}:`, err);
        // Don't throw error, just log it
    }
}

// Add payment transaction
exports.addPayment = async (req, res) => {
    try {
        const {
            AccountID,
            DepoID,
            Amount,
            PaymentMode,
            ReferenceNo
        } = req.body;

        // Validation
        if (!AccountID) {
            return res.status(400).json({ message: 'Account ID is required' });
        }
        if (!DepoID) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }
        if (!Amount || Amount <= 0) {
            return res.status(400).json({ message: 'Amount is required and must be greater than 0' });
        }
        if (!PaymentMode) {
            return res.status(400).json({ message: 'Payment mode is required' });
        }

        // Get a connection from the pool for transaction
        const connection = await db.getConnection();
        
        try {
            // Start transaction
            await connection.beginTransaction();

            // 0. Check account balance and get BankID before processing
            const [accountRows] = await connection.execute(
                'SELECT Balance, BankID FROM accounts WHERE ID = ? AND active = 1',
                [AccountID]
            );

            if (accountRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Account not found or inactive' });
            }

            const currentBalance = parseFloat(accountRows[0].Balance) || 0;
            const BankID = accountRows[0].BankID;

            if (currentBalance < Amount) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Insufficient balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${Amount.toFixed(2)}` 
                });
            }

            // 1. Get current depo balance and name from depo table
            const [depoRows] = await connection.execute(
                `SELECT Balance, name FROM depo WHERE id = ?`,
                [DepoID]
            );

            if (depoRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Depo not found' });
            }

            const currentDepoBalance = parseFloat(depoRows[0].Balance || 0);
            const newDepoBalance = currentDepoBalance + Amount;
            const depoName = depoRows[0].name || `Depo ${DepoID}`;

            // 1.5. Check remaining balance for this dealer - calculate from trip_depos
            const [remainingBalanceRows] = await connection.execute(
                `SELECT COALESCE(SUM(payable_amount - COALESCE(paid_amount, 0)), 0) as remaining_balance
                 FROM trip_depos
                 WHERE depo_id = ? 
                   AND Active = 1
                   AND (payable_amount - COALESCE(paid_amount, 0)) > 0`,
                [DepoID]
            );
            
            const remainingBalance = parseFloat(remainingBalanceRows[0]?.remaining_balance || 0);
            
            if (Amount > remainingBalance) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Payment amount exceeds remaining balance. Remaining balance: ${remainingBalance.toFixed(2)}, Required payment: ${Amount.toFixed(2)}` 
                });
            }

            // Update depo balance (once for the full amount)
            await connection.execute(
                `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                [newDepoBalance, DepoID]
            );

            // 2. Find trips for this depo that have remaining balance using trip_depos table - FIFO
            const [tripsWithBalance] = await connection.execute(
                `SELECT t.id, t.trip_no, t.start_date, td.id as trip_depo_id, td.payable_amount, td.paid_amount,
                 (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining
                 FROM trips t
                 INNER JOIN trip_depos td ON td.trip_id = t.id AND td.depo_id = ? AND td.Active = 1
                 WHERE t.status != 'Cancelled'
                 AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                 ORDER BY t.start_date ASC, t.id ASC`,
                [DepoID]
            );

            // 3. Apply payment to trips in order (oldest first) - create separate transaction, payment, and pool row for each trip
            let remainingPayment = Amount;
            const transactionPurpose = `Payment to ${depoName}`;
            const paymentIds = [];
            const transactionIds = [];
            
            // Get initial pool balance for calculating running balance
            const [initialPoolRows] = await connection.execute(
                `SELECT ID, DepoLimit FROM pool WHERE DepoID = ? AND active = 1 ORDER BY ID DESC LIMIT 1`,
                [DepoID]
            );
            let runningPoolBalance = initialPoolRows.length > 0 ? parseFloat(initialPoolRows[0].DepoLimit || 0) : currentDepoBalance;
            
            // Apply payment to trips in order (oldest first)
            for (const trip of tripsWithBalance) {
                if (remainingPayment <= 0) break;
                
                const payableAmount = parseFloat(trip.payable_amount) || 0;
                const currentPaid = parseFloat(trip.paid_amount) || 0;
                const remaining = parseFloat(trip.remaining) || 0;
                const tripDepoId = trip.trip_depo_id;
                
                // Calculate how much to apply to this trip_depo
                const paymentToApply = Math.min(remainingPayment, remaining);
                
                // Create a NEW transaction for this trip's payment portion
                const transactionQuery = `
                    INSERT INTO transactions (
                        AccountID, 
                        Purpose, 
                        Debit, 
                        Credit, 
                        Date, 
                        PaymentMode, 
                        ReferenceNo,
                        trip_id,
                        active
                    ) VALUES (?, ?, ?, 0, NOW(), ?, ?, ?, 1)
                `;
                
                const [transactionResult] = await connection.execute(transactionQuery, [
                    AccountID,
                    transactionPurpose,
                    paymentToApply,  // Debit = paymentToApply (money paid out from account for this trip)
                    PaymentMode,
                    ReferenceNo || null,
                    trip.id  // Trip ID for this specific trip
                ]);
                
                const transactionID = transactionResult.insertId;
                transactionIds.push(transactionID);

                // Create a NEW payment row for this trip
                const paymentQuery = `
                    INSERT INTO payments (
                        transactionID, 
                        DepoID,
                        trip_id,
                        Amount, 
                        Date, 
                        active
                    ) VALUES (?, ?, ?, ?, NOW(), 1)
                `;
                
                const [paymentResult] = await connection.execute(paymentQuery, [
                    transactionID,
                    DepoID,
                    trip.id,  // Trip ID for this specific trip
                    paymentToApply  // Amount applied to this trip
                ]);
                
                const paymentId = paymentResult.insertId;
                paymentIds.push(paymentId);

                // Create a NEW pool row for this trip
                runningPoolBalance += paymentToApply;  // Add credit to running balance
                const poolQuery = `
                    INSERT INTO pool (
                        DepoID, 
                        TripID,
                        Debit, 
                        Credit, 
                        DepoLimit,
                        payment_id,
                        recovery_id,
                        active
                    ) VALUES (?, ?, 0, ?, ?, ?, NULL, 1)
                `;
                
                await connection.execute(poolQuery, [
                    DepoID,
                    trip.id,  // Trip ID for this specific trip
                    paymentToApply,  // Credit = paymentToApply (money received into depo for this trip)
                    runningPoolBalance,  // New DepoLimit = Previous Pool Balance + Credit
                    paymentId  // Link to this trip's payment
                ]);

                // Update trip_depos.paid_amount
                const newPaidAmount = currentPaid + paymentToApply;
                await connection.execute(
                    `UPDATE trip_depos 
                     SET paid_amount = ?, MD = NOW()
                     WHERE id = ?`,
                    [newPaidAmount, tripDepoId]
                );
                
                // Update trips.paid (sum of all trip_depos.paid_amount for this trip)
                const [tripDeposSum] = await connection.execute(
                    `SELECT COALESCE(SUM(paid_amount), 0) as total_paid
                     FROM trip_depos
                     WHERE trip_id = ? AND Active = 1`,
                    [trip.id]
                );
                const totalPaidForTrip = parseFloat(tripDeposSum[0]?.total_paid || 0);
                
                await connection.execute(
                    `UPDATE trips 
                     SET paid = ?, MD = NOW()
                     WHERE id = ?`,
                    [totalPaidForTrip, trip.id]
                );
                
                // Check if trip should be closed (all payments cleared and all fuel sold)
                await checkAndCloseTrip(connection, trip.id);
                
                remainingPayment -= paymentToApply;
                
                console.log(`Created transaction ${transactionID}, payment ${paymentId}, and pool record for trip ${trip.id} (trip_depo ${tripDepoId}). Applied ${paymentToApply}, New paid_amount: ${newPaidAmount}, Pool balance: ${runningPoolBalance}, Remaining: ${payableAmount - newPaidAmount}`);
            }

            // 5. Update Accounts table - subtract amount from balance
            const updateAccountQuery = `
                UPDATE accounts 
                SET Balance = Balance - ?, 
                    MD = NOW()
                WHERE ID = ? AND active = 1
            `;
            
            const [updateResult] = await connection.execute(updateAccountQuery, [
                Amount,
                AccountID
            ]);

            if (updateResult.affectedRows === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Account not found or inactive' });
            }

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({
                message: 'Payment added successfully',
                transactionIDs: transactionIds,
                paymentIDs: paymentIds
            });
        } catch (err) {
            // Rollback on error
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error adding payment:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Get all transactions
exports.getTransactions = async (req, res) => {
    try {
        const query = `
            SELECT 
                t.ID,
                t.AccountID,
                t.Purpose,
                t.Debit,
                t.Credit,
                t.Date,
                t.PaymentMode,
                t.ReferenceNo,
                t.CD,
                t.MD,
                t.active,
                a.AccountNo,
                a.AccountTitle,
                b.Name as BankName
            FROM transactions t
            LEFT JOIN accounts a ON t.AccountID = a.ID
            LEFT JOIN bank b ON a.BankID = b.ID
            WHERE t.active = 1
            ORDER BY t.ID DESC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching transactions:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get transactions by AccountID
exports.getTransactionsByAccount = async (req, res) => {
    try {
        const accountId = req.query.accountId;
        const bankId = req.query.bankId; // Optional bankId for additional validation
        
        if (!accountId) {
            return res.status(400).json({ message: 'Account ID is required' });
        }

        let query = `
            SELECT 
                t.ID,
                t.AccountID,
                t.Purpose,
                t.Debit,
                t.Credit,
                t.Date,
                t.PaymentMode,
                t.ReferenceNo,
                t.CD,
                t.MD,
                t.active,
                a.AccountNo,
                a.AccountTitle,
                a.BankID,
                b.Name as BankName
            FROM transactions t
            INNER JOIN accounts a ON t.AccountID = a.ID
            LEFT JOIN bank b ON a.BankID = b.ID
            WHERE t.AccountID = ? AND t.active = 1 AND a.active = 1
        `;
        
        const params = [accountId];
        
        // If bankId is provided, ensure the account belongs to that bank
        if (bankId) {
            query += ` AND a.BankID = ?`;
            params.push(bankId);
        }
        
        query += ` ORDER BY t.ID DESC`;
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching transactions by account:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get all payments
exports.getPayments = async (req, res) => {
    try {
        const query = `
            SELECT 
                p.ID,
                p.transactionID,
                p.DepoID,
                p.Amount,
                p.Date,
                p.CD,
                p.MD,
                p.active,
                d.name as DepoName,
                t.PaymentMode,
                t.ReferenceNo,
                t.Purpose,
                t.AccountID,
                t.cash_in_hand_id,
                a.AccountNo,
                a.AccountTitle,
                CASE 
                    WHEN t.cash_in_hand_id IS NOT NULL THEN 'Cash in Hand'
                    WHEN t.AccountID IS NOT NULL THEN CONCAT('Bank Account - ', COALESCE(b.Name, ''), ' - ', COALESCE(a.AccountTitle, ''))
                    ELSE 'N/A'
                END as AccountHead
            FROM payments p
            INNER JOIN transactions t ON p.transactionID = t.ID
            INNER JOIN depo d ON p.DepoID = d.id
            LEFT JOIN accounts a ON t.AccountID = a.ID
            LEFT JOIN bank b ON a.BankID = b.ID
            WHERE p.active = 1
            ORDER BY p.ID DESC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching payments:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Add deposit or withdrawal transaction for an account
exports.addAccountTransaction = async (req, res) => {
    try {
        const {
            AccountID,
            TransactionType, // 'deposit' or 'withdrawal'
            Amount,
            Purpose,
            PaymentMode,
            ReferenceNo
        } = req.body;

        // Validation
        if (!AccountID) {
            return res.status(400).json({ message: 'Account ID is required' });
        }
        if (!TransactionType || !['deposit', 'withdrawal'].includes(TransactionType)) {
            return res.status(400).json({ message: 'Transaction type must be "deposit" or "withdrawal"' });
        }
        if (!Amount || Amount <= 0) {
            return res.status(400).json({ message: 'Amount is required and must be greater than 0' });
        }
        if (!Purpose) {
            return res.status(400).json({ message: 'Purpose is required' });
        }

        // Get a connection from the pool for transaction
        const connection = await db.getConnection();
        
        try {
            // Start transaction
            await connection.beginTransaction();

            // Get current account balance
            const [accountRows] = await connection.execute(
                'SELECT Balance FROM accounts WHERE ID = ? AND active = 1',
                [AccountID]
            );

            if (accountRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Account not found or inactive' });
            }

            const currentBalance = parseFloat(accountRows[0].Balance) || 0;
            let newBalance;
            let debit = 0;
            let credit = 0;

            if (TransactionType === 'deposit') {
                // Deposit increases balance - money received (Credit)
                debit = 0;
                credit = Amount;
                newBalance = currentBalance + Amount;
            } else {
                // Withdrawal decreases balance - money paid out (Debit)
                if (currentBalance < Amount) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ 
                        message: `Insufficient balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${Amount.toFixed(2)}` 
                    });
                }
                debit = Amount;
                credit = 0;
                newBalance = currentBalance - Amount;
            }

            // Insert into transactions table
            const transactionQuery = `
                INSERT INTO transactions (
                    AccountID, 
                    Purpose, 
                    Debit, 
                    Credit, 
                    Date, 
                    PaymentMode, 
                    ReferenceNo, 
                    active
                ) VALUES (?, ?, ?, ?, NOW(), ?, ?, 1)
            `;
            
            const [transactionResult] = await connection.execute(transactionQuery, [
                AccountID,
                Purpose,
                debit,
                credit,
                PaymentMode || null,
                ReferenceNo || null
            ]);
            
            const transactionID = transactionResult.insertId;

            // Update account balance
            await connection.execute(
                'UPDATE accounts SET Balance = ? WHERE ID = ?',
                [newBalance, AccountID]
            );

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({
                message: `${TransactionType === 'deposit' ? 'Deposit' : 'Withdrawal'} transaction added successfully`,
                transactionID: transactionID,
                newBalance: newBalance
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error adding account transaction:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message,
            sqlMessage: err.sqlMessage 
        });
    }
};

// Add cash in hand payment
exports.addCashInHandPayment = async (req, res) => {
    try {
        const {
            DepoID,
            Amount,
            TripID,
            TripNo
        } = req.body;

        // Validation
        if (!DepoID) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }
        if (!Amount || Amount <= 0) {
            return res.status(400).json({ message: 'Amount is required and must be greater than 0' });
        }

        // Get a connection from the pool for transaction
        const connection = await db.getConnection();
        
        try {
            // Start transaction
            await connection.beginTransaction();

            // 1. Check cash in hand balance from last active entry (more reliable than SUM)
            const [lastBalanceRows] = await connection.execute(
                `SELECT balance FROM cash_in_hand 
                 WHERE Active = 1 
                 ORDER BY created_at DESC, id DESC 
                 LIMIT 1`
            );
            const currentBalance = lastBalanceRows.length > 0 
                ? parseFloat(lastBalanceRows[0]?.balance || 0) 
                : 0;

            if (currentBalance < Amount) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Insufficient cash in hand balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${Amount.toFixed(2)}` 
                });
            }

            // 2. Get Depo Name and Balance
            const [depoRows] = await connection.execute(
                'SELECT name, Balance FROM depo WHERE id = ?',
                [DepoID]
            );
            
            if (depoRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Depo not found' });
            }
            
            const depoName = depoRows[0].name || `Depo ${DepoID}`;
            const currentDepoBalance = parseFloat(depoRows[0].Balance || 0);
            const newDepoBalance = currentDepoBalance + Amount;

            // 2.5. Check remaining balance for this dealer - calculate from trip_depos
            const [remainingBalanceRows] = await connection.execute(
                `SELECT COALESCE(SUM(payable_amount - COALESCE(paid_amount, 0)), 0) as remaining_balance
                 FROM trip_depos
                 WHERE depo_id = ? 
                   AND Active = 1
                   AND (payable_amount - COALESCE(paid_amount, 0)) > 0`,
                [DepoID]
            );
            
            const remainingBalance = parseFloat(remainingBalanceRows[0]?.remaining_balance || 0);
            
            if (Amount > remainingBalance) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Payment amount exceeds remaining balance. Remaining balance: ${remainingBalance.toFixed(2)}, Required payment: ${Amount.toFixed(2)}` 
                });
            }

            // 3. Get Trip No if TripID is provided
            let tripNo = TripNo || '';
            if (TripID && !tripNo) {
                const [tripRows] = await connection.execute(
                    'SELECT trip_no FROM trips WHERE id = ?',
                    [TripID]
                );
                if (tripRows.length > 0) {
                    tripNo = tripRows[0].trip_no || '';
                }
            }

            // 4. Calculate new balance
            // When paying FROM cash in hand, we use DEBIT (money going out)
            const newBalance = currentBalance - Amount; // Debit subtracts from balance
            
            // 5. Add debit entry to cash_in_hand (deducts from balance when paying out)
            const purpose = tripNo ? `Payment for ${tripNo}` : `Payment to ${depoName}`;
            const cashInHandQuery = `
                INSERT INTO cash_in_hand (
                    debit,
                    credit,
                    balance,
                    purpose,
                    created_at
                ) VALUES (?, 0, ?, ?, NOW())
            `;
            
            const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                Amount,  // Debit amount (subtracts from balance when paying out)
                newBalance,  // New running balance
                purpose
            ]);
            
            const cashInHandId = cashInHandResult.insertId;

            // 6. Find trips for this depo that have remaining balance using trip_depos table - FIFO
            const [tripsWithBalance] = await connection.execute(
                `SELECT t.id, t.trip_no, t.start_date, td.id as trip_depo_id, td.payable_amount, td.paid_amount,
                 (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining
                 FROM trips t
                 INNER JOIN trip_depos td ON td.trip_id = t.id AND td.depo_id = ? AND td.Active = 1
                 WHERE t.status != 'Cancelled'
                 AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                 ORDER BY t.start_date ASC, t.id ASC`,
                [DepoID]
            );

            // 7. Apply payment to trips in order (oldest first) - create separate transaction, payment, and pool row for each trip
            let remainingPayment = Amount;
            const transactionPurpose = tripNo ? `Payment for ${tripNo}` : `Payment to ${depoName}`;
            const paymentIds = [];
            const transactionIds = [];
            
            // Get initial pool balance for calculating running balance
            const [initialPoolRows] = await connection.execute(
                `SELECT ID, DepoLimit FROM pool WHERE DepoID = ? AND active = 1 ORDER BY ID DESC LIMIT 1`,
                [DepoID]
            );
            let runningPoolBalance = initialPoolRows.length > 0 ? parseFloat(initialPoolRows[0].DepoLimit || 0) : currentDepoBalance;
            
            // Apply payment to trips in order (oldest first)
            for (const trip of tripsWithBalance) {
                if (remainingPayment <= 0) break;
                
                const payableAmount = parseFloat(trip.payable_amount) || 0;
                const currentPaid = parseFloat(trip.paid_amount) || 0;
                const remaining = parseFloat(trip.remaining) || 0;
                const tripDepoId = trip.trip_depo_id;
                
                // Calculate how much to apply to this trip_depo
                const paymentToApply = Math.min(remainingPayment, remaining);
                
                // Create a NEW transaction for this trip's payment portion
                const transactionQuery = `
                    INSERT INTO transactions (
                        cash_in_hand_id,
                        Purpose,
                        Debit,
                        Credit,
                        Date,
                        PaymentMode,
                        trip_id,
                        active
                    ) VALUES (?, ?, ?, 0, NOW(), 'Cash', ?, 1)
                `;
                
                const [transactionResult] = await connection.execute(transactionQuery, [
                    cashInHandId,
                    transactionPurpose,
                    paymentToApply,  // Debit = paymentToApply (money paid out from cash in hand for this trip)
                    trip.id  // Trip ID for this specific trip
                ]);
                
                const transactionID = transactionResult.insertId;
                transactionIds.push(transactionID);

                // Create a NEW payment row for this trip
                const paymentQuery = `
                    INSERT INTO payments (
                        transactionID,
                        DepoID,
                        trip_id,
                        Amount,
                        Date,
                        active
                    ) VALUES (?, ?, ?, ?, NOW(), 1)
                `;
                
                const [paymentResult] = await connection.execute(paymentQuery, [
                    transactionID,
                    DepoID,
                    trip.id,  // Trip ID for this specific trip
                    paymentToApply  // Amount applied to this trip
                ]);
                
                const paymentId = paymentResult.insertId;
                paymentIds.push(paymentId);

                // Create a NEW pool row for this trip
                runningPoolBalance += paymentToApply;  // Add credit to running balance
                const poolQuery = `
                    INSERT INTO pool (
                        DepoID, 
                        TripID,
                        Debit, 
                        Credit, 
                        DepoLimit,
                        payment_id,
                        recovery_id,
                        active
                    ) VALUES (?, ?, 0, ?, ?, ?, NULL, 1)
                `;
                
                await connection.execute(poolQuery, [
                    DepoID,
                    trip.id,  // Trip ID for this specific trip
                    paymentToApply,  // Credit = paymentToApply (money received into depo for this trip)
                    runningPoolBalance,  // New DepoLimit = Previous Pool Balance + Credit
                    paymentId  // Link to this trip's payment
                ]);

                // Update trip_depos.paid_amount
                const newPaidAmount = currentPaid + paymentToApply;
                await connection.execute(
                    `UPDATE trip_depos 
                     SET paid_amount = ?, MD = NOW()
                     WHERE id = ?`,
                    [newPaidAmount, tripDepoId]
                );
                
                // Update trips.paid (sum of all trip_depos.paid_amount for this trip)
                const [tripDeposSum] = await connection.execute(
                    `SELECT COALESCE(SUM(paid_amount), 0) as total_paid
                     FROM trip_depos
                     WHERE trip_id = ? AND Active = 1`,
                    [trip.id]
                );
                const totalPaidForTrip = parseFloat(tripDeposSum[0]?.total_paid || 0);
                
                await connection.execute(
                    `UPDATE trips 
                     SET paid = ?, MD = NOW()
                     WHERE id = ?`,
                    [totalPaidForTrip, trip.id]
                );
                
                // Check if trip should be closed (all payments cleared and all fuel sold)
                await checkAndCloseTrip(connection, trip.id);
                
                remainingPayment -= paymentToApply;
                
                console.log(`Created transaction ${transactionID}, payment ${paymentId}, and pool record for trip ${trip.id} (trip_depo ${tripDepoId}). Applied ${paymentToApply}, New paid_amount: ${newPaidAmount}, Pool balance: ${runningPoolBalance}, Remaining: ${payableAmount - newPaidAmount}`);
            }

            // 8. Update depo balance (once for the full amount)
            await connection.execute(
                `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                [newDepoBalance, DepoID]
            );

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({
                message: 'Cash in hand payment added successfully',
                transactionIDs: transactionIds,
                paymentIDs: paymentIds,
                cashInHandId: cashInHandId
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error adding cash in hand payment:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message,
            sqlMessage: err.sqlMessage 
        });
    }
};

// Get trips with remaining balance for a specific depo
exports.getTripsWithRemaining = async (req, res) => {
    try {
        const { depoId } = req.query;

        if (!depoId) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        const connection = await db.getConnection();

        try {
            // Get trips with remaining balance for this depo
            const [trips] = await connection.execute(
                `SELECT t.id, t.trip_no, t.start_date, t.total_amount, t.paid,
                 td.payable_amount, td.paid_amount,
                 (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining
                 FROM trips t
                 INNER JOIN trip_depos td ON td.trip_id = t.id AND td.depo_id = ? AND td.Active = 1
                 WHERE t.status != 'Cancelled'
                 AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                 ORDER BY t.start_date ASC, t.id ASC`,
                [depoId]
            );

            connection.release();
            res.json(trips);
        } catch (err) {
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error getting trips with remaining:', error);
        res.status(500).json({ message: 'Error getting trips with remaining balance', error: error.message });
    }
};

