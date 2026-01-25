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
            const depoName = depoRows[0].name || `Depo ${DepoID}`;
            
            // Advance balance is stored in advance_balance table (latest Balance)
            const [advanceRows] = await connection.execute(
                `SELECT COALESCE(Balance, 0) as advance_balance
                 FROM advance_balance
                 WHERE DepoID = ? AND Active = 1
                 ORDER BY ID DESC
                 LIMIT 1`,
                [DepoID]
            );
            const currentAdvanceBalance = parseFloat(advanceRows[0]?.advance_balance || 0);

            // Get initial balance limit from pool table (first entry with NULL tripID, payment_id, recovery_id)
            const [initialBalanceRows] = await connection.execute(
                `SELECT Credit as initial_balance
                 FROM pool 
                 WHERE DepoID = ? 
                   AND TripID IS NULL 
                   AND payment_id IS NULL 
                   AND recovery_id IS NULL 
                   AND active = 1 
                 ORDER BY ID ASC 
                 LIMIT 1`,
                [DepoID]
            );
            
            const initialBalance = initialBalanceRows.length > 0 
                ? parseFloat(initialBalanceRows[0].initial_balance || 0) 
                : currentDepoBalance; // Fallback to current balance if no initial entry found
            
            console.log(`Depo ${DepoID} (${depoName}) initial balance limit: ${initialBalance}, current balance: ${currentDepoBalance}, current advance: ${currentAdvanceBalance}`);

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
            
            // Payment validation: Allow payment if remainingBalance = 0 (advance payment) or if Amount <= remainingBalance
            if (remainingBalance === 0) {
                // Advance payment: Add to advance_balance table instead of depo.advance_balance
                
                // Get current advance balance from advance_balance table
                const [lastAdvanceRows] = await connection.execute(
                    `SELECT Balance FROM advance_balance 
                     WHERE DepoID = ? AND Active = 1 
                     ORDER BY ID DESC LIMIT 1`,
                    [DepoID]
                );
                const currentAdvanceBalanceFromTable = lastAdvanceRows.length > 0 
                    ? parseFloat(lastAdvanceRows[0].Balance || 0) 
                    : 0;
                const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + Amount;
                
                // Create transaction for advance payment (no trip association)
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
                    ) VALUES (?, ?, ?, 0, NOW(), ?, ?, NULL, 1)
                `;
                
                const [transactionResult] = await connection.execute(transactionQuery, [
                    AccountID,
                    `Advance Payment to ${depoName}`,
                    Amount,
                    PaymentMode,
                    ReferenceNo || null
                ]);
                
                const transactionID = transactionResult.insertId;
                
                // Create payment record for advance payment
                const paymentQuery = `
                    INSERT INTO payments (
                        transactionID, 
                        DepoID,
                        trip_id,
                        Amount, 
                        Date, 
                        active
                    ) VALUES (?, ?, NULL, ?, NOW(), 1)
                `;
                
                const [paymentResult] = await connection.execute(paymentQuery, [
                    transactionID,
                    DepoID,
                    Amount
                ]);
                
                const paymentID = paymentResult.insertId;
                
                // Update Accounts table - subtract amount from balance
                const updateAccountQuery = `
                    UPDATE accounts 
                    SET Balance = Balance - ?, 
                        MD = NOW()
                    WHERE ID = ? AND active = 1
                `;
                
                await connection.execute(updateAccountQuery, [Amount, AccountID]);
                
                // Insert Credit entry to advance_balance table
                await connection.execute(
                    `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                    [DepoID, paymentID, Amount, newAdvanceBalanceInTable, 'admin@gmail.com']
                );
                console.log(`Added advance_balance entry for advance payment: Credit=${Amount}, New Balance=${newAdvanceBalanceInTable}`);
                
                await connection.commit();
                connection.release();
                
                return res.json({
                    message: 'Advance payment added successfully',
                    transactionID: transactionID,
                    paymentID: paymentResult.insertId,
                    advanceBalance: newAdvanceBalanceInTable
                });
            } else if (Amount > remainingBalance) {
                // Payment exceeds remaining balance
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Payment amount exceeds remaining balance. Remaining balance: ${remainingBalance.toFixed(2)}, Required payment: ${Amount.toFixed(2)}` 
                });
            }
            
            // Normal payment flow: remainingBalance > 0 and Amount <= remainingBalance
            // Calculate how much can be added to Balance (up to initial limit) and how much to advance_balance
            const balanceSpaceAvailable = Math.max(0, initialBalance - currentDepoBalance);
            const amountToBalance = Math.min(Amount, balanceSpaceAvailable);
            const amountToAdvanceBalance = Amount - amountToBalance;
            
            const newDepoBalance = currentDepoBalance + amountToBalance;
            const newAdvanceBalance = currentAdvanceBalance + amountToAdvanceBalance;

            // Update depo balance (only the Balance column, not advance_balance)
            await connection.execute(
                `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                [newDepoBalance, DepoID]
            );
            console.log(`Updated depo ${DepoID}: Balance=${newDepoBalance} (added ${amountToBalance})`);

            // Add advance_balance table entry if there's excess payment (Credit entry)
            if (amountToAdvanceBalance > 0) {
                // Get current advance balance from advance_balance table
                const [lastAdvanceRows] = await connection.execute(
                    `SELECT Balance FROM advance_balance 
                     WHERE DepoID = ? AND Active = 1 
                     ORDER BY ID DESC LIMIT 1`,
                    [DepoID]
                );
                const currentAdvanceBalanceFromTable = lastAdvanceRows.length > 0 
                    ? parseFloat(lastAdvanceRows[0].Balance || 0) 
                    : 0;
                const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + amountToAdvanceBalance;
                
                // Insert Credit entry to advance_balance table
                await connection.execute(
                    `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                    [DepoID, amountToAdvanceBalance, newAdvanceBalanceInTable, 'admin@gmail.com']
                );
                console.log(`Added advance_balance entry: Credit=${amountToAdvanceBalance}, New Balance=${newAdvanceBalanceInTable}`);
            }

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
            AccountID, // Current account (destination for deposit, source for withdrawal)
            TransactionType, // 'deposit' or 'withdrawal'
            Amount,
            Purpose,
            PaymentMode,
            ReferenceNo,
            Source, // 'bank', 'cash_in_hand', or 'current_bank_account'
            Destination, // 'bank', 'cash_in_hand', or 'current_bank_account'
            SourceBankID,
            SourceAccountID,
            DestinationBankID,
            DestinationAccountID
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

            // Get current account (destination for deposit, source for withdrawal)
            const [accountRows] = await connection.execute(
                'SELECT Balance, AccountTitle, AccountNo FROM accounts WHERE ID = ? AND active = 1',
                [AccountID]
            );

            if (accountRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Account not found or inactive' });
            }

            const currentAccountBalance = parseFloat(accountRows[0].Balance) || 0;
            const currentAccountTitle = accountRows[0].AccountTitle || '';
            const currentAccountNo = accountRows[0].AccountNo || '';
            let cashInHandId = null;
            let sourceTransactionID = null;
            let destinationTransactionID = null;

            if (TransactionType === 'deposit') {
                // DEPOSIT: Money coming INTO current account
                // Current account is credited (balance increases)
                
                // Check if source account has sufficient balance
                if (Source === 'cash_in_hand') {
                    // Source: Cash in Hand -> Destination: Current Bank Account
                    // 1. Debit cash_in_hand (money going out)
                    const [cashBalanceRows] = await connection.execute(`
                        SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
                        FROM cash_in_hand
                        WHERE Active = 1
                    `);
                    const currentCashBalance = parseFloat(cashBalanceRows[0]?.balance || 0);
                    
                    if (currentCashBalance < Amount) {
                        await connection.rollback();
                        connection.release();
                        return res.status(400).json({ 
                            message: `Insufficient cash in hand balance. Available balance: ${currentCashBalance.toFixed(2)}, Required: ${Amount.toFixed(2)}` 
                        });
                    }

                    const newCashBalance = currentCashBalance - Amount;
                    const cashPurpose = `Deposit to ${currentAccountTitle} (${currentAccountNo}) - ${Purpose}`;
                    const cashInHandQuery = `
                        INSERT INTO cash_in_hand (
                            debit,
                            credit,
                            balance,
                            purpose,
                            created_at,
                            Active
                        ) VALUES (?, 0, ?, ?, NOW(), 1)
                    `;
                    
                    const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                        Amount,
                        newCashBalance,
                        cashPurpose
                    ]);
                    cashInHandId = cashInHandResult.insertId;

                    // 2. Credit current account (create transaction record)
                    const newAccountBalance = currentAccountBalance + Amount;
                    const transactionQuery = `
                        INSERT INTO transactions (
                            AccountID, 
                            cash_in_hand_id,
                            Purpose, 
                            Debit, 
                            Credit, 
                            Date, 
                            PaymentMode, 
                            ReferenceNo, 
                            active
                        ) VALUES (?, ?, ?, 0, ?, NOW(), ?, ?, 1)
                    `;
                    
                    const transactionPurpose = `Deposit from Cash in Hand - ${Purpose}`;
                    const [transactionResult] = await connection.execute(transactionQuery, [
                        AccountID,
                        cashInHandId,
                        transactionPurpose,
                        Amount,
                        PaymentMode || null,
                        ReferenceNo || null
                    ]);
                    destinationTransactionID = transactionResult.insertId;

                    // 3. Update current account balance
                    await connection.execute(
                        'UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ?',
                        [newAccountBalance, AccountID]
                    );

                } else if (Source === 'bank' && SourceAccountID) {
                    // Source: Another Bank Account -> Destination: Current Bank Account
                    // 1. Get source account details
                    const [sourceAccountRows] = await connection.execute(
                        'SELECT Balance, AccountTitle, AccountNo FROM accounts WHERE ID = ? AND active = 1',
                        [SourceAccountID]
                    );

                    if (sourceAccountRows.length === 0) {
                        await connection.rollback();
                        connection.release();
                        return res.status(404).json({ message: 'Source account not found or inactive' });
                    }

                    const sourceAccountBalance = parseFloat(sourceAccountRows[0].Balance) || 0;
                    const sourceAccountTitle = sourceAccountRows[0].AccountTitle || '';
                    const sourceAccountNo = sourceAccountRows[0].AccountNo || '';

                    if (sourceAccountBalance < Amount) {
                        await connection.rollback();
                        connection.release();
                        return res.status(400).json({ 
                            message: `Insufficient balance in source account. Available balance: ${sourceAccountBalance.toFixed(2)}, Required: ${Amount.toFixed(2)}` 
                        });
                    }

                    // 2. Debit source account (create transaction record)
                    const newSourceBalance = sourceAccountBalance - Amount;
                    const sourceTransactionQuery = `
                        INSERT INTO transactions (
                            AccountID, 
                            Purpose, 
                            Debit, 
                            Credit, 
                            Date, 
                            PaymentMode, 
                            ReferenceNo, 
                            active
                        ) VALUES (?, ?, ?, 0, NOW(), ?, ?, 1)
                    `;
                    
                    const sourcePurpose = `Transfer to ${currentAccountTitle} (${currentAccountNo}) - ${Purpose}`;
                    const [sourceTransactionResult] = await connection.execute(sourceTransactionQuery, [
                        SourceAccountID,
                        sourcePurpose,
                        Amount,
                        PaymentMode || null,
                        ReferenceNo || null
                    ]);
                    sourceTransactionID = sourceTransactionResult.insertId;

                    // 3. Update source account balance
                    await connection.execute(
                        'UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ?',
                        [newSourceBalance, SourceAccountID]
                    );

                    // 4. Credit current account (create transaction record)
                    const newAccountBalance = currentAccountBalance + Amount;
                    const destinationTransactionQuery = `
                        INSERT INTO transactions (
                            AccountID, 
                            Purpose, 
                            Debit, 
                            Credit, 
                            Date, 
                            PaymentMode, 
                            ReferenceNo, 
                            active
                        ) VALUES (?, ?, 0, ?, NOW(), ?, ?, 1)
                    `;
                    
                    const destinationPurpose = `Transfer from ${sourceAccountTitle} (${sourceAccountNo}) - ${Purpose}`;
                    const [destinationTransactionResult] = await connection.execute(destinationTransactionQuery, [
                        AccountID,
                        destinationPurpose,
                        Amount,
                        PaymentMode || null,
                        ReferenceNo || null
                    ]);
                    destinationTransactionID = destinationTransactionResult.insertId;

                    // 5. Update current account balance
                    await connection.execute(
                        'UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ?',
                        [newAccountBalance, AccountID]
                    );
                }

            } else {
                // WITHDRAWAL: Money going OUT OF current account
                // Current account is debited (balance decreases)
                
                if (currentAccountBalance < Amount) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ 
                        message: `Insufficient balance. Available balance: ${currentAccountBalance.toFixed(2)}, Required: ${Amount.toFixed(2)}` 
                    });
                }

                if (Destination === 'cash_in_hand') {
                    // Source: Current Bank Account -> Destination: Cash in Hand
                    // 1. Debit current account (create transaction record)
                    const newAccountBalance = currentAccountBalance - Amount;
                    const transactionQuery = `
                        INSERT INTO transactions (
                            AccountID, 
                            cash_in_hand_id,
                            Purpose, 
                            Debit, 
                            Credit, 
                            Date, 
                            PaymentMode, 
                            ReferenceNo, 
                            active
                        ) VALUES (?, ?, ?, ?, 0, NOW(), ?, ?, 1)
                    `;
                    
                    const transactionPurpose = `Withdrawal to Cash in Hand - ${Purpose}`;
                    const [transactionResult] = await connection.execute(transactionQuery, [
                        AccountID,
                        null, // Will be set after cash_in_hand entry is created
                        transactionPurpose,
                        Amount, // Debit amount
                        PaymentMode || null,
                        ReferenceNo || null
                    ]);
                    sourceTransactionID = transactionResult.insertId;

                    // 2. Update current account balance
                    await connection.execute(
                        'UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ?',
                        [newAccountBalance, AccountID]
                    );

                    // 3. Credit cash_in_hand (money coming in)
                    const [cashBalanceRows] = await connection.execute(`
                        SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
                        FROM cash_in_hand
                        WHERE Active = 1
                    `);
                    const currentCashBalance = parseFloat(cashBalanceRows[0]?.balance || 0);
                    const newCashBalance = currentCashBalance + Amount;

                    const cashPurpose = `Withdrawal from ${currentAccountTitle} (${currentAccountNo}) - ${Purpose}`;
                    const cashInHandQuery = `
                        INSERT INTO cash_in_hand (
                            debit,
                            credit,
                            balance,
                            purpose,
                            created_at,
                            Active
                        ) VALUES (0, ?, ?, ?, NOW(), 1)
                    `;
                    
                    const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                        Amount,
                        newCashBalance,
                        cashPurpose
                    ]);
                    cashInHandId = cashInHandResult.insertId;

                    // 4. Update transaction with cash_in_hand_id
                    await connection.execute(
                        'UPDATE transactions SET cash_in_hand_id = ? WHERE ID = ?',
                        [cashInHandId, sourceTransactionID]
                    );

                } else if (Destination === 'bank' && DestinationAccountID) {
                    // Source: Current Bank Account -> Destination: Another Bank Account
                    // 1. Get destination account details
                    const [destAccountRows] = await connection.execute(
                        'SELECT Balance, AccountTitle, AccountNo FROM accounts WHERE ID = ? AND active = 1',
                        [DestinationAccountID]
                    );

                    if (destAccountRows.length === 0) {
                        await connection.rollback();
                        connection.release();
                        return res.status(404).json({ message: 'Destination account not found or inactive' });
                    }

                    const destAccountBalance = parseFloat(destAccountRows[0].Balance) || 0;
                    const destAccountTitle = destAccountRows[0].AccountTitle || '';
                    const destAccountNo = destAccountRows[0].AccountNo || '';

                    // 2. Debit current account (create transaction record)
                    const newAccountBalance = currentAccountBalance - Amount;
                    const sourceTransactionQuery = `
                        INSERT INTO transactions (
                            AccountID, 
                            Purpose, 
                            Debit, 
                            Credit, 
                            Date, 
                            PaymentMode, 
                            ReferenceNo, 
                            active
                        ) VALUES (?, ?, ?, 0, NOW(), ?, ?, 1)
                    `;
                    
                    const sourcePurpose = `Transfer to ${destAccountTitle} (${destAccountNo}) - ${Purpose}`;
                    const [sourceTransactionResult] = await connection.execute(sourceTransactionQuery, [
                        AccountID,
                        sourcePurpose,
                        Amount,
                        PaymentMode || null,
                        ReferenceNo || null
                    ]);
                    sourceTransactionID = sourceTransactionResult.insertId;

                    // 3. Update current account balance
                    await connection.execute(
                        'UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ?',
                        [newAccountBalance, AccountID]
                    );

                    // 4. Credit destination account (create transaction record)
                    const newDestBalance = destAccountBalance + Amount;
                    const destinationTransactionQuery = `
                        INSERT INTO transactions (
                            AccountID, 
                            Purpose, 
                            Debit, 
                            Credit, 
                            Date, 
                            PaymentMode, 
                            ReferenceNo, 
                            active
                        ) VALUES (?, ?, 0, ?, NOW(), ?, ?, 1)
                    `;
                    
                    const destinationPurpose = `Transfer from ${currentAccountTitle} (${currentAccountNo}) - ${Purpose}`;
                    const [destinationTransactionResult] = await connection.execute(destinationTransactionQuery, [
                        DestinationAccountID,
                        destinationPurpose,
                        Amount,
                        PaymentMode || null,
                        ReferenceNo || null
                    ]);
                    destinationTransactionID = destinationTransactionResult.insertId;

                    // 5. Update destination account balance
                    await connection.execute(
                        'UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ?',
                        [newDestBalance, DestinationAccountID]
                    );
                }
            }

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({
                message: `${TransactionType === 'deposit' ? 'Deposit' : 'Withdrawal'} transaction added successfully`,
                sourceTransactionID: sourceTransactionID,
                destinationTransactionID: destinationTransactionID,
                cashInHandId: cashInHandId
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

            // 2. Get Depo Name, Balance and advance balance (advance is stored in advance_balance table)
            const [depoRows] = await connection.execute(
                `SELECT 
                    d.name, 
                    d.Balance,
                    (
                        SELECT COALESCE(ab.Balance, 0)
                        FROM advance_balance ab
                        WHERE ab.DepoID = d.id AND ab.Active = 1
                        ORDER BY ab.ID DESC
                        LIMIT 1
                    ) as advance_balance
                 FROM depo d
                 WHERE d.id = ?`,
                [DepoID]
            );
            
            if (depoRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Depo not found' });
            }
            
            const depoName = depoRows[0].name || `Depo ${DepoID}`;
            const currentDepoBalance = parseFloat(depoRows[0].Balance || 0);
            const currentAdvanceBalance = parseFloat(depoRows[0].advance_balance || 0);

            // Get initial balance limit from pool table (first entry with NULL tripID, payment_id, recovery_id)
            const [initialBalanceRows] = await connection.execute(
                `SELECT Credit as initial_balance
                 FROM pool 
                 WHERE DepoID = ? 
                   AND TripID IS NULL 
                   AND payment_id IS NULL 
                   AND recovery_id IS NULL 
                   AND active = 1 
                 ORDER BY ID ASC 
                 LIMIT 1`,
                [DepoID]
            );
            
            const initialBalance = initialBalanceRows.length > 0 
                ? parseFloat(initialBalanceRows[0].initial_balance || 0) 
                : currentDepoBalance; // Fallback to current balance if no initial entry found
            
            console.log(`[Cash Payment] Depo ${DepoID} (${depoName}) initial balance limit: ${initialBalance}, current balance: ${currentDepoBalance}, current advance: ${currentAdvanceBalance}`);

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
            
            // Payment validation: Allow payment if remainingBalance = 0 (advance payment) or if Amount <= remainingBalance
            if (remainingBalance === 0) {
                // Advance payment: Add to advance_balance table instead of depo.advance_balance
                
                // Get current advance balance from advance_balance table
                const [lastAdvanceRows] = await connection.execute(
                    `SELECT Balance FROM advance_balance 
                     WHERE DepoID = ? AND Active = 1 
                     ORDER BY ID DESC LIMIT 1`,
                    [DepoID]
                );
                const currentAdvanceBalanceFromTable = lastAdvanceRows.length > 0 
                    ? parseFloat(lastAdvanceRows[0].Balance || 0) 
                    : 0;
                const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + Amount;
                
                // Create cash_in_hand entry (debit - money going out)
                const [lastBalanceRows2] = await connection.execute(
                    `SELECT balance FROM cash_in_hand 
                     WHERE Active = 1 
                     ORDER BY created_at DESC, id DESC 
                     LIMIT 1`
                );
                const currentCashBalance = lastBalanceRows2.length > 0 
                    ? parseFloat(lastBalanceRows2[0]?.balance || 0) 
                    : 0;
                const newCashBalance = currentCashBalance - Amount;
                
                const [cashInHandResult] = await connection.execute(
                    `INSERT INTO cash_in_hand (debit, credit, balance, purpose, created_at, active)
                     VALUES (?, 0, ?, ?, NOW(), 1)`,
                    [Amount, newCashBalance, `Advance Payment to ${depoName}`]
                );
                
                const cashInHandId = cashInHandResult.insertId;
                
                // Create transaction for advance payment
                const transactionQuery = `
                    INSERT INTO transactions (
                        cash_in_hand_id,
                        Purpose, 
                        Debit, 
                        Credit, 
                        Date, 
                        active
                    ) VALUES (?, ?, ?, 0, NOW(), 1)
                `;
                
                const [transactionResult] = await connection.execute(transactionQuery, [
                    cashInHandId,
                    `Advance Payment to ${depoName}`,
                    Amount
                ]);
                
                const transactionID = transactionResult.insertId;
                
                // Create payment record for advance payment
                const paymentQuery = `
                    INSERT INTO payments (
                        transactionID, 
                        DepoID,
                        trip_id,
                        Amount, 
                        Date, 
                        active
                    ) VALUES (?, ?, NULL, ?, NOW(), 1)
                `;
                
                const [paymentResult] = await connection.execute(paymentQuery, [
                    transactionID,
                    DepoID,
                    Amount
                ]);
                
                const paymentID = paymentResult.insertId;
                
                // Insert Credit entry to advance_balance table
                await connection.execute(
                    `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                    [DepoID, paymentID, Amount, newAdvanceBalanceInTable, 'admin@gmail.com']
                );
                console.log(`Added advance_balance entry for advance payment: Credit=${Amount}, New Balance=${newAdvanceBalanceInTable}`);
                
                await connection.commit();
                connection.release();
                
                return res.json({
                    message: 'Advance payment added successfully',
                    transactionID: transactionID,
                    paymentID: paymentResult.insertId,
                    cashInHandId: cashInHandId,
                    advanceBalance: newAdvanceBalanceInTable
                });
            } else if (Amount > remainingBalance) {
                // Payment exceeds remaining balance
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Payment amount exceeds remaining balance. Remaining balance: ${remainingBalance.toFixed(2)}, Required payment: ${Amount.toFixed(2)}` 
                });
            }
            
            // Normal payment flow: remainingBalance > 0 and Amount <= remainingBalance
            // Calculate how much can be added to Balance (up to initial limit) and how much to advance_balance
            const balanceSpaceAvailable = Math.max(0, initialBalance - currentDepoBalance);
            const amountToBalance = Math.min(Amount, balanceSpaceAvailable);
            const amountToAdvanceBalance = Amount - amountToBalance;
            
            const newDepoBalance = currentDepoBalance + amountToBalance;
            const newAdvanceBalance = currentAdvanceBalance + amountToAdvanceBalance;
            
            console.log(`[Cash Payment] Will add ${amountToBalance} to Balance (space available: ${balanceSpaceAvailable}), ${amountToAdvanceBalance} to advance_balance`);

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

            // 8. Update depo balance (only Balance column, not advance_balance)
            await connection.execute(
                `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                [newDepoBalance, DepoID]
            );
            console.log(`Updated depo ${DepoID}: Balance=${newDepoBalance} (added ${amountToBalance})`);

            // Add advance_balance table entry if there's excess payment (Credit entry)
            if (amountToAdvanceBalance > 0) {
                // Get current advance balance from advance_balance table
                const [lastAdvanceRows] = await connection.execute(
                    `SELECT Balance FROM advance_balance 
                     WHERE DepoID = ? AND Active = 1 
                     ORDER BY ID DESC LIMIT 1`,
                    [DepoID]
                );
                const currentAdvanceBalanceFromTable = lastAdvanceRows.length > 0 
                    ? parseFloat(lastAdvanceRows[0].Balance || 0) 
                    : 0;
                const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + amountToAdvanceBalance;
                
                // Insert Credit entry to advance_balance table
                await connection.execute(
                    `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                    [DepoID, amountToAdvanceBalance, newAdvanceBalanceInTable, 'admin@gmail.com']
                );
                console.log(`Added advance_balance entry: Credit=${amountToAdvanceBalance}, New Balance=${newAdvanceBalanceInTable}`);
            }

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

