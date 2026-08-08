const db = require('../models/db');

function resolveAuditUser(body = {}) {
    return (
        body.MB ||
        body.CB ||
        body.userName ||
        body.username ||
        body.UserName ||
        body.createdBy ||
        body.modifiedBy ||
        'System'
    ).toString().trim() || 'System';
}

// Helper function to check and mark trip as Completed if all payments, recoveries are cleared and all fuel is sold
async function checkAndCloseTrip(connection, tripId) {
    try {
        // Check if all trip_depos are fully paid (paid_amount >= payable_amount)
        // This covers both payments and recoveries since both update trip_depos.paid_amount
        const [rows] = await connection.execute(
            `SELECT COUNT(*) as total_count,
                    SUM(CASE WHEN paid_amount >= payable_amount THEN 1 ELSE 0 END) as paid_count
             FROM trip_depos
             WHERE trip_id = ? AND Active = 1`,
            [tripId]
        );

        const totalCount = parseInt(rows[0]?.total_count || 0);
        const paidCount = parseInt(rows[0]?.paid_count || 0);

        // Check if all fuel is sold (sum of quantity_ltr from trip_products equals sum of fuel from pol_sale)
        const [fuelRows] = await connection.execute(
            `SELECT 
                COALESCE((SELECT SUM(quantity_ltr) FROM trip_products WHERE trip_id = ? AND Active = 1), 0) as total_fuel,
                COALESCE((SELECT SUM(fuel) FROM pol_sale WHERE trip_id = ? AND Active = 1), 0) as sold_fuel
            `,
            [tripId, tripId]
        );

        const totalFuel = parseFloat(fuelRows[0]?.total_fuel || 0);
        const soldFuel = parseFloat(fuelRows[0]?.sold_fuel || 0);

        // Debug logging
        console.log(`Trip ${tripId} - Depos: ${paidCount}/${totalCount}, Fuel: ${soldFuel}/${totalFuel}`);


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
exports._addPayment = async (req, res) => {
    try {
        const {
            AccountID,
            DepoID,
            Amount,
            PaymentMode,
            ReferenceNo,
            isFine,
            IsFine,
        } = req.body;
        const createdBy = resolveAuditUser(req.body);
        const fineSelected = isFine === true || isFine === 'true' || IsFine === true || IsFine === 'true';

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

            if (fineSelected) {
                const transactionPurpose = `Fine Payment to Depo ${DepoID}`;

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
                        CB,
                        active
                    ) VALUES (?, ?, ?, 0, NOW(), ?, ?, NULL, ?, 1)
                `;

                const [transactionResult] = await connection.execute(transactionQuery, [
                    AccountID,
                    transactionPurpose,
                    Amount,
                    PaymentMode,
                    ReferenceNo || null,
                    createdBy
                ]);

                const transactionID = transactionResult.insertId;

                const paymentQuery = `
                    INSERT INTO payments (
                        transactionID,
                        DepoID,
                        trip_id,
                        Amount,
                        Date,
                        CB,
                        isFine,
                        active
                    ) VALUES (?, ?, NULL, ?, NOW(), ?, ?, 1)
                `;

                const [paymentResult] = await connection.execute(paymentQuery, [
                    transactionID,
                    DepoID,
                    Amount,
                    createdBy,
                    1
                ]);

                const [updateResult] = await connection.execute(
                    `UPDATE accounts
                     SET Balance = Balance - ?,
                         MB = ?,
                         MD = NOW()
                     WHERE ID = ? AND active = 1`,
                    [Amount, createdBy, AccountID]
                );

                if (updateResult.affectedRows === 0) {
                    await connection.rollback();
                    connection.release();
                    return res.status(404).json({ message: 'Account not found or inactive' });
                }

                await connection.commit();
                connection.release();

                return res.json({
                    message: 'Fine payment added successfully',
                    transactionID,
                    paymentID: paymentResult.insertId
                });
            }

            // STEP 1: First, deduct from previous_payables in depo table
            // Get depo's current previous_payables
            const [depoRows] = await connection.execute(
                `SELECT id, name, Balance, previous_payables FROM depo WHERE id = ? AND active = 1`,
                [DepoID]
            );

            if (depoRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Depo not found or inactive' });
            }

            const depo = depoRows[0];
            const currentDepoBalance = parseFloat(depo.Balance || 0);
            const depoName = depo.name || `Depo ${DepoID}`;
            const currentPreviousPayables = parseFloat(depo.previous_payables || 0) || 0;
            const paymentAmount = parseFloat(Amount);
            let remainingPaymentAmount = paymentAmount;
            let amountDeductedFromPreviousPayables = 0;

            console.log(`[Payment] Depo ${DepoID} (${depoName}) - Current previous_payables: ${currentPreviousPayables}, Payment Amount: ${paymentAmount}`);

            // Deduct from previous_payables first
            if (currentPreviousPayables > 0 && remainingPaymentAmount > 0) {
                if (remainingPaymentAmount <= currentPreviousPayables) {
                    // Payment amount is less than or equal to previous_payables
                    // Deduct all payment amount from previous_payables
                    amountDeductedFromPreviousPayables = remainingPaymentAmount;
                    const newPreviousPayables = currentPreviousPayables - remainingPaymentAmount;

                    const [updateResult] = await connection.execute(
                        'UPDATE depo SET previous_payables = ?, MD = NOW() WHERE id = ?',
                        [newPreviousPayables, DepoID]
                    );

                    if (updateResult.affectedRows === 0) {
                        console.error(`[Payment] Failed to update previous_payables for depo ${DepoID}`);
                    } else {
                        console.log(`[Payment] Successfully deducted ${amountDeductedFromPreviousPayables} from previous_payables for depo ${DepoID}. Old: ${currentPreviousPayables}, New: ${newPreviousPayables}`);
                    }

                    remainingPaymentAmount = 0; // No amount left for trip payments
                } else {
                    // Payment amount exceeds previous_payables
                    // Deduct all previous_payables (set to 0)
                    amountDeductedFromPreviousPayables = currentPreviousPayables;
                    remainingPaymentAmount = remainingPaymentAmount - currentPreviousPayables;

                    const [updateResult] = await connection.execute(
                        'UPDATE depo SET previous_payables = 0, MD = NOW() WHERE id = ?',
                        [DepoID]
                    );

                    if (updateResult.affectedRows === 0) {
                        console.error(`[Payment] Failed to update previous_payables to 0 for depo ${DepoID}`);
                    } else {
                        console.log(`[Payment] Successfully deducted all previous_payables (${amountDeductedFromPreviousPayables}) for depo ${DepoID}. Remaining payment amount: ${remainingPaymentAmount}`);
                    }
                }
            } else if (currentPreviousPayables === 0 && remainingPaymentAmount > 0) {
                console.log(`[Payment] Depo ${DepoID} has no previous_payables (0). All payment amount (${remainingPaymentAmount}) will be applied to trip payments.`);
            } else if (remainingPaymentAmount === 0) {
                console.log(`[Payment] Payment amount is 0, nothing to process.`);
            }

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
            // But first, deduct from previous_payables (already done above in STEP 1)
            // Use remainingPaymentAmount (after previous_payables deduction) for advance payment processing
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
                // Use remainingPaymentAmount (after previous_payables deduction) for advance balance
                const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + remainingPaymentAmount;

                // Create transaction for advance payment (no trip association)
                // Record FULL payment amount in transaction
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
                        CB,
                        active
                    ) VALUES (?, ?, ?, 0, NOW(), ?, ?, NULL, ?, 1)
                `;

                const [transactionResult] = await connection.execute(transactionQuery, [
                    AccountID,
                    `Advance Payment to ${depoName}${amountDeductedFromPreviousPayables > 0 ? ` (${amountDeductedFromPreviousPayables} applied to previous payables, ${remainingPaymentAmount} to advance)` : ''}`,
                    Amount,  // Record FULL payment amount
                    PaymentMode,
                    ReferenceNo || null,
                    createdBy
                ]);

                const transactionID = transactionResult.insertId;

                // Create payment record for advance payment
                // Record FULL payment amount in payment
                const paymentQuery = `
                    INSERT INTO payments (
                        transactionID, 
                        DepoID,
                        trip_id,
                        Amount, 
                        Date, 
                        CB,
                        active
                    ) VALUES (?, ?, NULL, ?, NOW(), ?, 1)
                `;

                const [paymentResult] = await connection.execute(paymentQuery, [
                    transactionID,
                    DepoID,
                    Amount,  // Record FULL payment amount
                    createdBy
                ]);

                const paymentID = paymentResult.insertId;

                // Update Accounts table - subtract amount from balance (use full Amount, not remainingPaymentAmount)
                const updateAccountQuery = `
                    UPDATE accounts 
                    SET Balance = Balance - ?, 
                        MD = NOW()
                    WHERE ID = ? AND active = 1
                `;

                await connection.execute(
                    `UPDATE accounts 
                     SET Balance = Balance - ?, 
                         MB = ?,
                         MD = NOW()
                     WHERE ID = ? AND active = 1`,
                    [Amount, createdBy, AccountID]
                );  // Use full Amount for account debit

                // Insert Credit entry to advance_balance table (only if there's remaining amount after previous_payables)
                if (remainingPaymentAmount > 0) {
                    await connection.execute(
                        `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, paymentID, remainingPaymentAmount, newAdvanceBalanceInTable, 'admin@gmail.com']
                    );
                    console.log(`Added advance_balance entry for advance payment: Credit=${remainingPaymentAmount}, New Balance=${newAdvanceBalanceInTable}`);
                }

                if (amountDeductedFromPreviousPayables > 0) {
                    console.log(`Deducted ${amountDeductedFromPreviousPayables} from previous_payables for advance payment. Remaining ${remainingPaymentAmount} added to advance_balance.`);
                }

                await connection.commit();
                connection.release();

                return res.json({
                    message: 'Advance payment added successfully',
                    transactionID: transactionID,
                    paymentID: paymentResult.insertId,
                    advanceBalance: newAdvanceBalanceInTable
                });
            }

            // Get current pool balance (actual credit limit from pool table)
            // CRITICAL: This is the balance BEFORE any payment processing
            const [currentPoolRows] = await connection.execute(
                `SELECT DepoLimit, ID, TripID, payment_id, Credit, Debit 
                 FROM pool 
                 WHERE DepoID = ? AND active = 1 
                 ORDER BY ID DESC 
                 LIMIT 1`,
                [DepoID]
            );
            let currentPoolBalance = currentPoolRows.length > 0
                ? parseFloat(currentPoolRows[0].DepoLimit || 0)
                : currentDepoBalance;

            console.log(`=== PAYMENT PROCESSING START ===`);
            console.log(`DepoID: ${DepoID}, DepoName: ${depoName}`);
            console.log(`Payment Amount: ${Amount}`);
            console.log(`Current Pool Balance (from DB): ${currentPoolBalance}`);
            console.log(`Pool Row Details:`, currentPoolRows.length > 0 ? {
                ID: currentPoolRows[0].ID,
                DepoLimit: currentPoolRows[0].DepoLimit,
                TripID: currentPoolRows[0].TripID,
                payment_id: currentPoolRows[0].payment_id,
                Credit: currentPoolRows[0].Credit,
                Debit: currentPoolRows[0].Debit
            } : 'No pool row found');
            console.log(`Current Depo Balance: ${currentDepoBalance}`);
            console.log(`Remaining Balance (Payable): ${remainingBalance}`);

            // CRITICAL VALIDATION: Verify we're reading the correct starting balance
            // If currentPoolBalance doesn't match what we expect, log a warning
            if (currentPoolRows.length > 0 && currentPoolRows[0].payment_id !== null) {
                console.log(`⚠️ WARNING: Reading pool balance from a payment-related entry (payment_id=${currentPoolRows[0].payment_id}). This might not be the correct starting balance.`);
            }

            // Payment allocation logic (CORRECT ORDER):
            // 0. FIRST: Deduct from previous_payables (already done above)
            // 1. SECOND: Pay off trips (Amount Payable) - clear the payable amount (using remainingPaymentAmount)
            // 2. THIRD: If amount remains, restore/add to credit limit (pool)
            // 3. FOURTH: If amount still remains, go to advance balance

            // Handle payment: Use remainingPaymentAmount (after previous_payables deduction)
            // remainingPaymentAmount can exceed remainingBalance, excess goes to advance_balance
            const amountToApplyToTrips = Math.min(remainingPaymentAmount, remainingBalance);
            const excessAmount = Math.max(0, remainingPaymentAmount - remainingBalance);

            let remainingPayment = amountToApplyToTrips;
            let amountToTrips = 0;
            let amountToRestorePool = 0;
            let amountToPool = 0;
            let amountToAdvanceBalance = 0;

            // Step 1: SECOND - Pay off trips (Amount Payable) using remainingPaymentAmount
            // Only if there's remaining amount after previous_payables deduction
            if (remainingPaymentAmount > 0) {
                amountToTrips = remainingPayment;
                remainingPayment = 0; // All payment is allocated to trips
            }

            // Step 2: SECOND - Calculate restore/add-to-pool AFTER trips (if there's remaining payment)
            // Since all payment goes to trips, these will be 0
            // This is calculated later after trip payments are processed

            // Step 3: THIRD - Any remaining goes to advance_balance
            // Also add excess amount (if payment exceeds remainingBalance) to advance_balance
            amountToAdvanceBalance = excessAmount;

            // For now, newPoolBalance is just currentPoolBalance
            // It will be updated after trip payments are processed
            let newPoolBalance = currentPoolBalance;
            let newDepoBalance = currentDepoBalance;

            console.log(`Payment allocation for Depo ${DepoID}:`);
            console.log(`  Total payment amount: ${paymentAmount}`);
            console.log(`  Amount deducted from previous_payables: ${amountDeductedFromPreviousPayables}`);
            console.log(`  Remaining payment amount (for trips): ${remainingPaymentAmount}`);
            console.log(`  Amount payable (remainingBalance): ${remainingBalance}`);
            console.log(`  Amount to trips: ${amountToTrips}`);
            console.log(`  Excess amount: ${excessAmount}`);
            console.log(`  Amount to restore pool: ${amountToRestorePool} (will be calculated after trips)`);
            console.log(`  Amount to pool: ${amountToPool} (will be calculated after trips)`);
            console.log(`  Amount to advance_balance: ${amountToAdvanceBalance}`);
            console.log(`  Starting pool balance: ${currentPoolBalance} (will be updated after trip payments)`);

            // Create ONE main transaction with FULL payment amount
            const transactionPurpose = `Payment to ${depoName}${amountDeductedFromPreviousPayables > 0 ? ` (${amountDeductedFromPreviousPayables} applied to previous payables, ${remainingPaymentAmount} to trips/advance)` : ''}`;
            const mainTransactionQuery = `
                INSERT INTO transactions (
                    AccountID, 
                    Purpose, 
                    Debit, 
                    Credit, 
                    Date, 
                    PaymentMode, 
                    ReferenceNo,
                    trip_id,
                    CB,
                    active
                ) VALUES (?, ?, ?, 0, NOW(), ?, ?, NULL, ?, 1)
            `;

            const [mainTransactionResult] = await connection.execute(mainTransactionQuery, [
                AccountID,
                transactionPurpose,
                Amount,  // Record FULL payment amount
                PaymentMode,
                ReferenceNo || null,
                createdBy
            ]);

            const mainTransactionID = mainTransactionResult.insertId;
            const transactionIds = [mainTransactionID];

            // Create ONE main payment record with FULL payment amount
            const mainPaymentQuery = `
                INSERT INTO payments (
                    transactionID, 
                    DepoID,
                    trip_id,
                    Amount, 
                    Date, 
                    CB,
                    active
                ) VALUES (?, ?, NULL, ?, NOW(), ?, 1)
            `;

            const [mainPaymentResult] = await connection.execute(mainPaymentQuery, [
                mainTransactionID,
                DepoID,
                Amount,  // Record FULL payment amount
                createdBy
            ]);

            const mainPaymentID = mainPaymentResult.insertId;
            const paymentIds = [mainPaymentID];

            // 2. SECOND - Apply payment to trips (Amount Payable) in order (oldest first)
            // Only if there's remaining amount after previous_payables deduction
            // Find trips for this depo that have remaining balance using trip_depos table - FIFO
            let tripsWithBalance = [];

            if (remainingPaymentAmount > 0) {
                const [tripsResult] = await connection.execute(
                    `SELECT t.id, t.trip_no, t.start_date, td.id as trip_depo_id, td.payable_amount, td.paid_amount,
                 (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining
                 FROM trips t
                 INNER JOIN trip_depos td ON td.trip_id = t.id AND td.depo_id = ? AND td.Active = 1
                 WHERE t.status != 'Cancelled'
                 AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                 ORDER BY t.start_date ASC, t.id ASC`,
                    [DepoID]
                );
                tripsWithBalance = tripsResult;
            }

            // Apply payment to trips SECOND - use amountToTrips calculated above (from remainingPaymentAmount)
            // CRITICAL: When paying trips, we create pool entries for each trip payment
            // These pool entries reflect the credit being restored as trips are paid
            // Start with current pool balance for calculating running balance
            // As we pay trips, the pool balance increases (credit is restored)
            // CRITICAL: Use the currentPoolBalance read from the pool table at the start
            // This is the balance BEFORE any payment processing
            let runningPoolBalance = currentPoolBalance;

            console.log(`Starting trip payment processing:`);
            console.log(`  Current pool balance (from DB): ${currentPoolBalance}`);
            console.log(`  Amount to trips: ${amountToTrips}`);
            console.log(`  Starting runningPoolBalance: ${runningPoolBalance}`);

            // Apply payment to trips in order (oldest first)
            if (amountToTrips > 0) {
                let remainingForTrips = amountToTrips;

                for (const trip of tripsWithBalance) {
                    if (remainingForTrips <= 0) {
                        console.log(`No more remaining payment for trips. Stopping trip payment processing.`);
                        break;
                    }

                    const payableAmount = parseFloat(trip.payable_amount) || 0;
                    const currentPaid = parseFloat(trip.paid_amount) || 0;
                    const remaining = parseFloat(trip.remaining) || 0;
                    const tripDepoId = trip.trip_depo_id;

                    // Calculate how much to apply to this trip_depo
                    const paymentToApply = Math.min(remainingForTrips, remaining);

                    console.log(`Processing trip ${trip.id}: paymentToApply=${paymentToApply}, runningPoolBalance before=${runningPoolBalance}`);

                    // Create a NEW pool row for this trip payment
                    // When trips are paid, the pool balance increases (credit is restored)
                    // CRITICAL: Calculate the new balance BEFORE creating the pool entry
                    const newPoolBalanceForTrip = runningPoolBalance + paymentToApply;

                    console.log(`  Pool balance calculation: ${runningPoolBalance} + ${paymentToApply} = ${newPoolBalanceForTrip}`);

                    const poolQuery = `
                        INSERT INTO pool (
                            DepoID, 
                            TripID,
                            Debit, 
                            Credit, 
                            DepoLimit,
                            payment_id,
                            recovery_id,
                            CB,
                            active
                        ) VALUES (?, ?, 0, ?, ?, ?, NULL, ?, 1)
                    `;

                    await connection.execute(poolQuery, [
                        DepoID,
                        trip.id,  // Trip ID for this specific trip
                        paymentToApply,  // Credit = paymentToApply (money received into depo for this trip)
                        newPoolBalanceForTrip,  // New DepoLimit = Previous Pool Balance + Credit
                        mainPaymentID,  // Link to main payment record
                        createdBy
                    ]);

                    // Update running balance for next iteration
                    runningPoolBalance = newPoolBalanceForTrip;

                    console.log(`Created pool entry for trip ${trip.id}: Credit=${paymentToApply}, DepoLimit=${newPoolBalanceForTrip}, Updated runningPoolBalance=${runningPoolBalance}`);

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

                    remainingForTrips -= paymentToApply;

                    console.log(`Applied payment portion to trip ${trip.id} (trip_depo ${tripDepoId}). Applied ${paymentToApply}, New paid_amount: ${newPaidAmount}, Pool balance: ${runningPoolBalance}, Remaining for trips: ${remainingForTrips}`);
                }

                // Update currentPoolBalance to reflect the pool balance after trip payments
                currentPoolBalance = runningPoolBalance;
                console.log(`Completed trip payments. Final pool balance after trips: ${currentPoolBalance}`);
            } else {
                console.log(`No trip payments to process. Amount to trips: ${amountToTrips}`);
            }

            // Update pool balance after trip payments
            newPoolBalance = runningPoolBalance;
            console.log(`Final pool balance after trips: ${newPoolBalance}`);

            // 3. SECOND - If there's remaining payment after trips, restore/add to pool
            // Calculate remaining payment after trips (should be 0 since all payment goes to trips)
            let remainingAfterTrips = remainingPayment; // This should be 0 after all trips are paid

            if (remainingAfterTrips > 0) {
                // Step 2a: If pool balance is still negative, restore it
                if (newPoolBalance < 0) {
                    amountToRestorePool = Math.min(remainingAfterTrips, Math.abs(newPoolBalance));
                    remainingAfterTrips -= amountToRestorePool;
                }

                // Step 2b: Add remaining payment to pool up to initial limit
                if (remainingAfterTrips > 0) {
                    const poolBalanceAfterRestore = newPoolBalance + amountToRestorePool;
                    const poolSpaceAvailable = Math.max(0, initialBalance - poolBalanceAfterRestore);
                    amountToPool = Math.min(remainingAfterTrips, poolSpaceAvailable);
                }

                // Create pool entries for restore and add-to-pool amounts
                let poolBalanceForEntries = newPoolBalance;

                if (amountToRestorePool > 0) {
                    poolBalanceForEntries += amountToRestorePool;
                    await connection.execute(
                        `INSERT INTO pool (
                            DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CB, active
                        ) VALUES (?, NULL, 0, ?, ?, NULL, NULL, ?, 1)`,
                        [DepoID, amountToRestorePool, poolBalanceForEntries, createdBy]
                    );
                    console.log(`Created pool entry for restore: Credit=${amountToRestorePool}, DepoLimit=${poolBalanceForEntries}`);
                }

                if (amountToPool > 0) {
                    poolBalanceForEntries += amountToPool;
                    await connection.execute(
                        `INSERT INTO pool (
                            DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CB, active
                        ) VALUES (?, NULL, 0, ?, ?, NULL, NULL, ?, 1)`,
                        [DepoID, amountToPool, poolBalanceForEntries, createdBy]
                    );
                    console.log(`Created pool entry for add-to-pool: Credit=${amountToPool}, DepoLimit=${poolBalanceForEntries}`);
                }

                newPoolBalance = poolBalanceForEntries;
            }

            // Update depo balance to match the final pool balance
            // The depo table's Balance column should reflect the actual pool balance after all payments
            newDepoBalance = newPoolBalance;
            await connection.execute(
                `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                [newDepoBalance, DepoID]
            );
            console.log(`Updated depo ${DepoID}: Balance=${newDepoBalance} (from final pool balance)`);

            // 4. THIRD - Handle excess amount (if Amount > remainingBalance)
            // Note: Main transaction and payment already record the full Amount
            // Excess amount just needs to be added to advance_balance
            if (excessAmount > 0) {
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
                const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + excessAmount;

                // Insert Credit entry to advance_balance table with main payment_id
                await connection.execute(
                    `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                    [DepoID, mainPaymentID, excessAmount, newAdvanceBalanceInTable, 'admin@gmail.com']
                );
                console.log(`Added excess payment to advance_balance: Credit=${excessAmount}, PaymentID=${mainPaymentID}, New Balance=${newAdvanceBalanceInTable}`);
            }

            // Add advance_balance table entry if there's amount going to advance_balance
            if (amountToAdvanceBalance > 0 && excessAmount === 0) {
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

            // 5. Update Accounts table - subtract full amount from balance
            const updateAccountQuery = `
                UPDATE accounts 
                SET Balance = Balance - ?, 
                    MD = NOW()
                WHERE ID = ? AND active = 1
            `;

            const [updateResult] = await connection.execute(
                `UPDATE accounts 
                 SET Balance = Balance - ?, 
                     MB = ?,
                     MD = NOW()
                 WHERE ID = ? AND active = 1`,
                [Amount, createdBy, AccountID]
            );

            if (updateResult.affectedRows === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Account not found or inactive' });
            }

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({
                message: excessAmount > 0
                    ? `Payment added successfully. Applied ${amountToApplyToTrips.toFixed(2)} to trips, ${excessAmount.toFixed(2)} added as advance balance.`
                    : 'Payment added successfully',
                transactionIDs: transactionIds,
                paymentIDs: paymentIds,
                excessAmount: excessAmount > 0 ? excessAmount : 0
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

// Add payment transaction (Bank Account)
exports.addPaymentt = async (req, res) => {
    try {
        const {
            AccountID,
            DepoID,
            Amount,
            CreditHead,
            PaymentMode,
            ReferenceNo,
            isFine,
            IsFine,
        } = req.body;
        const createdBy = resolveAuditUser(req.body);
        const fineSelected = isFine === true || isFine === 'true' || IsFine === true || IsFine === 'true';

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
        if (!CreditHead || CreditHead == '') {
            return res.status(400).json({ message: 'Credit Head is required.' });
        }

        const connection = await db.getConnection();

        try {
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

            // Handle Fine Payment separately
            if (fineSelected) {
                return await handleFinePaymentFromBank(connection, {
                    AccountID,
                    DepoID,
                    Amount,
                    PaymentMode,
                    ReferenceNo,
                    createdBy,
                    currentBalance
                }, res);
            }

            // 1. Get depo details
            const [depoRows] = await connection.execute(
                `SELECT 
                    d.id,
                    d.name, 
                    d.Balance,
                    d.previous_payables,
                    d.special_credit_limit
                 FROM depo d
                 WHERE d.id = ? AND d.active = 1`,
                [DepoID]
            );

            if (depoRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Depo not found or inactive' });
            }

            const depo = depoRows[0];
            const depoName = depo.name || `Depo ${DepoID}`;
            let remainingAmount = parseFloat(Amount);
            let amountToAdd = parseFloat(Amount);
            let amountAppliedToPreviousDues = 0;
            let amountAppliedToTrips = 0;
            let amountToCredit = 0;
            let excessAmount = 0;

            // STEP 1: Deduct from previous_payables
            const currentPreviousPayables = parseFloat(depo.previous_payables || 0);
            if (currentPreviousPayables > 0 && remainingAmount > 0) {
                amountAppliedToPreviousDues = Math.min(remainingAmount, currentPreviousPayables);
                const newPreviousPayables = currentPreviousPayables - amountAppliedToPreviousDues;

                await connection.execute(
                    'UPDATE depo SET previous_payables = ?, MD = NOW() WHERE id = ?',
                    [newPreviousPayables, DepoID]
                );

                remainingAmount -= amountAppliedToPreviousDues;
                console.log(`[Bank Payment] Applied ${amountAppliedToPreviousDues} to previous dues. Remaining: ${remainingAmount}`);
            }

            // STEP 2: Pay trip dues (FIFO)
            if (remainingAmount > 0) {
                const [tripsWithBalance] = await connection.execute(
                    `SELECT t.id, t.trip_no, td.id as trip_depo_id, td.payable_amount, td.paid_amount,
                     (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining
                     FROM trips t
                     INNER JOIN trip_depos td ON td.trip_id = t.id AND td.depo_id = ? AND td.Active = 1
                     WHERE t.status != 'Cancelled'
                     AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                     ORDER BY t.start_date ASC, t.id ASC`,
                    [DepoID]
                );

                let tripPaymentAmount = remainingAmount;
                for (const trip of tripsWithBalance) {
                    if (tripPaymentAmount <= 0) break;

                    const remaining = parseFloat(trip.remaining) || 0;
                    const paymentToApply = Math.min(tripPaymentAmount, remaining);

                    // Update trip_depos paid_amount
                    const newPaidAmount = parseFloat(trip.paid_amount || 0) + paymentToApply;
                    await connection.execute(
                        `UPDATE trip_depos 
                         SET paid_amount = ?, MD = NOW()
                         WHERE id = ?`,
                        [newPaidAmount, trip.trip_depo_id]
                    );

                    // Update trips paid amount
                    const [tripDeposSum] = await connection.execute(
                        `SELECT COALESCE(SUM(paid_amount), 0) as total_paid
                         FROM trip_depos
                         WHERE trip_id = ? AND Active = 1`,
                        [trip.id]
                    );
                    await connection.execute(
                        `UPDATE trips SET paid = ?, MD = NOW() WHERE id = ?`,
                        [parseFloat(tripDeposSum[0]?.total_paid || 0), trip.id]
                    );

                    amountAppliedToTrips += paymentToApply;
                    tripPaymentAmount -= paymentToApply;

                    // Check if trip should be closed
                    await checkAndCloseTrip(connection, trip.id);
                }

                remainingAmount = tripPaymentAmount;
                console.log(`[Bank Payment] Applied ${amountAppliedToTrips} to trip dues. Remaining: ${remainingAmount}`);
            }

            // STEP 3: Create transaction entry
            const transactionPurpose = `Payment to ${depoName}${amountAppliedToPreviousDues > 0 ? ` (${amountAppliedToPreviousDues} to previous dues)` : ''}${amountAppliedToTrips > 0 ? ` (${amountAppliedToTrips} to trips)` : ''}${amountToCredit > 0 ? ` (${amountToCredit} to ${CreditHead})` : ''}${excessAmount > 0 ? ` (${excessAmount} to advance)` : ''}`;

            const [transactionResult] = await connection.execute(
                `INSERT INTO transactions (
                    AccountID, Purpose, Debit, Credit, Date, 
                    PaymentMode, ReferenceNo, trip_id, CB, active
                ) VALUES (?, ?, ?, 0, NOW(), ?, ?, NULL, ?, 1)`,
                [AccountID, transactionPurpose, Amount, PaymentMode, ReferenceNo || null, createdBy]
            );
            const transactionID = transactionResult.insertId;

            // STEP 4: Create payment record
            const [paymentResult] = await connection.execute(
                `INSERT INTO payments (
                    transactionID, DepoID, trip_id, Amount, 
                    Date, CB, active
                ) VALUES (?, ?, NULL, ?, NOW(), ?, 1)`,
                [transactionID, DepoID, Amount, createdBy]
            );
            const paymentID = paymentResult.insertId;

            // STEP 5: Update Account balance (debit)
            await connection.execute(
                `UPDATE accounts 
                 SET Balance = Balance - ?, 
                     MB = ?,
                     MD = NOW()
                 WHERE ID = ? AND active = 1`,
                [Amount, createdBy, AccountID]
            );

            // STEP 6: Credit to appropriate account (pool or special_credit_limit)
            const creditHeadLower = CreditHead.toLowerCase();

            if (creditHeadLower === 'credit') {
                console.log('In credit limit');
                // Get opening balance from pool table
                const [openingRows] = await connection.execute(
                    `SELECT Credit as opening_balance
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

                const openingBalance = openingRows.length > 0
                    ? parseFloat(openingRows[0].opening_balance || 0)
                    : 0;

                // Get current depo limit from pool table
                const [currentLimitRows] = await connection.execute(
                    `SELECT DepoLimit 
                     FROM pool 
                     WHERE DepoID = ? AND active = 1 
                     ORDER BY ID DESC 
                     LIMIT 1`,
                    [DepoID]
                );

                const currentDepoLimit = currentLimitRows.length > 0
                    ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                    : 0;

                // Calculate how much can be credited without exceeding opening balance
                const availableSpace = Math.max(0, openingBalance - currentDepoLimit);
                amountToCredit = Math.min(amountToAdd, availableSpace);
                excessAmount = amountToAdd - amountToCredit;

                if (amountToCredit > 0) {
                    const newDepoLimit = currentDepoLimit + amountToCredit;
                    await connection.execute(
                        `INSERT INTO pool (
                            DepoID, TripID, payment_id, recovery_id, 
                            Debit, Credit, DepoLimit, Date, MD, CD, CB, Active
                        ) VALUES (?, NULL, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, amountToCredit, newDepoLimit, createdBy]
                    );
                    console.log(`[Bank Payment] Credited ${amountToCredit} to pool. New limit: ${newDepoLimit}`);
                }

            } else if (creditHeadLower === 'specialcredit') {
                console.log('In special credit limit');
                // Get opening balance from special_credit_limit table
                const [openingRows] = await connection.execute(
                    `SELECT Credit as opening_balance
                     FROM special_credit_limit 
                     WHERE DepoID = ? 
                       AND TripID IS NULL 
                       AND payment_id IS NULL 
                       AND recovery_id IS NULL 
                       AND active = 1 
                     ORDER BY ID ASC 
                     LIMIT 1`,
                    [DepoID]
                );

                const openingBalance = openingRows.length > 0
                    ? parseFloat(openingRows[0].opening_balance || 0)
                    : 0;

                // Get current depo limit from special_credit_limit table
                const [currentLimitRows] = await connection.execute(
                    `SELECT DepoLimit 
                     FROM special_credit_limit 
                     WHERE DepoID = ? AND active = 1 
                     ORDER BY ID DESC 
                     LIMIT 1`,
                    [DepoID]
                );

                const currentDepoLimit = currentLimitRows.length > 0
                    ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                    : 0;

                // Calculate how much can be credited without exceeding opening balance
                const availableSpace = Math.max(0, openingBalance - currentDepoLimit);
                amountToCredit = Math.min(amountToAdd, availableSpace);
                excessAmount = amountToAdd - amountToCredit;

                if (amountToCredit > 0) {
                    const newDepoLimit = currentDepoLimit + amountToCredit;
                    await connection.execute(
                        `INSERT INTO special_credit_limit (
                            DepoID, TripID, payment_id, recovery_id, 
                            Debit, Credit, DepoLimit, Date, MD, CD, CB, Active
                        ) VALUES (?, NULL, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, paymentID, amountToCredit, newDepoLimit, createdBy]
                    );
                    console.log(`[Bank Payment] Credited ${amountToCredit} to special_credit_limit. New limit: ${newDepoLimit}`);
                }
            }

            // STEP 7: Add excess to advance_balance
            if (excessAmount > 0) {
                // Get current advance balance
                const [lastAdvanceRows] = await connection.execute(
                    `SELECT Balance FROM advance_balance 
                     WHERE DepoID = ? AND Active = 1 
                     ORDER BY ID DESC LIMIT 1`,
                    [DepoID]
                );
                const currentAdvanceBalance = lastAdvanceRows.length > 0
                    ? parseFloat(lastAdvanceRows[0].Balance || 0)
                    : 0;
                const newAdvanceBalance = currentAdvanceBalance + excessAmount;

                await connection.execute(
                    `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, 
                        Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                    [DepoID, paymentID, excessAmount, newAdvanceBalance, createdBy]
                );
                console.log(`[Bank Payment] Added ${excessAmount} to advance_balance. New balance: ${newAdvanceBalance}`);
            }

            // STEP 8: Update depo balance
            let newDepoBalance = 0;
            let newDepoSpecialCredit = 0;

            if (creditHeadLower === 'credit') {
                newDepoBalance = parseFloat(depo.Balance || 0) + amountToCredit;
                console.log('newDepoBalance ' + newDepoBalance);
                await connection.execute(
                    `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                    [newDepoBalance, DepoID]
                );
            } else if (creditHeadLower === 'specialcredit') {
                newDepoSpecialCredit = parseFloat(depo.special_credit_limit || 0) + amountToCredit;
                console.log('newDepoSpecialCredit ' + newDepoSpecialCredit);
                await connection.execute(
                    `UPDATE depo SET special_credit_limit = ?, MD = NOW() WHERE id = ?`,
                    [newDepoSpecialCredit, DepoID]
                );
            }

            await connection.commit();
            connection.release();

            // Build response message
            let responseMessage = 'Bank payment added successfully.';
            const details = [];
            if (amountAppliedToPreviousDues > 0) details.push(`${amountAppliedToPreviousDues.toFixed(2)} to previous dues`);
            if (amountAppliedToTrips > 0) details.push(`${amountAppliedToTrips.toFixed(2)} to trips`);
            if (amountToCredit > 0) details.push(`${amountToCredit.toFixed(2)} to ${CreditHead}`);
            if (excessAmount > 0) details.push(`${excessAmount.toFixed(2)} to advance balance`);

            if (details.length > 0) {
                responseMessage += ` Applied: ${details.join(', ')}.`;
            }

            return res.json({
                message: responseMessage,
                transactionID: transactionID,
                paymentID: paymentID,
                accountBalance: currentBalance - Amount,
                details: {
                    amountAppliedToPreviousDues,
                    amountAppliedToTrips,
                    amountToCredit,
                    excessAmount,
                    newDepoBalance,
                    newDepoSpecialCredit
                }
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error adding payment:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message,
            sqlMessage: err.sqlMessage
        });
    }
};

exports.addPayment = async (req, res) => {
    try {
        const {
            AccountID,
            DepoID,
            Amount,
            CreditHead,
            PaymentMode,
            ReferenceNo,
            isFine,
            IsFine,
        } = req.body;
        const createdBy = resolveAuditUser(req.body);
        const fineSelected = isFine === true || isFine === 'true' || IsFine === true || IsFine === 'true';

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
        if (!CreditHead || CreditHead == '') {
            return res.status(400).json({ message: 'Credit Head is required.' });
        }

        // ✅ FIX 1: Define creditHeadLower early
        const creditHeadLower = CreditHead.toLowerCase();

        const connection = await db.getConnection();

        try {
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

            // Handle Fine Payment separately
            if (fineSelected) {
                return await handleFinePaymentFromBank(connection, {
                    AccountID,
                    DepoID,
                    Amount,
                    PaymentMode,
                    ReferenceNo,
                    createdBy,
                    currentBalance
                }, res);
            }

            // 1. Get depo details
            const [depoRows] = await connection.execute(
                `SELECT 
                    d.id,
                    d.name, 
                    d.Balance,
                    d.previous_payables,
                    d.special_credit_limit
                 FROM depo d
                 WHERE d.id = ? AND d.active = 1`,
                [DepoID]
            );

            if (depoRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Depo not found or inactive' });
            }

            const depo = depoRows[0];
            const depoName = depo.name || `Depo ${DepoID}`;
            const totalPaymentAmount = parseFloat(Amount);
            let remainingAmount = totalPaymentAmount;
            let amountAppliedToPreviousDues = 0;
            let amountAppliedToTrips = 0;
            let selectedTripId = null;
            let hasTripPayment = false;

            // ============================================================
            // STEP 1: Deduct from previous_payables (FIFO)
            // ============================================================
            const currentPreviousPayables = parseFloat(depo.previous_payables || 0);
            if (currentPreviousPayables > 0 && remainingAmount > 0) {
                amountAppliedToPreviousDues = Math.min(remainingAmount, currentPreviousPayables);
                const newPreviousPayables = currentPreviousPayables - amountAppliedToPreviousDues;

                await connection.execute(
                    'UPDATE depo SET previous_payables = ?, MD = NOW() WHERE id = ?',
                    [newPreviousPayables, DepoID]
                );

                remainingAmount -= amountAppliedToPreviousDues;
                console.log(`[Bank Payment] ✅ Previous Payables Cleared: ${amountAppliedToPreviousDues}. Remaining: ${remainingAmount}`);
            }

            // ============================================================
            // STEP 2: Fetch trips with balance for this depo (FIFO)
            // ============================================================
            if (remainingAmount > 0) {
                const [tripsWithBalance] = await connection.execute(
                    `SELECT 
                        t.id as trip_id,
                        t.trip_no,
                        td.id as trip_depo_id,
                        td.depo_id,
                        td.payable_amount,
                        td.paid_amount,
                        (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining,
                        td.purchase_type
                     FROM trips t
                     INNER JOIN trip_depos td ON td.trip_id = t.id AND td.depo_id = ? AND td.Active = 1
                     WHERE t.status != 'Cancelled'
                       AND t.Active = 1
                       AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                     ORDER BY t.start_date ASC, t.id ASC
                     LIMIT 1`,
                    [DepoID]
                );

                if (tripsWithBalance.length > 0) {
                    const trip = tripsWithBalance[0];
                    const tripRemaining = parseFloat(trip.remaining) || 0;
                    const paymentToApply = Math.min(remainingAmount, tripRemaining);

                    selectedTripId = trip.trip_id;
                    hasTripPayment = true;

                    // Update trip_depos paid_amount
                    const newPaidAmount = parseFloat(trip.paid_amount || 0) + paymentToApply;
                    await connection.execute(
                        `UPDATE trip_depos 
                         SET paid_amount = ?, MD = NOW()
                         WHERE id = ?`,
                        [newPaidAmount, trip.trip_depo_id]
                    );

                    // Update trips paid amount
                    const [tripDeposSum] = await connection.execute(
                        `SELECT COALESCE(SUM(paid_amount), 0) as total_paid
                         FROM trip_depos
                         WHERE trip_id = ? AND Active = 1`,
                        [trip.trip_id]
                    );
                    await connection.execute(
                        `UPDATE trips SET paid = ?, MD = NOW() WHERE id = ?`,
                        [parseFloat(tripDeposSum[0]?.total_paid || 0), trip.trip_id]
                    );

                    amountAppliedToTrips = paymentToApply;
                    remainingAmount -= paymentToApply;

                    // Check if trip should be closed
                    await checkAndCloseTrip(connection, trip.trip_id);

                    console.log(`[Bank Payment] ✅ Applied ${paymentToApply} to trip ${trip.trip_no}. Remaining: ${remainingAmount}`);
                } else {
                    console.log(`[Bank Payment] No trips with balance found for depo ${DepoID}`);
                }
            }

            // ============================================================
            // STEP 2.5: If no previous payables and no trips, handle payment
            // ============================================================
            if (remainingAmount > 0 && amountAppliedToPreviousDues === 0 && amountAppliedToTrips === 0) {
                // No previous payables and no trips with balance

                if (creditHeadLower === 'credit') {
                    console.log('[Bank Payment] Adding to regular credit limit (no trips available)');

                    const [openingRows] = await connection.execute(
                        `SELECT Credit as opening_balance
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

                    const openingBalance = openingRows.length > 0
                        ? parseFloat(openingRows[0].opening_balance || 0)
                        : 0;

                    const [currentLimitRows] = await connection.execute(
                        `SELECT DepoLimit 
                         FROM pool 
                         WHERE DepoID = ? AND active = 1 
                         ORDER BY ID DESC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const currentDepoLimit = currentLimitRows.length > 0
                        ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                        : 0;

                    console.log(`[Bank Payment] Opening Balance: ${openingBalance}`);
                    console.log(`[Bank Payment] Current Limit: ${currentDepoLimit}`);
                    console.log(`[Bank Payment] Amount to Credit: ${remainingAmount}`);

                    // ✅ Update depo balance
                    const newDepoBalance = parseFloat(depo.Balance || 0) + remainingAmount;
                    await connection.execute(
                        `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                        [newDepoBalance, DepoID]
                    );

                    // Insert into pool with payment_id = NULL
                    await connection.execute(
                        `INSERT INTO pool (
                            DepoID, 
                            TripID, 
                            payment_id, 
                            recovery_id, 
                            Debit, 
                            Credit, 
                            DepoLimit, 
                            Date, 
                            MD, 
                            CD, 
                            CB, 
                            Active
                        ) VALUES (?, ?, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, null, remainingAmount, currentDepoLimit + remainingAmount, createdBy]
                    );

                    console.log(`[Bank Payment] ✅ Credited ${remainingAmount} to pool (no trip). New limit: ${currentDepoLimit + remainingAmount}`);

                    // ✅ FIX 2: Track as advance and reset remaining
                    amountAppliedToTrips = remainingAmount;
                    hasTripPayment = false;
                    remainingAmount = 0;

                } else if (creditHeadLower === 'specialcredit') {
                    console.log('[Bank Payment] Adding to special credit limit (no trips available)');

                    const [openingRows] = await connection.execute(
                        `SELECT Credit as opening_balance
                         FROM special_credit_limit 
                         WHERE DepoID = ? 
                           AND TripID IS NULL 
                           AND payment_id IS NULL 
                           AND recovery_id IS NULL 
                           AND active = 1 
                         ORDER BY ID ASC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const openingBalance = openingRows.length > 0
                        ? parseFloat(openingRows[0].opening_balance || 0)
                        : 0;

                    const [currentLimitRows] = await connection.execute(
                        `SELECT DepoLimit 
                         FROM special_credit_limit 
                         WHERE DepoID = ? AND active = 1 
                         ORDER BY ID DESC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const currentDepoLimit = currentLimitRows.length > 0
                        ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                        : 0;

                    console.log(`[Bank Payment] Opening Balance: ${openingBalance}`);
                    console.log(`[Bank Payment] Current Limit: ${currentDepoLimit}`);
                    console.log(`[Bank Payment] Amount to Credit: ${remainingAmount}`);

                    // ✅ Update depo special credit
                    const newDepoSpecialCredit = parseFloat(depo.special_credit_limit || 0) + remainingAmount;
                    await connection.execute(
                        `UPDATE depo SET special_credit_limit = ?, MD = NOW() WHERE id = ?`,
                        [newDepoSpecialCredit, DepoID]
                    );

                    // Insert into special_credit_limit with payment_id = NULL
                    await connection.execute(
                        `INSERT INTO special_credit_limit (
                            DepoID, 
                            TripID, 
                            payment_id, 
                            recovery_id, 
                            Debit, 
                            Credit, 
                            DepoLimit, 
                            Date, 
                            MD, 
                            CD, 
                            CB, 
                            Active
                        ) VALUES (?, ?, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, null, remainingAmount, currentDepoLimit + remainingAmount, createdBy]
                    );

                    console.log(`[Bank Payment] ✅ Credited ${remainingAmount} to special_credit_limit (no trip). New limit: ${currentDepoLimit + remainingAmount}`);

                    // ✅ FIX 2: Track as advance and reset remaining
                    amountAppliedToTrips = remainingAmount;
                    hasTripPayment = false;
                    remainingAmount = 0;

                } else if (creditHeadLower === 'cash') {
                    console.log('[Bank Payment] Adding to advance balance (no trips available)');

                    const [lastAdvanceRows] = await connection.execute(
                        `SELECT Balance FROM advance_balance 
                         WHERE DepoID = ? AND Active = 1 
                         ORDER BY ID DESC LIMIT 1`,
                        [DepoID]
                    );
                    const currentAdvanceBalance = lastAdvanceRows.length > 0
                        ? parseFloat(lastAdvanceRows[0].Balance || 0)
                        : 0;
                    const newAdvanceBalance = currentAdvanceBalance + remainingAmount;

                    await connection.execute(
                        `INSERT INTO advance_balance (
                            DepoID, 
                            TripID, 
                            recovery_id, 
                            payment_id, 
                            Debit, 
                            Credit, 
                            Balance, 
                            Date, 
                            MD, 
                            CD, 
                            CB, 
                            Active
                        ) VALUES (?, ?, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, null, remainingAmount, newAdvanceBalance, createdBy]
                    );

                    console.log(`[Bank Payment] ✅ Added ${remainingAmount} to advance_balance (no trips available). New balance: ${newAdvanceBalance}`);

                    // Track as advance and reset remaining
                    amountAppliedToTrips = remainingAmount;
                    hasTripPayment = false;
                    remainingAmount = 0;
                }
            }

            // ============================================================
            // STEP 3: Update Account balance (debit - money going out)
            // ============================================================
            await connection.execute(
                `UPDATE accounts 
                 SET Balance = Balance - ?, 
                     MB = ?,
                     MD = NOW()
                 WHERE ID = ? AND active = 1`,
                [totalPaymentAmount, createdBy, AccountID]
            );

            // ============================================================
            // STEP 4: Create transaction entry with detailed purpose
            // ============================================================
            let transactionPurpose = `Payment to ${depoName}`;
            const details = [];
            if (amountAppliedToPreviousDues > 0) {
                details.push(`Previous Payables Cleared: ${amountAppliedToPreviousDues}`);
            }
            if (amountAppliedToTrips > 0 && hasTripPayment) {
                details.push(`Trip Payment: ${amountAppliedToTrips}`);
            }
            if (amountAppliedToTrips > 0 && !hasTripPayment) {
                details.push(`Advance Payment: ${amountAppliedToTrips}`);
            }

            if (details.length > 0) {
                transactionPurpose += ` - ${details.join(', ')}`;
            }

            const transactionTripId = hasTripPayment ? selectedTripId : null;

            const [transactionResult] = await connection.execute(
                `INSERT INTO transactions (
                    AccountID, 
                    trip_id,
                    Purpose, 
                    Debit, 
                    Credit, 
                    Date, 
                    PaymentMode, 
                    ReferenceNo, 
                    CB, 
                    active
                ) VALUES (?, ?, ?, ?, 0, NOW(), ?, ?, ?, 1)`,
                [AccountID, transactionTripId, transactionPurpose, totalPaymentAmount, PaymentMode, ReferenceNo || null, createdBy]
            );
            const transactionID = transactionResult.insertId;

            // ============================================================
            // STEP 5: Create payment record (ONLY if there was a trip payment)
            // ============================================================
            let paymentID = null;
            if (hasTripPayment) {
                const paymentTripId = selectedTripId;
                const [paymentResult] = await connection.execute(
                    `INSERT INTO payments (
                        transactionID, 
                        DepoID, 
                        trip_id, 
                        Amount, 
                        Date, 
                        CB, 
                        active
                    ) VALUES (?, ?, ?, ?, NOW(), ?, 1)`,
                    [transactionID, DepoID, paymentTripId, totalPaymentAmount, createdBy]
                );
                paymentID = paymentResult.insertId;
            }

            // ============================================================
            // STEP 6: Credit trip payment amount to depo's credit limit
            // ✅ FIX: Only process if there was an actual trip payment
            // ============================================================
            let amountToCredit = 0;
            let excessAmount = 0;

            if (hasTripPayment && amountAppliedToTrips > 0) {
                // Only proceed if there was a trip payment
                amountToCredit = amountAppliedToTrips;

                if (creditHeadLower === 'credit') {
                    console.log('[Bank Payment] Crediting trip payment to regular credit limit');

                    const [openingRows] = await connection.execute(
                        `SELECT Credit as opening_balance
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

                    const openingBalance = openingRows.length > 0
                        ? parseFloat(openingRows[0].opening_balance || 0)
                        : 0;

                    const [currentLimitRows] = await connection.execute(
                        `SELECT DepoLimit 
                         FROM pool 
                         WHERE DepoID = ? AND active = 1 
                         ORDER BY ID DESC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const currentDepoLimit = currentLimitRows.length > 0
                        ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                        : 0;

                    const availableSpace = Math.max(0, openingBalance - currentDepoLimit);

                    if (amountToCredit > availableSpace) {
                        excessAmount = amountToCredit - availableSpace;
                        amountToCredit = availableSpace;
                    }

                    console.log(`[Bank Payment] Trip Payment Amount: ${amountAppliedToTrips}`);
                    console.log(`[Bank Payment] Opening Balance: ${openingBalance}`);
                    console.log(`[Bank Payment] Current Limit: ${currentDepoLimit}`);
                    console.log(`[Bank Payment] Available Space: ${availableSpace}`);
                    console.log(`[Bank Payment] Amount to Credit: ${amountToCredit}`);
                    console.log(`[Bank Payment] Excess to Advance: ${excessAmount}`);

                    if (amountToCredit > 0) {
                        const newDepoLimit = currentDepoLimit + amountToCredit;
                        await connection.execute(
                            `INSERT INTO pool (
                                DepoID, 
                                TripID, 
                                payment_id, 
                                recovery_id, 
                                Debit, 
                                Credit, 
                                DepoLimit, 
                                Date, 
                                MD, 
                                CD, 
                                CB, 
                                Active
                            ) VALUES (?, ?, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                            [DepoID, selectedTripId, paymentID, amountToCredit, newDepoLimit, createdBy]
                        );
                        console.log(`[Bank Payment] ✅ Credited ${amountToCredit} to pool. New limit: ${newDepoLimit}`);
                    }

                } else if (creditHeadLower === 'specialcredit') {
                    console.log('[Bank Payment] Crediting trip payment to special credit limit');

                    const [openingRows] = await connection.execute(
                        `SELECT Credit as opening_balance
                         FROM special_credit_limit 
                         WHERE DepoID = ? 
                           AND TripID IS NULL 
                           AND payment_id IS NULL 
                           AND recovery_id IS NULL 
                           AND active = 1 
                         ORDER BY ID ASC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const openingBalance = openingRows.length > 0
                        ? parseFloat(openingRows[0].opening_balance || 0)
                        : 0;

                    const [currentLimitRows] = await connection.execute(
                        `SELECT DepoLimit 
                         FROM special_credit_limit 
                         WHERE DepoID = ? AND active = 1 
                         ORDER BY ID DESC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const currentDepoLimit = currentLimitRows.length > 0
                        ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                        : 0;

                    const availableSpace = Math.max(0, openingBalance - currentDepoLimit);

                    if (amountToCredit > availableSpace) {
                        excessAmount = amountToCredit - availableSpace;
                        amountToCredit = availableSpace;
                    }

                    console.log(`[Bank Payment] Trip Payment Amount: ${amountAppliedToTrips}`);
                    console.log(`[Bank Payment] Opening Balance: ${openingBalance}`);
                    console.log(`[Bank Payment] Current Limit: ${currentDepoLimit}`);
                    console.log(`[Bank Payment] Available Space: ${availableSpace}`);
                    console.log(`[Bank Payment] Amount to Credit: ${amountToCredit}`);
                    console.log(`[Bank Payment] Excess to Advance: ${excessAmount}`);

                    if (amountToCredit > 0) {
                        const newDepoLimit = currentDepoLimit + amountToCredit;
                        await connection.execute(
                            `INSERT INTO special_credit_limit (
                                DepoID, 
                                TripID, 
                                payment_id, 
                                recovery_id, 
                                Debit, 
                                Credit, 
                                DepoLimit, 
                                Date, 
                                MD, 
                                CD, 
                                CB, 
                                Active
                            ) VALUES (?, ?, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                            [DepoID, selectedTripId, paymentID, amountToCredit, newDepoLimit, createdBy]
                        );
                        console.log(`[Bank Payment] ✅ Credited ${amountToCredit} to special_credit_limit. New limit: ${newDepoLimit}`);
                    }
                }
            } else {
                console.log(`[Bank Payment] No trip payment to credit. Amount applied: Previous Payables: ${amountAppliedToPreviousDues}, Advance: ${!hasTripPayment ? amountAppliedToTrips : 0}`);
            }

            // ============================================================
            // STEP 7: Add excess to advance_balance (only if from trip payment)
            // ============================================================
            if (excessAmount > 0 && hasTripPayment) {
                const [lastAdvanceRows] = await connection.execute(
                    `SELECT Balance FROM advance_balance 
                     WHERE DepoID = ? AND Active = 1 
                     ORDER BY ID DESC LIMIT 1`,
                    [DepoID]
                );
                const currentAdvanceBalance = lastAdvanceRows.length > 0
                    ? parseFloat(lastAdvanceRows[0].Balance || 0)
                    : 0;
                const newAdvanceBalance = currentAdvanceBalance + excessAmount;

                await connection.execute(
                    `INSERT INTO advance_balance (
                        DepoID, 
                        TripID, 
                        recovery_id, 
                        payment_id, 
                        Debit, 
                        Credit, 
                        Balance, 
                        Date, 
                        MD, 
                        CD, 
                        CB, 
                        Active
                    ) VALUES (?, ?, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                    [DepoID, selectedTripId, paymentID, excessAmount, newAdvanceBalance, createdBy]
                );
                console.log(`[Bank Payment] ✅ Added ${excessAmount} to advance_balance. New balance: ${newAdvanceBalance}`);
            }

            // ============================================================
            // STEP 8: Update depo balance (ONLY for trip payments)
            // ✅ FIX: Skip if no trip payment (already updated in STEP 2.5)
            // ============================================================
            if (hasTripPayment && amountToCredit > 0) {
                let newDepoBalance = parseFloat(depo.Balance || 0);
                let newDepoSpecialCredit = parseFloat(depo.special_credit_limit || 0);

                if (creditHeadLower === 'credit') {
                    newDepoBalance = newDepoBalance + amountToCredit;
                    await connection.execute(
                        `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                        [newDepoBalance, DepoID]
                    );
                    console.log(`[Bank Payment] ✅ Updated depo Balance to ${newDepoBalance}`);
                } else if (creditHeadLower === 'specialcredit') {
                    newDepoSpecialCredit = newDepoSpecialCredit + amountToCredit;
                    await connection.execute(
                        `UPDATE depo SET special_credit_limit = ?, MD = NOW() WHERE id = ?`,
                        [newDepoSpecialCredit, DepoID]
                    );
                    console.log(`[Bank Payment] ✅ Updated depo special_credit_limit to ${newDepoSpecialCredit}`);
                }
            }

            await connection.commit();
            connection.release();

            // Build response message
            let responseMessage = 'Bank payment added successfully.';
            const responseDetails = [];
            if (amountAppliedToPreviousDues > 0) {
                responseDetails.push(`Previous Payables Cleared: ${amountAppliedToPreviousDues}`);
            }
            if (amountAppliedToTrips > 0 && hasTripPayment) {
                responseDetails.push(`Trip Payment: ${amountAppliedToTrips}`);
            }
            if (amountAppliedToTrips > 0 && !hasTripPayment) {
                responseDetails.push(`Advance Payment: ${amountAppliedToTrips}`);
            }
            if (amountToCredit > 0 && hasTripPayment) {
                responseDetails.push(`Credit to ${CreditHead}: ${amountToCredit}`);
            }
            if (excessAmount > 0 && hasTripPayment) {
                responseDetails.push(`Advance Balance: ${excessAmount}`);
            }

            if (responseDetails.length > 0) {
                responseMessage += ` Applied: ${responseDetails.join(', ')}.`;
            }

            return res.json({
                message: responseMessage,
                transactionID: transactionID,
                paymentID: paymentID,
                accountBalance: currentBalance - totalPaymentAmount,
                tripId: hasTripPayment ? selectedTripId : null,
                details: {
                    amountAppliedToPreviousDues,
                    amountAppliedToTrips,
                    amountToCredit: hasTripPayment ? amountToCredit : 0,
                    excessAmount: hasTripPayment ? excessAmount : 0,
                    newDepoBalance: hasTripPayment ? parseFloat(depo.Balance || 0) + (hasTripPayment ? amountToCredit : 0) : parseFloat(depo.Balance || 0),
                    newDepoSpecialCredit: hasTripPayment ? parseFloat(depo.special_credit_limit || 0) + (creditHeadLower === 'specialcredit' && hasTripPayment ? amountToCredit : 0) : parseFloat(depo.special_credit_limit || 0),
                    hasTripPayment,
                    previousPayablesCleared: amountAppliedToPreviousDues > 0
                }
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error adding payment:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message,
            sqlMessage: err.sqlMessage
        });
    }
};

// Helper function for Fine Payment from Bank
const handleFinePaymentFromBank = async (connection, params, res) => {
    try {
        const {
            AccountID,
            DepoID,
            Amount,
            PaymentMode,
            ReferenceNo,
            createdBy,
            currentBalance
        } = params;

        // Create transaction for fine
        const transactionPurpose = `Fine Payment to Depo ${DepoID}`;

        const [transactionResult] = await connection.execute(
            `INSERT INTO transactions (
                AccountID, Purpose, Debit, Credit, Date, 
                PaymentMode, ReferenceNo, trip_id, CB, active
            ) VALUES (?, ?, ?, 0, NOW(), ?, ?, NULL, ?, 1)`,
            [AccountID, transactionPurpose, Amount, PaymentMode, ReferenceNo || null, createdBy]
        );

        const transactionID = transactionResult.insertId;

        // Create payment record for fine
        const [paymentResult] = await connection.execute(
            `INSERT INTO payments (
                transactionID, DepoID, trip_id, Amount, 
                Date, CB, isFine, active
            ) VALUES (?, ?, NULL, ?, NOW(), ?, 1, 1)`,
            [transactionID, DepoID, Amount, createdBy]
        );

        // Update account balance
        await connection.execute(
            `UPDATE accounts 
             SET Balance = Balance - ?, 
                 MB = ?,
                 MD = NOW()
             WHERE ID = ? AND active = 1`,
            [Amount, createdBy, AccountID]
        );

        await connection.commit();
        connection.release();

        return res.json({
            message: 'Fine payment added successfully',
            transactionID,
            paymentID: paymentResult.insertId
        });

    } catch (err) {
        await connection.rollback();
        connection.release();
        throw err;
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

        const auditUser = resolveAuditUser(req.body);

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
                            CB,
                            MB,
                            Active
                        ) VALUES (?, 0, ?, ?, NOW(), ?, ?, 1)
                    `;

                    const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                        Amount,
                        newCashBalance,
                        cashPurpose,
                        auditUser,
                        auditUser
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
                        'UPDATE accounts SET Balance = ?, MB = ?, MD = NOW() WHERE ID = ?',
                        [newAccountBalance, auditUser, AccountID]
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
                        'UPDATE accounts SET Balance = ?, MB = ?, MD = NOW() WHERE ID = ?',
                        [newSourceBalance, auditUser, SourceAccountID]
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
                        'UPDATE accounts SET Balance = ?, MB = ?, MD = NOW() WHERE ID = ?',
                        [newAccountBalance, auditUser, AccountID]
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
                        'UPDATE accounts SET Balance = ?, MB = ?, MD = NOW() WHERE ID = ?',
                        [newAccountBalance, auditUser, AccountID]
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
                            CB,
                            MB,
                            Active
                        ) VALUES (0, ?, ?, ?, NOW(), ?, ?, 1)
                    `;

                    const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                        Amount,
                        newCashBalance,
                        cashPurpose,
                        auditUser,
                        auditUser
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
                        'UPDATE accounts SET Balance = ?, MB = ?, MD = NOW() WHERE ID = ?',
                        [newAccountBalance, auditUser, AccountID]
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
                        'UPDATE accounts SET Balance = ?, MB = ?, MD = NOW() WHERE ID = ?',
                        [newDestBalance, auditUser, DestinationAccountID]
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
exports._addCashInHandPayment = async (req, res) => {
    try {
        const {
            DepoID,
            Amount,
            CreditHead,
            TripID,
            TripNo,
            IsFine
        } = req.body;
        const createdBy = resolveAuditUser(req.body);


        // Validation
        if (!DepoID) {
            return res.status(400).json({ message: 'Dealer ID is required' });
        }
        if (!Amount || Amount <= 0) {
            return res.status(400).json({ message: 'Amount is required and must be greater than 0' });
        }

        if (!CreditHead || CreditHead == '') {
            return res.status(400).json({ message: 'Credit Head is required.' });
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

            if (IsFine === true || IsFine === 'true') {
                const finePurpose = `Fine Payment to Depo ${DepoID}`;
                const newBalance = currentBalance - Amount;

                const cashInHandQuery = `
                    INSERT INTO cash_in_hand (
                        debit,
                        credit,
                        balance,
                        purpose,
                        created_at,
                        CB,
                        MB,
                        Active
                    ) VALUES (?, 0, ?, ?, NOW(), ?, ?, 1)
                `;

                const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                    Amount,
                    newBalance,
                    finePurpose,
                    createdBy,
                    createdBy
                ]);

                const cashInHandId = cashInHandResult.insertId;

                const transactionQuery = `
                    INSERT INTO transactions (
                        cash_in_hand_id,
                        Purpose,
                        Debit,
                        Credit,
                        Date,
                        PaymentMode,
                        trip_id,
                        CB,
                        active
                    ) VALUES (?, ?, ?, 0, NOW(), 'Cash', NULL, ?, 1)
                `;

                const [transactionResult] = await connection.execute(transactionQuery, [
                    cashInHandId,
                    finePurpose,
                    Amount,
                    createdBy
                ]);

                const transactionID = transactionResult.insertId;

                const paymentQuery = `
                    INSERT INTO payments (
                        transactionID,
                        DepoID,
                        trip_id,
                        Amount,
                        Date,
                        CB,
                        isFine,
                        active
                    ) VALUES (?, ?, NULL, ?, NOW(), ?, ?, 1)
                `;

                const [paymentResult] = await connection.execute(paymentQuery, [
                    transactionID,
                    DepoID,
                    Amount,
                    createdBy,
                    1
                ]);

                await connection.commit();
                connection.release();

                return res.json({
                    message: 'Fine cash payment added successfully',
                    transactionID,
                    paymentID: paymentResult.insertId,
                    cashInHandId
                });
            }
            // STEP 1: First, deduct from previous_payables in depo table
            // Get depo's current previous_payables
            const [depoRows] = await connection.execute(
                `SELECT 
                    d.id,
                    d.name, 
                    d.Balance,
                    d.previous_payables,
                    (
                        SELECT COALESCE(ab.Balance, 0)
                        FROM advance_balance ab
                        WHERE ab.DepoID = d.id AND ab.Active = 1
                        ORDER BY ab.ID DESC
                        LIMIT 1
                    ) as advance_balance
                 FROM depo d
                 WHERE d.id = ? AND d.active = 1`,
                [DepoID]
            );

            if (depoRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Depo not found or inactive' });
            }

            const depo = depoRows[0];
            const depoName = depo.name || `Depo ${DepoID}`;
            const currentDepoBalance = parseFloat(depo.Balance || 0);
            const currentAdvanceBalance = parseFloat(depo.advance_balance || 0);
            const currentPreviousPayables = parseFloat(depo.previous_payables || 0) || 0;
            const paymentAmount = parseFloat(Amount);
            let remainingPaymentAmount = paymentAmount;
            let amountDeductedFromPreviousPayables = 0;

            console.log(`[Cash Payment] Depo ${DepoID} (${depoName}) - Current previous_payables: ${currentPreviousPayables}, Payment Amount: ${paymentAmount}`);

            // Deduct from previous_payables first
            if (currentPreviousPayables > 0 && remainingPaymentAmount > 0) {
                if (remainingPaymentAmount <= currentPreviousPayables) {
                    // Payment amount is less than or equal to previous_payables
                    // Deduct all payment amount from previous_payables
                    amountDeductedFromPreviousPayables = remainingPaymentAmount;
                    const newPreviousPayables = currentPreviousPayables - remainingPaymentAmount;

                    const [updateResult] = await connection.execute(
                        'UPDATE depo SET previous_payables = ?, MD = NOW() WHERE id = ?',
                        [newPreviousPayables, DepoID]
                    );

                    if (updateResult.affectedRows === 0) {
                        console.error(`[Cash Payment] Failed to update previous_payables for depo ${DepoID}`);
                    } else {
                        console.log(`[Cash Payment] Successfully deducted ${amountDeductedFromPreviousPayables} from previous_payables for depo ${DepoID}. Old: ${currentPreviousPayables}, New: ${newPreviousPayables}`);
                    }

                    remainingPaymentAmount = 0; // No amount left for trip payments
                } else {
                    // Payment amount exceeds previous_payables
                    // Deduct all previous_payables (set to 0)
                    amountDeductedFromPreviousPayables = currentPreviousPayables;
                    remainingPaymentAmount = remainingPaymentAmount - currentPreviousPayables;

                    const [updateResult] = await connection.execute(
                        'UPDATE depo SET previous_payables = 0, MD = NOW() WHERE id = ?',
                        [DepoID]
                    );

                    if (updateResult.affectedRows === 0) {
                        console.error(`[Cash Payment] Failed to update previous_payables to 0 for depo ${DepoID}`);
                    } else {
                        console.log(`[Cash Payment] Successfully deducted all previous_payables (${amountDeductedFromPreviousPayables}) for depo ${DepoID}. Remaining payment amount: ${remainingPaymentAmount}`);
                    }
                }
            } else if (currentPreviousPayables === 0 && remainingPaymentAmount > 0) {
                console.log(`[Cash Payment] Depo ${DepoID} has no previous_payables (0). All payment amount (${remainingPaymentAmount}) will be applied to trip payments.`);
            } else if (remainingPaymentAmount === 0) {
                console.log(`[Cash Payment] Payment amount is 0, nothing to process.`);
            }

            if (CreditHead == 'credit') {
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
            }

            if (CreditHead == 'specialcredit') {
                // Get initial balance limit from pool table (first entry with NULL tripID, payment_id, recovery_id)
                const [initialBalanceRows] = await connection.execute(
                    `SELECT Credit as initial_balance
                 FROM special_credit_limit 
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
            }
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
            // Use remainingPaymentAmount (after previous_payables deduction) for advance payment processing
            if (remainingBalance === 0) {
                // Advance payment: Add remaining amount to advance_balance table (after previous_payables deduction)

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
                // Use remainingPaymentAmount (after previous_payables deduction) for advance balance
                const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + remainingPaymentAmount;

                if (amountDeductedFromPreviousPayables > 0) {
                    console.log(`[Cash Payment] Deducted ${amountDeductedFromPreviousPayables} from previous_payables for advance payment. Remaining ${remainingPaymentAmount} added to advance_balance.`);
                }

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
                    `INSERT INTO cash_in_hand (debit, credit, balance, purpose, created_at, CB, MB, active)
                     VALUES (?, 0, ?, ?, NOW(), ?, ?, 1)`,
                    [Amount, newCashBalance, `Advance Payment to ${depoName}`, createdBy, createdBy]
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
                        CB,
                        active
                    ) VALUES (?, ?, ?, 0, NOW(), ?, 1)
                `;

                const [transactionResult] = await connection.execute(transactionQuery, [
                    cashInHandId,
                    `Advance Payment to ${depoName}`,
                    Amount,
                    createdBy
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
                        CB,
                        active
                    ) VALUES (?, ?, NULL, ?, NOW(), ?, 1)
                `;

                const [paymentResult] = await connection.execute(paymentQuery, [
                    transactionID,
                    DepoID,
                    Amount,
                    createdBy
                ]);

                const paymentID = paymentResult.insertId;

                // Insert Credit entry to advance_balance table (only if there's remaining amount after previous_payables)
                if (remainingPaymentAmount > 0) {
                    await connection.execute(
                        `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, paymentID, remainingPaymentAmount, newAdvanceBalanceInTable, 'admin@gmail.com']
                    );
                    console.log(`Added advance_balance entry for advance payment: Credit=${remainingPaymentAmount}, New Balance=${newAdvanceBalanceInTable}`);
                } else {
                    console.log(`No advance_balance entry needed - all payment (${Amount}) was applied to previous_payables.`);
                }

                await connection.commit();
                connection.release();

                return res.json({
                    message: 'Advance payment added successfully',
                    transactionID: transactionID,
                    paymentID: paymentResult.insertId,
                    cashInHandId: cashInHandId,
                    advanceBalance: newAdvanceBalanceInTable
                });


                // Handle payment: Use remainingPaymentAmount (after previous_payables deduction)
                // remainingPaymentAmount can exceed remainingBalance, excess goes to advance_balance
                const amountToApplyToTrips = Math.min(remainingPaymentAmount, remainingBalance);
                const excessAmount = Math.max(0, remainingPaymentAmount - remainingBalance);

                // Get current pool balance (actual credit limit from pool table)
                const [currentPoolRows] = await connection.execute(
                    `SELECT DepoLimit FROM special_credit_limit WHERE DepoID = ? AND active = 1 ORDER BY ID DESC LIMIT 1`,
                    [DepoID]
                );
                let currentPoolBalance = currentPoolRows.length > 0
                    ? parseFloat(currentPoolRows[0].DepoLimit || 0)
                    : currentDepoBalance;

                // Payment allocation logic (CORRECT ORDER):
                // 1. FIRST: Pay off trips (Amount Payable) - clear the payable amount
                // 2. SECOND: If amount remains, restore/add to credit limit (pool)
                // 3. THIRD: If amount still remains, go to advance balance

                let remainingPayment = amountToApplyToTrips;
                let amountToTrips = 0;
                let amountToRestorePool = 0;
                let amountToPool = 0;
                let amountToAdvanceBalance = 0;

                // Step 1: FIRST - Pay off trips (Amount Payable)
                // All payment goes to trips first
                amountToTrips = remainingPayment;
                remainingPayment = 0; // All payment is allocated to trips

                // Step 2: SECOND - Calculate restore/add-to-pool AFTER trips (if there's remaining payment)
                // Since all payment goes to trips, these will be 0
                // This is calculated later after trip payments are processed

                // Step 3: THIRD - Any remaining goes to advance_balance
                // Also add excess amount (if payment exceeds remainingBalance) to advance_balance
                amountToAdvanceBalance = excessAmount;

                // For now, newPoolBalance is just currentPoolBalance
                // It will be updated after trip payments are processed
                let newPoolBalance = currentPoolBalance;
                let newDepoBalance = currentDepoBalance;

                /* console.log(`[Cash Payment] Total Amount: ${Amount}, Remaining Balance for trips: ${remainingBalance}, Excess Amount: ${excessAmount}`);
                console.log(`[Cash Payment] Current Pool Balance: ${currentPoolBalance}`);
                console.log(`[Cash Payment] Initial Balance Limit: ${initialBalance}`);
                console.log(`[Cash Payment] Amount to trips: ${amountToTrips}`);
                console.log(`[Cash Payment] Amount to restore pool: ${amountToRestorePool} (will be calculated after trips)`);
                console.log(`[Cash Payment] Amount to pool: ${amountToPool} (will be calculated after trips)`);
                console.log(`[Cash Payment] Amount to advance_balance: ${amountToAdvanceBalance}`);
                console.log(`[Cash Payment] Starting pool balance: ${currentPoolBalance} (will be updated after trip payments)`); */

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
                    created_at,
                    CB,
                    MB
                ) VALUES (?, 0, ?, ?, NOW(), ?, ?)
            `;

                const [_cashInHandResult] = await connection.execute(cashInHandQuery, [
                    Amount,  // Debit amount (subtracts from balance when paying out)
                    newBalance,  // New running balance
                    purpose,
                    createdBy,
                    createdBy
                ]);

                const _cashInHandId = _cashInHandResult.insertId;

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

                // Create ONE main transaction with FULL payment amount
                const transactionPurpose = `${tripNo ? `Payment for ${tripNo}` : `Payment to ${depoName}`}${amountDeductedFromPreviousPayables > 0 ? ` (${amountDeductedFromPreviousPayables} applied to previous payables, ${remainingPaymentAmount} to trips/advance)` : ''}`;
                const mainTransactionQuery = `
                    INSERT INTO transactions (
                        cash_in_hand_id,
                        Purpose,
                        Debit,
                        Credit,
                        Date,
                        PaymentMode,
                        trip_id,
                    CB,
                        active
                ) VALUES (?, ?, ?, 0, NOW(), 'Cash', NULL, ?, 1)
                `;

                const [mainTransactionResult] = await connection.execute(mainTransactionQuery, [
                    _cashInHandId,
                    transactionPurpose,
                    Amount,  // Record FULL payment amount
                    createdBy
                ]);

                const mainTransactionID = mainTransactionResult.insertId;
                const transactionIds = [mainTransactionID];

                // Create ONE main payment record with FULL payment amount
                const mainPaymentQuery = `
                    INSERT INTO payments (
                        transactionID,
                        DepoID,
                        trip_id,
                        Amount,
                        Date,
                    CB,
                        active
                ) VALUES (?, ?, NULL, ?, NOW(), ?, 1)
                `;

                const [mainPaymentResult] = await connection.execute(mainPaymentQuery, [
                    mainTransactionID,
                    DepoID,
                    Amount,  // Record FULL payment amount
                    createdBy
                ]);

                const mainPaymentID = mainPaymentResult.insertId;
                const paymentIds = [mainPaymentID];

                // 7. Apply payment to trips FIRST - use amountToTrips calculated above
                // CRITICAL: When paying trips, we create pool entries for each trip payment
                // These pool entries reflect the credit being restored as trips are paid
                // Start with current pool balance for calculating running balance
                // As we pay trips, the pool balance increases (credit is restored)
                // CRITICAL: Use the currentPoolBalance read from the pool table at the start
                // This is the balance BEFORE any payment processing
                let runningPoolBalance = currentPoolBalance;

                console.log(`[Cash Payment] Starting trip payment processing:`);
                console.log(`[Cash Payment]   Current special credit limit balance (from DB): ${currentPoolBalance}`);
                console.log(`[Cash Payment]   Amount to trips: ${amountToTrips}`);
                console.log(`[Cash Payment]   Starting runningPoolBalance: ${runningPoolBalance}`);

                // Reset remainingPayment to amountToTrips for trip application
                remainingPayment = amountToTrips;

                // Apply payment to trips in order (oldest first)
                for (const trip of tripsWithBalance) {
                    if (remainingPayment <= 0) break;

                    const payableAmount = parseFloat(trip.payable_amount) || 0;
                    const currentPaid = parseFloat(trip.paid_amount) || 0;
                    const remaining = parseFloat(trip.remaining) || 0;
                    const tripDepoId = trip.trip_depo_id;

                    // Calculate how much to apply to this trip_depo
                    const paymentToApply = Math.min(remainingPayment, remaining);

                    // Create a NEW pool row for this trip payment
                    // When trips are paid, the pool balance increases (credit is restored)
                    // CRITICAL: Calculate the new balance BEFORE creating the pool entry
                    const newPoolBalanceForTrip = runningPoolBalance + paymentToApply;

                    console.log(`[Cash Payment]   Pool balance calculation: ${runningPoolBalance} + ${paymentToApply} = ${newPoolBalanceForTrip}`);

                    const poolQuery = `
                    INSERT INTO special_credit_limit (
                        DepoID, 
                        TripID,
                        Debit, 
                        Credit, 
                        DepoLimit,
                        payment_id,
                        recovery_id,
                        CB,
                        active
                    ) VALUES (?, ?, 0, ?, ?, ?, NULL, ?, 1)
                `;

                    await connection.execute(poolQuery, [
                        DepoID,
                        trip.id,  // Trip ID for this specific trip
                        paymentToApply,  // Credit = paymentToApply (money received into depo for this trip)
                        newPoolBalanceForTrip,  // New DepoLimit = Previous Pool Balance + Credit
                        mainPaymentID,  // Link to main payment record
                        createdBy
                    ]);

                    // Update running balance for next iteration
                    runningPoolBalance = newPoolBalanceForTrip;

                    console.log(`[Cash Payment]   Created pool entry for trip ${trip.id}: Credit=${paymentToApply}, DepoLimit=${newPoolBalanceForTrip}, Updated runningPoolBalance=${runningPoolBalance}`);

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

                    console.log(`[Cash Payment] Applied payment portion to trip ${trip.id} (trip_depo ${tripDepoId}). Applied ${paymentToApply}, New paid_amount: ${newPaidAmount}, Pool balance: ${runningPoolBalance}, Remaining: ${payableAmount - newPaidAmount}`);
                }

                // Update pool balance after trip payments
                newPoolBalance = runningPoolBalance;
                console.log(`[Cash Payment] Completed trip payments. Final special credit balance balance after trips: ${newPoolBalance}`);

                // 7.5. SECOND - If there's remaining payment after trips, restore/add to pool
                // Calculate remaining payment after trips (should be 0 since all payment goes to trips)
                let remainingAfterTrips = remainingPayment; // This should be 0 after all trips are paid

                if (remainingAfterTrips > 0) {
                    // Step 2a: If pool balance is still negative, restore it
                    if (newPoolBalance < 0) {
                        amountToRestorePool = Math.min(remainingAfterTrips, Math.abs(newPoolBalance));
                        remainingAfterTrips -= amountToRestorePool;
                    }

                    // Step 2b: Add remaining payment to pool up to initial limit
                    if (remainingAfterTrips > 0) {
                        const poolBalanceAfterRestore = newPoolBalance + amountToRestorePool;
                        const poolSpaceAvailable = Math.max(0, initialBalance - poolBalanceAfterRestore);
                        amountToPool = Math.min(remainingAfterTrips, poolSpaceAvailable);
                    }

                    // Create pool entries for restore and add-to-pool amounts
                    let poolBalanceForEntries = newPoolBalance;

                    if (amountToRestorePool > 0) {
                        poolBalanceForEntries += amountToRestorePool;
                        await connection.execute(
                            `INSERT INTO pool (
                            DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CB, active
                        ) VALUES (?, NULL, 0, ?, ?, NULL, NULL, ?, 1)`,
                            [DepoID, amountToRestorePool, poolBalanceForEntries, createdBy]
                        );
                        console.log(`[Cash Payment] Created pool entry for restore: Credit=${amountToRestorePool}, DepoLimit=${poolBalanceForEntries}`);
                    }

                    if (amountToPool > 0) {
                        poolBalanceForEntries += amountToPool;
                        await connection.execute(
                            `INSERT INTO pool (
                            DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CB, active
                        ) VALUES (?, NULL, 0, ?, ?, NULL, NULL, ?, 1)`,
                            [DepoID, amountToPool, poolBalanceForEntries, createdBy]
                        );
                        console.log(`[Cash Payment] Created pool entry for add-to-pool: Credit=${amountToPool}, DepoLimit=${poolBalanceForEntries}`);
                    }

                    newPoolBalance = poolBalanceForEntries;
                }

                // Update depo balance to match the final pool balance
                // The depo table's Balance column should reflect the actual pool balance after all payments
                newDepoBalance = newPoolBalance;
                await connection.execute(
                    `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                    [newDepoBalance, DepoID]
                );
                console.log(`[Cash Payment] Updated depo ${DepoID}: Balance=${newDepoBalance} (from final pool balance)`);

                // 7.6. Handle excess amount (if Amount > remainingBalance)
                // Note: Main transaction and payment already record the full Amount
                // Excess amount just needs to be added to advance_balance
                if (excessAmount > 0) {
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
                    const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + excessAmount;

                    // Insert Credit entry to advance_balance table with main payment_id
                    await connection.execute(
                        `INSERT INTO advance_balance (
                        DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                    ) VALUES (?, NULL, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, mainPaymentID, excessAmount, newAdvanceBalanceInTable, 'admin@gmail.com']
                    );
                    console.log(`Added excess payment to advance_balance: Credit=${excessAmount}, PaymentID=${mainPaymentID}, New Balance=${newAdvanceBalanceInTable}`);
                }

                // 8. Update depo balance (only Balance column, not advance_balance)
                await connection.execute(
                    `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                    [newDepoBalance, DepoID]
                );
                console.log(`Updated depo ${DepoID}: Balance=${newDepoBalance}`);

                // Add advance_balance table entry if there's amount going to advance_balance
                // NOTE: Only create entry if excessAmount is 0 (excessAmount is already handled above)
                // amountToAdvanceBalance is set to excessAmount, so we only need to handle it when excessAmount was 0
                if (amountToAdvanceBalance > 0 && excessAmount === 0) {
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
            }

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({
                message: excessAmount > 0
                    ? `Cash in hand payment added successfully. Applied ${amountToApplyToTrips.toFixed(2)} to trips, ${excessAmount.toFixed(2)} added as advance balance.`
                    : 'Cash in hand payment added successfully',
                transactionIDs: transactionIds,
                paymentIDs: paymentIds,
                cashInHandId: cashInHandId,
                excessAmount: excessAmount > 0 ? excessAmount : 0
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

exports.addCashInHandPayment = async (req, res) => {
    try {
        const {
            DepoID,
            Amount,
            CreditHead,
            TripID,
            TripNo,
            IsFine
        } = req.body;
        const createdBy = resolveAuditUser(req.body);

        // Validation
        if (!DepoID) {
            return res.status(400).json({ message: 'Dealer ID is required' });
        }
        if (!Amount || Amount <= 0) {
            return res.status(400).json({ message: 'Amount is required and must be greater than 0' });
        }
        if (!CreditHead || CreditHead == '') {
            return res.status(400).json({ message: 'Credit Head is required.' });
        }

        // ✅ FIX 1: Define creditHeadLower early
        const creditHeadLower = CreditHead.toLowerCase();

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // 1. Check cash in hand balance
            const [balanceRows] = await connection.execute(
                `SELECT 
                    COALESCE(SUM(credit), 0) - COALESCE(SUM(debit), 0) AS balance
                 FROM cash_in_hand 
                 WHERE Active = 1`
            );
            const currentCashBalance = parseFloat(balanceRows[0]?.balance || 0);

            if (currentCashBalance < Amount) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({
                    message: `Insufficient cash in hand balance. Available: ${currentCashBalance.toFixed(2)}, Required: ${Amount.toFixed(2)}`
                });
            }

            // Handle Fine Payment separately
            if (IsFine === true || IsFine === 'true') {
                return await handleFinePayment(connection, {
                    DepoID,
                    Amount,
                    createdBy,
                    currentCashBalance
                }, res);
            }

            // 2. Get depo details
            const [depoRows] = await connection.execute(
                `SELECT 
                    d.id,
                    d.name, 
                    d.Balance,
                    d.previous_payables,
                    d.special_credit_limit
                 FROM depo d
                 WHERE d.id = ? AND d.active = 1`,
                [DepoID]
            );

            if (depoRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Depo not found or inactive' });
            }

            const depo = depoRows[0];
            const depoName = depo.name || `Depo ${DepoID}`;
            const totalPaymentAmount = parseFloat(Amount);
            let remainingAmount = totalPaymentAmount;
            let amountAppliedToPreviousDues = 0;
            let amountAppliedToTrips = 0;
            let selectedTripId = null;
            let hasTripPayment = false;

            // ============================================================
            // STEP 1: Deduct from previous_payables (FIFO)
            // ============================================================
            const currentPreviousPayables = parseFloat(depo.previous_payables || 0);
            if (currentPreviousPayables > 0 && remainingAmount > 0) {
                amountAppliedToPreviousDues = Math.min(remainingAmount, currentPreviousPayables);
                const newPreviousPayables = currentPreviousPayables - amountAppliedToPreviousDues;

                await connection.execute(
                    'UPDATE depo SET previous_payables = ?, MD = NOW() WHERE id = ?',
                    [newPreviousPayables, DepoID]
                );

                remainingAmount -= amountAppliedToPreviousDues;
                console.log(`[Cash Payment] ✅ Previous Payables Cleared: ${amountAppliedToPreviousDues}. Remaining: ${remainingAmount}`);
            }

            // ============================================================
            // STEP 2: Fetch trips with balance for this depo (FIFO)
            // ============================================================
            if (remainingAmount > 0) {
                const [tripsWithBalance] = await connection.execute(
                    `SELECT 
                        t.id as trip_id,
                        t.trip_no,
                        td.id as trip_depo_id,
                        td.depo_id,
                        td.payable_amount,
                        td.paid_amount,
                        (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining,
                        td.purchase_type
                     FROM trips t
                     INNER JOIN trip_depos td ON td.trip_id = t.id AND td.depo_id = ? AND td.Active = 1
                     WHERE t.status != 'Cancelled'
                       AND t.Active = 1
                       AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                     ORDER BY t.start_date ASC, t.id ASC
                     LIMIT 1`,
                    [DepoID]
                );

                if (tripsWithBalance.length > 0) {
                    const trip = tripsWithBalance[0];
                    const tripRemaining = parseFloat(trip.remaining) || 0;
                    const paymentToApply = Math.min(remainingAmount, tripRemaining);

                    selectedTripId = trip.trip_id;
                    hasTripPayment = true;

                    // Update trip_depos paid_amount
                    const newPaidAmount = parseFloat(trip.paid_amount || 0) + paymentToApply;
                    await connection.execute(
                        `UPDATE trip_depos 
                         SET paid_amount = ?, MD = NOW()
                         WHERE id = ?`,
                        [newPaidAmount, trip.trip_depo_id]
                    );

                    // Update trips paid amount
                    const [tripDeposSum] = await connection.execute(
                        `SELECT COALESCE(SUM(paid_amount), 0) as total_paid
                         FROM trip_depos
                         WHERE trip_id = ? AND Active = 1`,
                        [trip.trip_id]
                    );
                    await connection.execute(
                        `UPDATE trips SET paid = ?, MD = NOW() WHERE id = ?`,
                        [parseFloat(tripDeposSum[0]?.total_paid || 0), trip.trip_id]
                    );

                    amountAppliedToTrips = paymentToApply;
                    remainingAmount -= paymentToApply;

                    // Check if trip should be closed
                    await checkAndCloseTrip(connection, trip.trip_id);

                    console.log(`[Cash Payment] ✅ Applied ${paymentToApply} to trip ${trip.trip_no}. Remaining: ${remainingAmount}`);
                } else {
                    console.log(`[Cash Payment] No trips with balance found for depo ${DepoID}`);
                }
            }

            // ============================================================
            // STEP 2.5: If no previous payables and no trips, handle payment
            // ============================================================
            if (remainingAmount > 0 && amountAppliedToPreviousDues === 0 && amountAppliedToTrips === 0) {
                // No previous payables and no trips with balance

                if (creditHeadLower === 'credit') {
                    console.log('[Cash Payment] Adding to regular credit limit (no trips available)');

                    const [openingRows] = await connection.execute(
                        `SELECT Credit as opening_balance
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

                    const openingBalance = openingRows.length > 0
                        ? parseFloat(openingRows[0].opening_balance || 0)
                        : 0;

                    const [currentLimitRows] = await connection.execute(
                        `SELECT DepoLimit 
                         FROM pool 
                         WHERE DepoID = ? AND active = 1 
                         ORDER BY ID DESC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const currentDepoLimit = currentLimitRows.length > 0
                        ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                        : 0;

                    console.log(`[Cash Payment] Opening Balance: ${openingBalance}`);
                    console.log(`[Cash Payment] Current Limit: ${currentDepoLimit}`);
                    console.log(`[Cash Payment] Amount to Credit: ${remainingAmount}`);

                    // Update depo balance
                    const newDepoBalance = parseFloat(depo.Balance || 0) + remainingAmount;
                    await connection.execute(
                        `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                        [newDepoBalance, DepoID]
                    );

                    // Insert into pool with payment_id = NULL
                    await connection.execute(
                        `INSERT INTO pool (
                            DepoID, 
                            TripID, 
                            payment_id, 
                            recovery_id, 
                            Debit, 
                            Credit, 
                            DepoLimit, 
                            Date, 
                            MD, 
                            CD, 
                            CB, 
                            Active
                        ) VALUES (?, ?, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, null, remainingAmount, currentDepoLimit + remainingAmount, createdBy]
                    );

                    console.log(`[Cash Payment] ✅ Credited ${remainingAmount} to pool (no trip). New limit: ${currentDepoLimit + remainingAmount}`);

                    // ✅ FIX 2: Track as advance payment and reset remaining
                    amountAppliedToTrips = remainingAmount;
                    hasTripPayment = false;
                    remainingAmount = 0;

                } else if (creditHeadLower === 'specialcredit') {
                    console.log('[Cash Payment] Adding to special credit limit (no trips available)');

                    const [openingRows] = await connection.execute(
                        `SELECT Credit as opening_balance
                         FROM special_credit_limit 
                         WHERE DepoID = ? 
                           AND TripID IS NULL 
                           AND payment_id IS NULL 
                           AND recovery_id IS NULL 
                           AND active = 1 
                         ORDER BY ID ASC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const openingBalance = openingRows.length > 0
                        ? parseFloat(openingRows[0].opening_balance || 0)
                        : 0;

                    const [currentLimitRows] = await connection.execute(
                        `SELECT DepoLimit 
                         FROM special_credit_limit 
                         WHERE DepoID = ? AND active = 1 
                         ORDER BY ID DESC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const currentDepoLimit = currentLimitRows.length > 0
                        ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                        : 0;

                    console.log(`[Cash Payment] Opening Balance: ${openingBalance}`);
                    console.log(`[Cash Payment] Current Limit: ${currentDepoLimit}`);
                    console.log(`[Cash Payment] Amount to Credit: ${remainingAmount}`);

                    // Update depo special credit
                    const newDepoSpecialCredit = parseFloat(depo.special_credit_limit || 0) + remainingAmount;
                    await connection.execute(
                        `UPDATE depo SET special_credit_limit = ?, MD = NOW() WHERE id = ?`,
                        [newDepoSpecialCredit, DepoID]
                    );

                    // Insert into special_credit_limit with payment_id = NULL
                    await connection.execute(
                        `INSERT INTO special_credit_limit (
                            DepoID, 
                            TripID, 
                            payment_id, 
                            recovery_id, 
                            Debit, 
                            Credit, 
                            DepoLimit, 
                            Date, 
                            MD, 
                            CD, 
                            CB, 
                            Active
                        ) VALUES (?, ?, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, null, remainingAmount, currentDepoLimit + remainingAmount, createdBy]
                    );

                    console.log(`[Cash Payment] ✅ Credited ${remainingAmount} to special_credit_limit (no trip). New limit: ${currentDepoLimit + remainingAmount}`);

                    // ✅ FIX 2: Track as advance payment and reset remaining
                    amountAppliedToTrips = remainingAmount;
                    hasTripPayment = false;
                    remainingAmount = 0;

                } else if (creditHeadLower === 'cash') {
                    console.log('[Cash Payment] Adding to advance balance (no trips available)');

                    const [lastAdvanceRows] = await connection.execute(
                        `SELECT Balance FROM advance_balance 
                         WHERE DepoID = ? AND Active = 1 
                         ORDER BY ID DESC LIMIT 1`,
                        [DepoID]
                    );
                    const currentAdvanceBalance = lastAdvanceRows.length > 0
                        ? parseFloat(lastAdvanceRows[0].Balance || 0)
                        : 0;
                    const newAdvanceBalance = currentAdvanceBalance + remainingAmount;

                    await connection.execute(
                        `INSERT INTO advance_balance (
                            DepoID, 
                            TripID, 
                            recovery_id, 
                            payment_id, 
                            Debit, 
                            Credit, 
                            Balance, 
                            Date, 
                            MD, 
                            CD, 
                            CB, 
                            Active
                        ) VALUES (?, ?, NULL, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [DepoID, null, remainingAmount, newAdvanceBalance, createdBy]
                    );

                    console.log(`[Cash Payment] ✅ Added ${remainingAmount} to advance_balance (no trips available). New balance: ${newAdvanceBalance}`);

                    // Track as advance payment and reset remaining
                    amountAppliedToTrips = remainingAmount;
                    hasTripPayment = false;
                    remainingAmount = 0;
                }
            }

            // ============================================================
            // STEP 3: Create cash_in_hand entry (debit - money going out)
            // ============================================================
            const newCashBalance = currentCashBalance - totalPaymentAmount;
            let cashPurpose = `Payment to ${depoName}`;
            if (amountAppliedToPreviousDues > 0) {
                cashPurpose += ` - Previous Payables Cleared (${amountAppliedToPreviousDues})`;
            }
            if (amountAppliedToTrips > 0 && hasTripPayment) {
                cashPurpose += ` - Trip Payment (${amountAppliedToTrips})`;
            }
            if (amountAppliedToTrips > 0 && !hasTripPayment) {
                cashPurpose += ` - Advance Payment (${amountAppliedToTrips})`;
            }

            const [cashInHandResult] = await connection.execute(
                `INSERT INTO cash_in_hand (
                    debit, credit, balance, purpose, created_at, CB, MB, Active
                ) VALUES (?, 0, ?, ?, NOW(), ?, ?, 1)`,
                [totalPaymentAmount, newCashBalance, cashPurpose, createdBy, createdBy]
            );
            const cashInHandId = cashInHandResult.insertId;

            // ============================================================
            // STEP 4: Create transaction entry with detailed purpose
            // ============================================================
            let transactionPurpose = `Payment to ${depoName}`;
            const details = [];
            if (amountAppliedToPreviousDues > 0) {
                details.push(`Previous Payables Cleared: ${amountAppliedToPreviousDues}`);
            }
            if (amountAppliedToTrips > 0 && hasTripPayment) {
                details.push(`Trip Payment: ${amountAppliedToTrips}`);
            }
            if (amountAppliedToTrips > 0 && !hasTripPayment) {
                details.push(`Advance Payment: ${amountAppliedToTrips}`);
            }

            if (details.length > 0) {
                transactionPurpose += ` - ${details.join(', ')}`;
            }

            const transactionTripId = hasTripPayment ? selectedTripId : null;

            const [transactionResult] = await connection.execute(
                `INSERT INTO transactions (
                    cash_in_hand_id, 
                    trip_id, 
                    Purpose, 
                    Debit, 
                    Credit, 
                    Date, 
                    PaymentMode, 
                    CB, 
                    active
                ) VALUES (?, ?, ?, ?, 0, NOW(), 'Cash', ?, 1)`,
                [cashInHandId, transactionTripId, transactionPurpose, totalPaymentAmount, createdBy]
            );
            const transactionID = transactionResult.insertId;

            // ============================================================
            // STEP 5: Create payment record (ONLY if there was a trip payment)
            // ============================================================
            let paymentID = null;
            if (hasTripPayment) {
                const paymentTripId = selectedTripId;
                const [paymentResult] = await connection.execute(
                    `INSERT INTO payments (
                        transactionID, 
                        DepoID, 
                        trip_id, 
                        Amount, 
                        Date, 
                        CB, 
                        active
                    ) VALUES (?, ?, ?, ?, NOW(), ?, 1)`,
                    [transactionID, DepoID, paymentTripId, totalPaymentAmount, createdBy]
                );
                paymentID = paymentResult.insertId;
            }

            // ============================================================
            // STEP 6: Credit trip payment amount to depo's credit limit
            // ✅ FIX 5: Only process if there was an actual trip payment
            // ============================================================
            let amountToCredit = 0;
            let excessAmount = 0;

            if (hasTripPayment && amountAppliedToTrips > 0) {
                // Only proceed if there was a trip payment
                amountToCredit = amountAppliedToTrips;

                if (creditHeadLower === 'credit') {
                    console.log('[Cash Payment] Crediting trip payment to regular credit limit');

                    const [openingRows] = await connection.execute(
                        `SELECT Credit as opening_balance
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

                    const openingBalance = openingRows.length > 0
                        ? parseFloat(openingRows[0].opening_balance || 0)
                        : 0;

                    const [currentLimitRows] = await connection.execute(
                        `SELECT DepoLimit 
                         FROM pool 
                         WHERE DepoID = ? AND active = 1 
                         ORDER BY ID DESC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const currentDepoLimit = currentLimitRows.length > 0
                        ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                        : 0;

                    const availableSpace = Math.max(0, openingBalance - currentDepoLimit);

                    if (amountToCredit > availableSpace) {
                        excessAmount = amountToCredit - availableSpace;
                        amountToCredit = availableSpace;
                    }

                    console.log(`[Cash Payment] Trip Payment Amount: ${amountAppliedToTrips}`);
                    console.log(`[Cash Payment] Opening Balance: ${openingBalance}`);
                    console.log(`[Cash Payment] Current Limit: ${currentDepoLimit}`);
                    console.log(`[Cash Payment] Available Space: ${availableSpace}`);
                    console.log(`[Cash Payment] Amount to Credit: ${amountToCredit}`);
                    console.log(`[Cash Payment] Excess to Advance: ${excessAmount}`);

                    if (amountToCredit > 0) {
                        const newDepoLimit = currentDepoLimit + amountToCredit;
                        await connection.execute(
                            `INSERT INTO pool (
                                DepoID, 
                                TripID, 
                                payment_id, 
                                recovery_id, 
                                Debit, 
                                Credit, 
                                DepoLimit, 
                                Date, 
                                MD, 
                                CD, 
                                CB, 
                                Active
                            ) VALUES (?, ?, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                            [DepoID, selectedTripId, paymentID, amountToCredit, newDepoLimit, createdBy]
                        );
                        console.log(`[Cash Payment] ✅ Credited ${amountToCredit} to pool. New limit: ${newDepoLimit}`);
                    }

                } else if (creditHeadLower === 'specialcredit') {
                    console.log('[Cash Payment] Crediting trip payment to special credit limit');

                    const [openingRows] = await connection.execute(
                        `SELECT Credit as opening_balance
                         FROM special_credit_limit 
                         WHERE DepoID = ? 
                           AND TripID IS NULL 
                           AND payment_id IS NULL 
                           AND recovery_id IS NULL 
                           AND active = 1 
                         ORDER BY ID ASC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const openingBalance = openingRows.length > 0
                        ? parseFloat(openingRows[0].opening_balance || 0)
                        : 0;

                    const [currentLimitRows] = await connection.execute(
                        `SELECT DepoLimit 
                         FROM special_credit_limit 
                         WHERE DepoID = ? AND active = 1 
                         ORDER BY ID DESC 
                         LIMIT 1`,
                        [DepoID]
                    );

                    const currentDepoLimit = currentLimitRows.length > 0
                        ? parseFloat(currentLimitRows[0].DepoLimit || 0)
                        : 0;

                    const availableSpace = Math.max(0, openingBalance - currentDepoLimit);

                    if (amountToCredit > availableSpace) {
                        excessAmount = amountToCredit - availableSpace;
                        amountToCredit = availableSpace;
                    }

                    console.log(`[Cash Payment] Trip Payment Amount: ${amountAppliedToTrips}`);
                    console.log(`[Cash Payment] Opening Balance: ${openingBalance}`);
                    console.log(`[Cash Payment] Current Limit: ${currentDepoLimit}`);
                    console.log(`[Cash Payment] Available Space: ${availableSpace}`);
                    console.log(`[Cash Payment] Amount to Credit: ${amountToCredit}`);
                    console.log(`[Cash Payment] Excess to Advance: ${excessAmount}`);

                    if (amountToCredit > 0) {
                        const newDepoLimit = currentDepoLimit + amountToCredit;
                        await connection.execute(
                            `INSERT INTO special_credit_limit (
                                DepoID, 
                                TripID, 
                                payment_id, 
                                recovery_id, 
                                Debit, 
                                Credit, 
                                DepoLimit, 
                                Date, 
                                MD, 
                                CD, 
                                CB, 
                                Active
                            ) VALUES (?, ?, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                            [DepoID, selectedTripId, paymentID, amountToCredit, newDepoLimit, createdBy]
                        );
                        console.log(`[Cash Payment] ✅ Credited ${amountToCredit} to special_credit_limit. New limit: ${newDepoLimit}`);
                    }
                }
            } else {
                console.log(`[Cash Payment] No trip payment to credit. Amount applied: Previous Payables: ${amountAppliedToPreviousDues}, Advance: ${!hasTripPayment ? amountAppliedToTrips : 0}`);
            }

            // ============================================================
            // STEP 7: Add excess to advance_balance (only if from trip payment)
            // ============================================================
            if (excessAmount > 0 && hasTripPayment) {
                const [lastAdvanceRows] = await connection.execute(
                    `SELECT Balance FROM advance_balance 
                     WHERE DepoID = ? AND Active = 1 
                     ORDER BY ID DESC LIMIT 1`,
                    [DepoID]
                );
                const currentAdvanceBalance = lastAdvanceRows.length > 0
                    ? parseFloat(lastAdvanceRows[0].Balance || 0)
                    : 0;
                const newAdvanceBalance = currentAdvanceBalance + excessAmount;

                await connection.execute(
                    `INSERT INTO advance_balance (
                        DepoID, 
                        TripID, 
                        recovery_id, 
                        payment_id, 
                        Debit, 
                        Credit, 
                        Balance, 
                        Date, 
                        MD, 
                        CD, 
                        CB, 
                        Active
                    ) VALUES (?, ?, NULL, ?, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                    [DepoID, selectedTripId, paymentID, excessAmount, newAdvanceBalance, createdBy]
                );
                console.log(`[Cash Payment] ✅ Added ${excessAmount} to advance_balance. New balance: ${newAdvanceBalance}`);
            }

            // ============================================================
            // STEP 8: Update depo balance (ONLY for trip payments)
            // ✅ FIX: Skip if no trip payment (already updated in STEP 2.5)
            // ============================================================
            if (hasTripPayment && amountToCredit > 0) {
                let newDepoBalance = parseFloat(depo.Balance || 0);
                let newDepoSpecialCredit = parseFloat(depo.special_credit_limit || 0);

                if (creditHeadLower === 'credit') {
                    newDepoBalance = newDepoBalance + amountToCredit;
                    await connection.execute(
                        `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                        [newDepoBalance, DepoID]
                    );
                    console.log(`[Cash Payment] ✅ Updated depo Balance to ${newDepoBalance}`);
                } else if (creditHeadLower === 'specialcredit') {
                    newDepoSpecialCredit = newDepoSpecialCredit + amountToCredit;
                    await connection.execute(
                        `UPDATE depo SET special_credit_limit = ?, MD = NOW() WHERE id = ?`,
                        [newDepoSpecialCredit, DepoID]
                    );
                    console.log(`[Cash Payment] ✅ Updated depo special_credit_limit to ${newDepoSpecialCredit}`);
                }
            }

            await connection.commit();
            connection.release();

            // Build response message
            let responseMessage = 'Cash in hand payment added successfully.';
            const responseDetails = [];
            if (amountAppliedToPreviousDues > 0) {
                responseDetails.push(`Previous Payables Cleared: ${amountAppliedToPreviousDues}`);
            }
            if (amountAppliedToTrips > 0 && hasTripPayment) {
                responseDetails.push(`Trip Payment: ${amountAppliedToTrips}`);
            }
            if (amountAppliedToTrips > 0 && !hasTripPayment) {
                responseDetails.push(`Advance Payment: ${amountAppliedToTrips}`);
            }
            if (amountToCredit > 0 && hasTripPayment) {
                responseDetails.push(`Credit to ${CreditHead}: ${amountToCredit}`);
            }
            if (excessAmount > 0 && hasTripPayment) {
                responseDetails.push(`Advance Balance: ${excessAmount}`);
            }

            if (responseDetails.length > 0) {
                responseMessage += ` Applied: ${responseDetails.join(', ')}.`;
            }

            return res.json({
                message: responseMessage,
                transactionID: transactionID,
                paymentID: paymentID,
                cashInHandId: cashInHandId,
                tripId: hasTripPayment ? selectedTripId : null,
                details: {
                    amountAppliedToPreviousDues,
                    amountAppliedToTrips,
                    amountToCredit: hasTripPayment ? amountToCredit : 0,
                    excessAmount: hasTripPayment ? excessAmount : 0,
                    newCashBalance,
                    newDepoBalance: hasTripPayment ? parseFloat(depo.Balance || 0) + (hasTripPayment ? amountToCredit : 0) : parseFloat(depo.Balance || 0),
                    newDepoSpecialCredit: hasTripPayment ? parseFloat(depo.special_credit_limit || 0) + (creditHeadLower === 'specialcredit' && hasTripPayment ? amountToCredit : 0) : parseFloat(depo.special_credit_limit || 0),
                    hasTripPayment,
                    previousPayablesCleared: amountAppliedToPreviousDues > 0
                }
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

// Helper function for fine payments
async function handleFinePayment(connection, params, res) {
    const { DepoID, Amount, createdBy, currentCashBalance } = params;

    try {
        const finePurpose = `Fine Payment to Depo ${DepoID}`;
        const newCashBalance = currentCashBalance - Amount;

        // Cash in hand entry
        const [cashInHandResult] = await connection.execute(
            `INSERT INTO cash_in_hand (
                debit, credit, balance, purpose, created_at, CB, MB, Active
            ) VALUES (?, 0, ?, ?, NOW(), ?, ?, 1)`,
            [Amount, newCashBalance, finePurpose, createdBy, createdBy]
        );
        const cashInHandId = cashInHandResult.insertId;

        // Transaction entry
        const [transactionResult] = await connection.execute(
            `INSERT INTO transactions (
                cash_in_hand_id, Purpose, Debit, Credit, Date, 
                PaymentMode, trip_id, CB, active
            ) VALUES (?, ?, ?, 0, NOW(), 'Cash', NULL, ?, 1)`,
            [cashInHandId, finePurpose, Amount, createdBy]
        );
        const transactionID = transactionResult.insertId;

        // Payment entry
        const [paymentResult] = await connection.execute(
            `INSERT INTO payments (
                transactionID, DepoID, trip_id, Amount, Date, 
                CB, isFine, active
            ) VALUES (?, ?, NULL, ?, NOW(), ?, 1, 1)`,
            [transactionID, DepoID, Amount, createdBy]
        );

        await connection.commit();
        connection.release();

        return res.json({
            message: 'Fine cash payment added successfully',
            transactionID,
            paymentID: paymentResult.insertId,
            cashInHandId
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        throw err;
    }
}