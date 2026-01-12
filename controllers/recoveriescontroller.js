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

// Helper function to recalculate all balances in cash_in_hand table
async function recalculateAllBalances(connection) {
    try {
        // Get all records ordered by created_at and id where Active = 1
        const [allRecords] = await connection.execute(`
            SELECT id, debit, credit
            FROM cash_in_hand
            WHERE Active = 1
            ORDER BY created_at ASC, id ASC
        `);
        
        let runningBalance = 0;
        
        // Update each record with its running balance
        // Credit adds to balance, Debit subtracts from balance
        for (const record of allRecords) {
            runningBalance += (record.credit || 0) - (record.debit || 0);
            
            await connection.execute(`
                UPDATE cash_in_hand
                SET balance = ?
                WHERE id = ?
            `, [runningBalance, record.id]);
        }
    } catch (err) {
        console.error('Error recalculating balances:', err);
        throw err;
    }
}

// Helper function to recalculate pool balances for a depo starting from a specific row ID
// If startFromRowId is provided, recalculate from the row before it forward
async function recalculatePoolBalancesFromRow(connection, depoId, startFromRowId = null) {
    try {
        // Get initial balance (where TripID IS NULL, payment_id IS NULL, recovery_id IS NULL, active = 1)
        const [initialBalanceRows] = await connection.execute(
            `SELECT ID, DepoLimit FROM pool 
             WHERE DepoID = ? AND TripID IS NULL AND payment_id IS NULL AND recovery_id IS NULL AND active = 1 
             ORDER BY ID ASC LIMIT 1`,
            [depoId]
        );

        if (initialBalanceRows.length === 0) {
            console.log(`No initial balance row found for depo ${depoId}`);
            return null;
        }

        const initialBalance = parseFloat(initialBalanceRows[0].DepoLimit || 0);
        const initialBalanceRowId = initialBalanceRows[0].ID;

        let currentBalance = initialBalance;
        let poolRows;

        if (startFromRowId) {
            // Find the row immediately before startFromRowId to get the previous balance
            const [previousRow] = await connection.execute(
                `SELECT DepoLimit FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID < ?
                 ORDER BY ID DESC LIMIT 1`,
                [depoId, startFromRowId]
            );
            if (previousRow.length > 0) {
                currentBalance = parseFloat(previousRow[0].DepoLimit || 0);
            }
            
            // Get all rows from startFromRowId onwards (active = 1)
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit 
                 FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID >= ?
                 ORDER BY ID ASC`,
                [depoId, startFromRowId]
            );
        } else {
            // Get all rows except initial balance row (active = 1)
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit 
                 FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID != ?
                 ORDER BY ID ASC`,
                [depoId, initialBalanceRowId]
            );
        }

        // Recalculate DepoLimit for all rows
        // Formula: New DepoLimit = Previous DepoLimit - Debit + Credit
        for (const row of poolRows) {
            const debit = parseFloat(row.Debit) || 0;
            const credit = parseFloat(row.Credit) || 0;
            
            // Calculate new balance: previous balance - debit + credit
            currentBalance = currentBalance - debit + credit;
            
            // Update this row's DepoLimit
            await connection.execute(
                `UPDATE pool SET DepoLimit = ? WHERE ID = ?`,
                [currentBalance, row.ID]
            );
            
            console.log(`Recalculated pool row ${row.ID}: New DepoLimit=${currentBalance} (Debit=${debit}, Credit=${credit})`);
        }

        // Return the final balance for depo table update
        const finalBalance = poolRows.length > 0 ? currentBalance : initialBalance;
        return finalBalance;
    } catch (err) {
        console.error('Error recalculating pool balances:', err);
        throw err;
    }
}

// Get all recoveries
exports.getRecoveries = async (req, res) => {
    try {
        const query = `
            SELECT 
                r.ID,
                r.transactionID,
                r.ClientID,
                r.Amount,
                r.Date,
                r.CD,
                r.MD,
                r.Active,
                r.Payment_Head,
                c.name as customer_name,
                t.cash_in_hand_id,
                t.AccountID,
                a.AccountTitle,
                b.Name as BankName,
                s.depo_id,
                d.name as DepoName
            FROM recoveries r
            LEFT JOIN customers c ON r.ClientID = c.id AND c.active = 1
            LEFT JOIN transactions t ON r.transactionID = t.ID AND t.active = 1
            LEFT JOIN accounts a ON t.AccountID = a.ID AND a.active = 1
            LEFT JOIN bank b ON a.BankID = b.ID
            LEFT JOIN settlements s ON r.ID = s.recovery_id AND s.Active = 1
            LEFT JOIN depo d ON s.depo_id = d.id
            WHERE r.Active = 1
            ORDER BY r.Date DESC, r.ID DESC
        `;
        const [rows] = await db.execute(query);
        
        // Format the received_in field based on payment method
        const formattedRows = rows.map(row => {
            let receivedIn = 'N/A';
            
            if (!row.transactionID) {
                // No transaction means it's a depo payment
                if (row.DepoName) {
                    receivedIn = `To Depo - ${row.DepoName}`;
                } else {
                    receivedIn = 'To Depo';
                }
            } else if (row.cash_in_hand_id) {
                // Cash in hand payment
                receivedIn = 'To Cash in Hand';
            } else if (row.AccountID && row.AccountTitle && row.BankName) {
                // Account payment with account name and bank name
                receivedIn = `${row.AccountTitle} - ${row.BankName}`;
            } else if (row.AccountID && row.AccountTitle) {
                // Account payment with account name only
                receivedIn = row.AccountTitle;
            } else if (row.AccountID && row.BankName) {
                // Account payment with bank name only
                receivedIn = `Account - ${row.BankName}`;
            } else if (row.AccountID) {
                // Account payment without account or bank name
                receivedIn = 'To Account';
            }
            
            return {
                ...row,
                received_in: receivedIn
            };
        });
        
        res.json(formattedRows);
    } catch (err) {
        console.error('Error fetching recoveries:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single recovery by ID
exports.getRecovery = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Recovery ID is required' });
        }

        const query = `
            SELECT 
                r.*,
                c.name as customer_name
            FROM recoveries r
            LEFT JOIN customers c ON r.ClientID = c.id AND c.active = 1
            WHERE r.ID = ? AND r.Active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Recovery not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching recovery:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add recovery
exports.addRecovery = async (req, res) => {
    try {
        const {
            ClientID,
            Amount,
            Date: recoveryDate,
            payment_method,
            payment_head,
            AccountID,
            DepoID,
            PaymentMode,
            ReferenceNo
        } = req.body;
        
        // Variable to track pool entry ID for recovery_id update (for depo payments)
        let poolEntryId = null;

        // Validation
        if (!ClientID) {
            return res.status(400).json({ message: 'Client ID is required' });
        }
        if (!Amount || Amount <= 0) {
            return res.status(400).json({ message: 'Amount is required and must be greater than 0' });
        }
        if (!recoveryDate) {
            return res.status(400).json({ message: 'Date is required' });
        }
        if (!payment_method) {
            return res.status(400).json({ message: 'Payment method is required' });
        }

        // Get connection for transaction
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            let transactionID = null;
            let settlementId = null;

            // Find trips for this client with remaining balance (FIFO) - BEFORE any payment processing
            // This is done for ALL payment methods to get trip_id for transaction and recovery records
            const [clientTripsWithBalance] = await connection.execute(
                `SELECT t.id, t.amount_collected, t.total_amount,
                 (COALESCE(t.total_amount, 0) - COALESCE(t.amount_collected, 0)) as remaining
                 FROM trips t
                 INNER JOIN pol_sale ps ON t.id = ps.trip_id AND ps.Active = 1
                 WHERE ps.client_id = ?
                 AND t.status != 'Cancelled'
                 AND t.active = 1
                 AND (COALESCE(t.total_amount, 0) - COALESCE(t.amount_collected, 0)) > 0
                 ORDER BY t.start_date ASC, t.id ASC`,
                [ClientID]
            );

            // Get TripID from oldest trip with remaining balance (FIFO)
            let tripIdForTransaction = null;
            if (clientTripsWithBalance.length > 0) {
                tripIdForTransaction = clientTripsWithBalance[0].id;
            }

            // Handle different payment methods
            if (payment_method === 'account') {
                // Own Account payment - debit the account
                if (!AccountID) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ message: 'Account ID is required for account payment' });
                }

                // 1. Check account balance
                const [accountRows] = await connection.execute(
                    'SELECT Balance, BankID FROM accounts WHERE ID = ? AND active = 1',
                    [AccountID]
                );

                if (accountRows.length === 0) {
                    await connection.rollback();
                    connection.release();
                    return res.status(404).json({ message: 'Account not found or inactive' });
                }

                // 2. Get BankID from account
                const bankID = accountRows[0].BankID;
                
                // 3. Insert into transactions table with all required fields and trip_id
                // When receiving money TO account, it should be Credit (money coming in)
                const customerName = await getCustomerName(connection, ClientID);
                const purpose = `Payment Received from ${customerName}`;
                
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
                        CD,
                        MD,
                        active
                    ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                `;
                
                const [transactionResult] = await connection.execute(transactionQuery, [
                    AccountID,
                    purpose,
                    Amount,  // Credit = Amount (money received, increases account balance)
                    recoveryDate,
                    PaymentMode || null,
                    ReferenceNo || null,
                    tripIdForTransaction  // Trip ID from FIFO (oldest trip with remaining balance)
                ]);
                
                transactionID = transactionResult.insertId;

                // 4. Update Accounts table - add amount to balance (credit increases balance)
                const updateAccountQuery = `
                    UPDATE accounts 
                    SET Balance = Balance + ?, 
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

            } else if (payment_method === 'depo') {
                // Depo payment - Insert into settlements table, debit pool, update trips
                if (!DepoID) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ message: 'Depo ID is required for depo payment' });
                }

                // 1. Insert into settlements table (recovery_id will be updated after recovery insertion)
                const settlementQuery = `
                    INSERT INTO settlements (
                        client_id,
                        depo_id,
                        amount,
                        settlement_type,
                        reference_no,
                        settlement_date,
                        recovery_id,
                        CD,
                        MD,
                        Active
                    ) VALUES (?, ?, ?, 'DIRECT_CLIENT_TO_CONTRACTOR', ?, ?, NULL, NOW(), NOW(), 1)
                `;
                
                const [settlementResult] = await connection.execute(settlementQuery, [
                    ClientID,
                    DepoID,
                    Amount,
                    ReferenceNo || null,
                    recoveryDate
                ]);
                
                settlementId = settlementResult.insertId;

                // 2. Verify depo exists
                const [depoRows] = await connection.execute(
                    `SELECT id FROM depo WHERE id = ? AND active = 1`,
                    [DepoID]
                );

                if (depoRows.length === 0) {
                    await connection.rollback();
                    connection.release();
                    return res.status(404).json({ message: 'Depo not found' });
                }

                // 3. Get current DepoLimit from pool table (latest entry for this depo)
                // This is the actual running balance, not the depo.Balance column
                const [currentPoolRows] = await connection.execute(
                    `SELECT DepoLimit 
                     FROM pool 
                     WHERE DepoID = ? AND active = 1 
                     ORDER BY ID DESC 
                     LIMIT 1`,
                    [DepoID]
                );

                // If no pool entry exists, get initial balance from depo table
                let currentDepoLimit = 0;
                if (currentPoolRows.length > 0) {
                    currentDepoLimit = parseFloat(currentPoolRows[0].DepoLimit || 0);
                } else {
                    // Get initial balance from depo table if no pool entries exist
                    const [depoBalanceRows] = await connection.execute(
                        `SELECT Balance FROM depo WHERE id = ?`,
                        [DepoID]
                    );
                    if (depoBalanceRows.length > 0) {
                        currentDepoLimit = parseFloat(depoBalanceRows[0].Balance || 0);
                    }
                }

                // Calculate new DepoLimit: current + credit amount
                const newDepoLimit = currentDepoLimit + Amount;

                // 4. Find trips for this depo that have remaining balance (payable_amount > paid_amount) - FIFO
                // This is done BEFORE pool insertion to get TripID
                // Join through trip_depos to find trips for this depo
                const [tripsWithBalance] = await connection.execute(
                    `SELECT t.id, t.start_date,
                     COALESCE(SUM(td.payable_amount), 0) as total_payable,
                     COALESCE(SUM(td.paid_amount), 0) as total_paid,
                     (COALESCE(SUM(td.payable_amount), 0) - COALESCE(SUM(td.paid_amount), 0)) as remaining
                     FROM trips t
                     INNER JOIN trip_depos td ON td.trip_id = t.id AND td.depo_id = ? AND td.Active = 1
                     WHERE t.status != 'Cancelled'
                     AND t.active = 1
                     GROUP BY t.id, t.start_date
                     HAVING (COALESCE(SUM(td.payable_amount), 0) - COALESCE(SUM(td.paid_amount), 0)) > 0
                     ORDER BY t.start_date ASC, t.id ASC`,
                    [DepoID]
                );

                // Get TripID from oldest trip with remaining balance (FIFO)
                let tripIdForPool = null;
                if (tripsWithBalance.length > 0) {
                    tripIdForPool = tripsWithBalance[0].id;
                }
                
                // 5. Insert pool entry with recovery_id as NULL (will be updated after recovery is inserted)
                const poolQuery = `
                    INSERT INTO pool (
                        DepoID, 
                        TripID,
                        Debit, 
                        Credit, 
                        DepoLimit,
                        Date,
                        payment_id,
                        recovery_id,
                        active
                    ) VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, 1)
                `;
                
                const [poolResult] = await connection.execute(poolQuery, [
                    DepoID,
                    tripIdForPool,
                    Amount,  // Credit amount (recovery payment received, increases depo limit)
                    newDepoLimit,  // New DepoLimit = current DepoLimit + credit amount
                    recoveryDate  // Date value for pool entry
                ]);
                
                poolEntryId = poolResult.insertId;

                // Note: DO NOT update depo.Balance column for recovery payments
                // The depo.Balance should remain at its initial value
                // All balance changes are tracked in the pool table via DepoLimit

                // 4. Update trip_depos for this depo - apply payment to trip_depos entries with remaining balance
                // Get trip_depos entries for this depo that have remaining balance (FIFO by trip date)
                const [tripDeposWithBalance] = await connection.execute(
                    `SELECT td.id, td.trip_id, td.depo_id, td.paid_amount, td.payable_amount,
                     (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining,
                     t.start_date
                     FROM trip_depos td
                     INNER JOIN trips t ON t.id = td.trip_id
                     WHERE td.depo_id = ?
                     AND td.Active = 1
                     AND t.status != 'Cancelled'
                     AND t.active = 1
                     AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                     ORDER BY t.start_date ASC, t.id ASC, td.id ASC`,
                    [DepoID]
                );

                let remainingPayment = parseFloat(Amount);
                
                // Apply payment to trip_depos entries in order (oldest first)
                for (const tripDepo of tripDeposWithBalance) {
                    if (remainingPayment <= 0) break;
                    
                    const currentPaid = parseFloat(tripDepo.paid_amount) || 0;
                    const payableAmount = parseFloat(tripDepo.payable_amount) || 0;
                    const remaining = parseFloat(tripDepo.remaining) || 0;
                    
                    // Calculate how much to apply to this trip_depos entry
                    const paymentToApply = Math.min(remainingPayment, remaining);
                    const newPaid = currentPaid + paymentToApply;
                    
                    // Update trip_depos paid_amount
                    await connection.execute(
                        `UPDATE trip_depos 
                         SET paid_amount = ?, 
                             MD = NOW()
                         WHERE id = ?`,
                        [newPaid, tripDepo.id]
                    );
                    
                    remainingPayment -= paymentToApply;
                    
                    console.log(`Applied ${paymentToApply} to trip_depos ${tripDepo.id} (trip ${tripDepo.trip_id}). New paid: ${newPaid}, Remaining: ${payableAmount - newPaid}`);
                }
                
                // Recalculate trips table paid and amount_collected from trip_depos for all affected trips
                // Get unique trip IDs from trip_depos entries we just updated
                const affectedTripIds = [...new Set(tripDeposWithBalance.map(td => td.trip_id))];
                
                // Recalculate trips paid and amount_collected from trip_depos
                for (const tripId of affectedTripIds) {
                    const [tripDepoSum] = await connection.execute(
                        `SELECT 
                         COALESCE(SUM(CASE WHEN purchase_type = 'cash' THEN paid_amount ELSE 0 END), 0) as cash_paid,
                         COALESCE(SUM(paid_amount), 0) as total_collected
                         FROM trip_depos 
                         WHERE trip_id = ? AND Active = 1`,
                        [tripId]
                    );
                    
                    const tripPaid = parseFloat(tripDepoSum[0]?.cash_paid || 0); // Only cash counts as "paid" for trips
                    const tripCollected = parseFloat(tripDepoSum[0]?.total_collected || 0); // Total collected
                    
                    await connection.execute(
                        `UPDATE trips 
                         SET paid = ?, 
                             amount_collected = ?,
                             MD = NOW()
                         WHERE id = ?`,
                        [tripPaid, tripCollected, tripId]
                    );
                    
                    // Check if trip can be marked as Completed
                    await checkAndCloseTrip(connection, tripId);
                }

                // 4b. Also update CLIENT's trips amount_collected (for customer due calculation)
                // Use the client trips found earlier
                let remainingRecoveryAmount = parseFloat(Amount);
                
                // Apply amount to client's trips' amount_collected in order (oldest first)
                for (const trip of clientTripsWithBalance) {
                    if (remainingRecoveryAmount <= 0) break;
                    
                    const totalAmount = parseFloat(trip.total_amount) || 0;
                    const currentCollected = parseFloat(trip.amount_collected) || 0;
                    const remaining = parseFloat(trip.remaining) || 0;
                    
                    if (remaining > 0) {
                        // Calculate how much to apply to this trip
                        const amountToApply = Math.min(remainingRecoveryAmount, remaining);
                        const newCollected = currentCollected + amountToApply;
                        
                        // Update trip's amount_collected
                        await connection.execute(
                            `UPDATE trips 
                             SET amount_collected = ?,
                                 MD = NOW()
                             WHERE id = ?`,
                            [newCollected, trip.id]
                        );
                        
                        remainingRecoveryAmount -= amountToApply;
                        
                        console.log(`Applied ${amountToApply} to client trip ${trip.id} collected. New collected: ${newCollected}`);
                    }
                }

                // No transaction record for depo payments
                transactionID = null;

            } else if (payment_method === 'cash_in_hand') {
                // Cash in Hand payment - when receiving payment, it's credit (cash received)
                // 1. Get current balance from last active entry (more reliable than SUM)
                const [lastBalanceRows] = await connection.execute(`
                    SELECT balance FROM cash_in_hand 
                    WHERE Active = 1 
                    ORDER BY created_at DESC, id DESC 
                    LIMIT 1
                `);
                const currentBalance = lastBalanceRows.length > 0 
                    ? parseFloat(lastBalanceRows[0]?.balance || 0) 
                    : 0;
                const newBalance = currentBalance + Amount; // Credit adds to balance
                
                // 2. Insert into cash_in_hand table with credit (cash received adds to balance)
                const customerName = await getCustomerName(connection, ClientID);
                const purpose = `Payment Received from ${customerName}`;
                
                const cashInHandQuery = `
                    INSERT INTO cash_in_hand (
                        debit,
                        credit,
                        balance,
                        purpose,
                        created_at
                    ) VALUES (0, ?, ?, ?, ?)
                `;
                
                const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                    Amount,  // Credit amount (cash received, adds to cash in hand balance)
                    newBalance,  // New running balance
                    purpose,
                    recoveryDate
                ]);
                
                const cashInHandId = cashInHandResult.insertId;

                // 2. Create transaction with cash_in_hand_id, BankID and AccountID as NULL, and trip_id
                // When receiving money TO cash in hand, it should be Credit (money coming in)
                const transactionQuery = `
                    INSERT INTO transactions (
                        cash_in_hand_id,
                        AccountID,
                        Purpose,
                        Debit,
                        Credit,
                        Date,
                        PaymentMode,
                        trip_id,
                        CD,
                        MD,
                        active
                    ) VALUES (?, NULL, ?, 0, ?, ?, 'Cash', ?, NOW(), NOW(), 1)
                `;
                
                const [transactionResult] = await connection.execute(transactionQuery, [
                    cashInHandId,
                    purpose,
                    Amount,  // Credit = Amount (money received into cash in hand)
                    recoveryDate,
                    tripIdForTransaction  // Trip ID from FIFO (oldest trip with remaining balance)
                ]);
                
                transactionID = transactionResult.insertId;
            }

            // Use the trip_id found earlier for recovery record (same FIFO trip)
            const tripIdForRecovery = tripIdForTransaction;

            // Update trips amount_collected for Own Account and Cash in Hand payments
            if (payment_method === 'account' || payment_method === 'cash_in_hand') {
                // Use the trips found above
                const clientTrips = clientTripsWithBalance;

                let remainingAmount = parseFloat(Amount);
                
                // Apply amount to trips' amount_collected in order (oldest first)
                for (const trip of clientTrips) {
                    if (remainingAmount <= 0) break;
                    
                    const totalAmount = parseFloat(trip.total_amount) || 0;
                    const currentCollected = parseFloat(trip.amount_collected) || 0;
                    const remaining = totalAmount - currentCollected;
                    
                    if (remaining > 0) {
                        // Calculate how much to apply to this trip
                        const amountToApply = Math.min(remainingAmount, remaining);
                        const newCollected = currentCollected + amountToApply;
                        
                        // Update trip's amount_collected
                        await connection.execute(
                            `UPDATE trips 
                             SET amount_collected = ?,
                                 MD = NOW()
                             WHERE id = ?`,
                            [newCollected, trip.id]
                        );
                        
                        remainingAmount -= amountToApply;
                        
                        console.log(`Applied ${amountToApply} to trip ${trip.id} collected. New collected: ${newCollected}`);
                    }
                }
            }

            // Insert into recoveries table
            // CD = Created Date (recovery date), MD = Modified Date (current timestamp)
            // payment_method = the value from "Received In" dropdown (account, depo, cash_in_hand)
            // payment_head = the formatted display string (Cash in Hand, Bank Account - ..., Depo - ...)
            // trip_id = oldest trip with remaining balance (FIFO)
            const recoveryQuery = `
                INSERT INTO recoveries (
                    transactionID,
                    ClientID,
                    trip_id,
                    Amount,
                    Date,
                    Payment_Head,
                    CD,
                    MD,
                    Active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 1)
            `;
            
            const [recoveryResult] = await connection.execute(recoveryQuery, [
                transactionID,
                ClientID,
                tripIdForRecovery,  // Trip ID from FIFO (oldest trip with remaining balance)
                Amount,
                recoveryDate,
                payment_head || null,  // Save formatted payment_head string
                recoveryDate  // CD = recovery date
            ]);
            
            const recoveryId = recoveryResult.insertId;
            
            // Update pool entry with recovery_id if this was a depo payment
            if (payment_method === 'depo' && poolEntryId) {
                await connection.execute(
                    'UPDATE pool SET recovery_id = ? WHERE ID = ?',
                    [recoveryId, poolEntryId]
                );
                console.log(`Updated pool entry ${poolEntryId} with recovery_id ${recoveryId}`);
            }
            
            // Update settlement with recovery_id if this was a depo payment
            if (payment_method === 'depo' && settlementId) {
                await connection.execute(
                    'UPDATE settlements SET recovery_id = ? WHERE id = ?',
                    [recoveryId, settlementId]
                );
            }

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({
                message: 'Recovery added successfully',
                transactionID: transactionID
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error adding recovery:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message,
            sqlMessage: err.sqlMessage 
        });
    }
};

// Helper function to get customer name
async function getCustomerName(connection, clientId) {
    try {
        const [rows] = await connection.execute(
            'SELECT name FROM customers WHERE id = ?',
            [clientId]
        );
        return rows.length > 0 ? (rows[0].name || `Customer ${clientId}`) : `Customer ${clientId}`;
    } catch (err) {
        console.error('Error fetching customer name:', err);
        return `Customer ${clientId}`;
    }
}

// Delete recovery
exports.deleteRecovery = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Recovery ID is required' });
        }

        // Get connection for transaction
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Step 1: Get recovery details including trip_id
            const [recoveryRows] = await connection.execute(
                `SELECT r.transactionID, r.Amount, r.ClientID, r.Payment_Head, r.Date, r.trip_id,
                        t.AccountID, t.cash_in_hand_id, t.Purpose, t.trip_id as transaction_trip_id
                 FROM recoveries r
                 LEFT JOIN transactions t ON r.transactionID = t.ID AND t.active = 1
                 WHERE r.ID = ? AND r.Active = 1`,
                [id]
            );

            if (recoveryRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Recovery not found' });
            }

            const recovery = recoveryRows[0];
            const transactionID = recovery.transactionID;
            const amount = parseFloat(recovery.Amount || 0);
            const recoveryDate = recovery.Date;
            const tripId = recovery.trip_id || recovery.transaction_trip_id;
            
            // Determine payment method from transaction data
            let paymentMethod = null;
            if (!transactionID) {
                // No transaction means it's a depo payment
                paymentMethod = 'depo';
            } else if (recovery.cash_in_hand_id) {
                paymentMethod = 'cash_in_hand';
            } else if (recovery.AccountID) {
                paymentMethod = 'account';
            }

            // Step 2: Soft delete recovery
            await connection.execute(
                'UPDATE recoveries SET Active = 0, MD = NOW() WHERE ID = ?',
                [id]
            );
            console.log(`Soft deleted recovery ${id}`);

            // Step 3: Handle transactions (cash_in_hand and account)
            if (transactionID) {
                const [transactionRows] = await connection.execute(
                    'SELECT AccountID, cash_in_hand_id, Debit, Credit, active FROM transactions WHERE ID = ? AND active = 1',
                    [transactionID]
                );

                if (transactionRows.length > 0) {
                    const transaction = transactionRows[0];

                    // Step 3a: Handle cash_in_hand
                    if (transaction.cash_in_hand_id) {
                        // Soft delete cash_in_hand entry
                        await connection.execute(
                            'UPDATE cash_in_hand SET Active = 0, MD = NOW() WHERE id = ? AND Active = 1',
                            [transaction.cash_in_hand_id]
                        );
                        console.log(`Soft deleted cash_in_hand entry ${transaction.cash_in_hand_id}`);
                        
                        // Recalculate all balances after soft deletion
                        await recalculateAllBalances(connection);
                        console.log('Recalculated cash_in_hand balances');
                    }

                    // Step 3b: Handle account
                    if (transaction.AccountID) {
                        // Soft delete account entry
                        await connection.execute(
                            'UPDATE accounts SET active = 0, MD = NOW() WHERE ID = ? AND active = 1',
                            [transaction.AccountID]
                        );
                        console.log(`Soft deleted account ${transaction.AccountID}`);
                        
                        // Adjust account balance (subtract the credit amount that was added)
                        const creditAmount = parseFloat(transaction.Credit || 0);
                        if (creditAmount > 0) {
                            await connection.execute(
                                'UPDATE accounts SET Balance = Balance - ?, MD = NOW() WHERE ID = ?',
                                [creditAmount, transaction.AccountID]
                            );
                            console.log(`Adjusted account ${transaction.AccountID} balance: subtracted ${creditAmount}`);
                        }
                    }

                    // Step 3c: Soft delete transaction
                    await connection.execute(
                        'UPDATE transactions SET active = 0, MD = NOW() WHERE ID = ?',
                        [transactionID]
                    );
                    console.log(`Soft deleted transaction ${transactionID}`);
                }
            }

            // Step 4: Handle settlements (depo payment)
            // Check if there are settlements for this recovery_id
            const [settlementRows] = await connection.execute(
                `SELECT id, depo_id, amount, settlement_type 
                 FROM settlements 
                 WHERE recovery_id = ? AND Active = 1`,
                [id]
            );

            if (settlementRows.length > 0) {
                console.log(`Found ${settlementRows.length} settlement(s) for recovery ${id}`);

                // Step 4a: Soft delete all settlements for this recovery_id
                await connection.execute(
                    'UPDATE settlements SET Active = 0, MD = NOW() WHERE recovery_id = ? AND Active = 1',
                    [id]
                );
                console.log(`Soft deleted ${settlementRows.length} settlement(s) for recovery ${id}`);

                // Step 4b: Get trip_id from recovery or from pool entries
                // If trip_id is not in recovery, get it from pool entries
                let actualTripId = tripId;
                if (!actualTripId) {
                    // Get trip_id from pool entries with this recovery_id
                    const [poolTripRows] = await connection.execute(
                        'SELECT DISTINCT TripID FROM pool WHERE recovery_id = ? AND active = 1 LIMIT 1',
                        [id]
                    );
                    if (poolTripRows.length > 0 && poolTripRows[0].TripID) {
                        actualTripId = poolTripRows[0].TripID;
                    }
                }

                // Step 4c: Soft delete pool rows with trip_id and recovery_id
                if (actualTripId) {
                    const [poolRowsToSoftDelete] = await connection.execute(
                        'SELECT ID, DepoID FROM pool WHERE TripID = ? AND recovery_id = ? AND active = 1',
                        [actualTripId, id]
                    );

                    if (poolRowsToSoftDelete.length > 0) {
                        const minPoolId = Math.min(...poolRowsToSoftDelete.map(r => r.ID));
                        const poolDepoIds = [...new Set(poolRowsToSoftDelete.map(r => r.DepoID))];

                        // Soft delete these pool rows
                        await connection.execute(
                            'UPDATE pool SET active = 0, MD = NOW() WHERE TripID = ? AND recovery_id = ? AND active = 1',
                            [actualTripId, id]
                        );
                        console.log(`Soft deleted ${poolRowsToSoftDelete.length} pool row(s) for trip_id ${actualTripId} and recovery_id ${id}`);

                        // Step 4d: Recalculate pool balances for each affected depo
                        for (const poolDepoId of poolDepoIds) {
                            const finalBalance = await recalculatePoolBalancesFromRow(connection, poolDepoId, minPoolId);
                            if (finalBalance !== null) {
                                await connection.execute(
                                    'UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?',
                                    [finalBalance, poolDepoId]
                                );
                                console.log(`Updated depo ${poolDepoId} balance to ${finalBalance}`);
                            }
                        }
                    }
                }

                // Step 4e: Calculate sum of all settlement amounts for this recovery_id and subtract from depo balance
                // Group settlements by depo_id
                const depoSettlementMap = new Map();
                for (const settlement of settlementRows) {
                    const depoId = settlement.depo_id;
                    const settlementAmount = parseFloat(settlement.amount || 0);
                    
                    if (!depoSettlementMap.has(depoId)) {
                        depoSettlementMap.set(depoId, 0);
                    }
                    depoSettlementMap.set(depoId, depoSettlementMap.get(depoId) + settlementAmount);
                }

                // Subtract sum from each depo balance
                for (const [depoId, totalSettlementAmount] of depoSettlementMap.entries()) {
                    await connection.execute(
                        'UPDATE depo SET Balance = Balance - ?, MD = NOW() WHERE id = ?',
                        [totalSettlementAmount, depoId]
                    );
                    console.log(`Subtracted ${totalSettlementAmount} from depo ${depoId} balance (sum of settlement amounts)`);
                }
            }

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({ message: 'Recovery deleted successfully' });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error deleting recovery:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

