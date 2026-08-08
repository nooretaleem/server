const db = require('../models/db');

function resolveAuditUser(body = {}, fallback = 'Admin') {
    return (
        body.MB ||
        body.CB ||
        body.userName ||
        body.username ||
        body.UserName ||
        body.createdBy ||
        body.modifiedBy ||
        fallback
    ).toString().trim() || fallback;
}

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
        // Get all active records ordered by id ASC (IDs are sequential and represent insertion order)
        // This ensures correct balance calculation regardless of created_at timestamp issues
        const [allRecords] = await connection.execute(`
            SELECT id, debit, credit
            FROM cash_in_hand
            WHERE Active = 1
            ORDER BY id ASC
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
                r.pump_id,
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
            INNER JOIN customers c ON r.ClientID = c.id AND c.active = 1
             LEFT JOIN petrol_pumps pp ON r.pump_id = pp.id AND pp.active = 1
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

exports.getLocalRecoveries = async (req, res) => {
    try {
        const query = `
            SELECT fsc.customer_id, fsc.customer_name, fscr.amount, fscr.payment_mode as received_in, fscr.recovery_date as Date FROM fuel_station_customer_recoveries fscr
            INNER JOIN fuel_station_customer fsc ON fscr.customer_id = fsc.customer_id
                WHERE fscr.Active = 1 order by date desc
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching local recoveries:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};
exports.getSelfRecoveries = async (req, res) => {
    try {
        const query = `
            SELECT 
                r.ID,
                COALESCE(r.pump_id, r.ClientID) as ClientID,
                r.Amount,
                r.Date,
                r.Payment_Head,
                c.name as customer_name,
                r.transactionID
            FROM recoveries r
            INNER JOIN petrol_pumps c ON r.pump_id = c.id AND c.active = 1
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
            ClientType,
            Amount,
            CustomerAdvance,
            Date: recoveryDate,
            CreditHead,
            payment_method,
            payment_head,
            AccountID,
            DepoID,
            PaymentMode,
            ReferenceNo,
            CB,
            name
        } = req.body;

        const auditUser = resolveAuditUser(req.body, 'admin@gmail.com');
        // ================================================================
        // CONSOLE LOG FOR REQUEST BODY VARIABLES
        // ================================================================
        console.log('========== RECOVERY REQUEST DETAILS ==========');
        console.log('📋 Request Body:', JSON.stringify(req.body, null, 2));
        console.log('----------------------------------------');
        console.log('🔑 ClientID:', ClientID);
        console.log('🏷️  ClientType:', ClientType);
        console.log('💰 Amount:', Amount);
        console.log('🏷️  Customer Advance:', CustomerAdvance);
        console.log('📅 Date (recoveryDate):', recoveryDate);
        console.log('💳 payment_method:', payment_method);
        console.log('📝 payment_head:', payment_head);
        console.log('🏦 AccountID:', AccountID);
        console.log('🏢 DepoID:', DepoID);
        console.log('💵 PaymentMode:', PaymentMode);
        console.log('🔢 ReferenceNo:', ReferenceNo);
        console.log('👤 CB (Created By):', CB);
        console.log('👤 name:', name);
        console.log('👤 creditHead:', CreditHead);
        console.log('==============================================');


        // Validation
        if (!ClientID) {
            return res.status(400).json({ message: 'Client ID is required' });
        }
        if (!ClientType || (ClientType !== 'Local' && ClientType !== 'Supplier' && ClientType !== 'Self')) {
            return res.status(400).json({ message: 'Client Type is required and must be either Local, Supplier, or Self' });
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

        // Declare variables at the top for proper scope
        let remainingRecoveryAmount = 0;
        let amountDeductedFromPreviousDues = 0;
        let transactionID = null;

        try {
            if (ClientType === 'Supplier') {
                await connection.beginTransaction();

                // STEP 1: Check if client has previous dues
                const [customerRows] = await connection.execute(
                    'SELECT Previous_Dues FROM customers WHERE id = ? AND active = 1',
                    [ClientID]
                );

                if (customerRows.length === 0) {
                    await connection.rollback();
                    connection.release();
                    return res.status(404).json({ message: 'Customer not found or inactive' });
                }



                // STEP 2 & 3: Deduct from Previous_Dues

                const currentPreviousDues = parseFloat(customerRows[0].Previous_Dues || 0) || 0;
                const recoveryAmount = parseFloat(Amount);
                remainingRecoveryAmount = recoveryAmount;
                amountDeductedFromPreviousDues = 0;


                if (currentPreviousDues > 0 && remainingRecoveryAmount > 0) {

                    // ================================================================
                    //  NEW STEP: Deduct from recoveries_advance FIRST
                    // ================================================================
                    let adv_RecoveryAmount = recoveryAmount;
                    const [advanceRows] = await connection.execute(
                        `SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS total_advance
                     FROM recoveries_advance
                     WHERE ws_customer_id = ? AND Active = 1
                     AND (pump_id IS NULL OR pump_id = 0)
                     AND (fs_customer_id IS NULL OR fs_customer_id = 0)`,
                        [ClientID]
                    );

                    let clientAdvanceBalance = parseFloat(advanceRows[0]?.total_advance || 0);
                    let amountDeductedFromAdvance = 0;

                    if (clientAdvanceBalance > 0 && adv_RecoveryAmount > 0) {
                        if (adv_RecoveryAmount <= clientAdvanceBalance) {
                            // Entire recovery amount is covered by advance balance
                            amountDeductedFromAdvance = adv_RecoveryAmount;
                            const newAdvanceBalance = clientAdvanceBalance - adv_RecoveryAmount;

                            // Insert Debit entry into recoveries_advance
                            await connection.execute(
                                `INSERT INTO recoveries_advance (
                                ws_customer_id,
                                entrydate,
                                Debit,
                                Credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?, ?, ?, 0, ?, ?, ?, 1)`,
                                [
                                    ClientID,
                                    recoveryDate,
                                    amountDeductedFromAdvance,
                                    newAdvanceBalance,
                                    auditUser,
                                    auditUser
                                ]
                            );

                            adv_RecoveryAmount = 0;
                            console.log(`Deducted ${amountDeductedFromAdvance} from recoveries_advance. New Advance Balance: ${newAdvanceBalance}`);
                        } else {
                            // Amount is greater than advance balance - empty the advance entirely
                            amountDeductedFromAdvance = clientAdvanceBalance;
                            const newAdvanceBalance = 0;

                            await connection.execute(
                                `INSERT INTO recoveries_advance (
                                ws_customer_id,
                                entrydate,
                                Debit,
                                Credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?, ?, ?, 0, ?, ?, ?, 1)`,
                                [
                                    ClientID,
                                    recoveryDate,
                                    amountDeductedFromAdvance,
                                    newAdvanceBalance,
                                    auditUser,
                                    auditUser
                                ]
                            );

                            adv_RecoveryAmount = adv_RecoveryAmount - clientAdvanceBalance;
                            console.log(`Deducted all recoveries_advance (${amountDeductedFromAdvance}). Remaining: ${adv_RecoveryAmount}`);
                        }
                    }
                    // ================================================================
                    if (remainingRecoveryAmount <= currentPreviousDues) {
                        // Amount is less than previous dues - adjust all in previous dues
                        amountDeductedFromPreviousDues = remainingRecoveryAmount;
                        const newPreviousDues = currentPreviousDues - remainingRecoveryAmount;
                        await connection.execute(
                            'UPDATE customers SET Previous_Dues = ?, MD = NOW() WHERE id = ?',
                            [newPreviousDues, ClientID]
                        );
                        remainingRecoveryAmount = 0;
                        console.log(`Deducted ${amountDeductedFromPreviousDues} from Previous_Dues. New Previous_Dues: ${newPreviousDues}`);
                    } else {
                        // Amount is more than previous dues - set previous dues to 0
                        amountDeductedFromPreviousDues = currentPreviousDues;
                        remainingRecoveryAmount = remainingRecoveryAmount - currentPreviousDues;
                        await connection.execute(
                            'UPDATE customers SET Previous_Dues = 0, MD = NOW() WHERE id = ?',
                            [ClientID]
                        );
                        console.log(`Deducted all Previous_Dues (${amountDeductedFromPreviousDues}). Remaining: ${remainingRecoveryAmount}`);
                    }

                    // ================================================================
                    // INSERT PREVIOUS DUES INTO APPROPRIATE TABLES BASED ON PAYMENT METHOD
                    // ================================================================

                    const customerName = await getCustomerName(connection, ClientID);
                    const purpose = `Previous Dues Payment Received from ${customerName}`;

                    if (payment_method === 'cash_in_hand') {
                        // Cash in Hand payment
                        const [lastBalanceRows] = await connection.execute(`
                            SELECT balance FROM cash_in_hand 
                            WHERE Active = 1 
                            ORDER BY created_at DESC, id DESC 
                            LIMIT 1
                        `);

                        const currentBalance = lastBalanceRows.length > 0
                            ? parseFloat(lastBalanceRows[0]?.balance || 0)
                            : 0;
                        const newBalance = currentBalance + amountDeductedFromPreviousDues;

                        const cashInHandQuery = `
                            INSERT INTO cash_in_hand (
                                debit,
                                credit,
                                balance,
                                purpose,
                                created_at,
                                CB
                            ) VALUES (0, ?, ?, ?, ?, ?)
                        `;

                        const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                            amountDeductedFromPreviousDues,
                            newBalance,
                            purpose,
                            recoveryDate,
                            auditUser
                        ]);

                        const cashInHandId = cashInHandResult.insertId;

                        // Insert into transactions with cash_in_hand_id
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
                                CB,
                                CD,
                                MD,
                                active
                            ) VALUES (?, NULL, ?, 0, ?, ?, 'Cash', NULL, ?, NOW(), NOW(), 1)
                        `;

                        const [transactionResult] = await connection.execute(transactionQuery, [
                            cashInHandId,
                            purpose,
                            amountDeductedFromPreviousDues,
                            recoveryDate,
                            auditUser
                        ]);

                        transactionID = transactionResult.insertId;
                        // Insert into recoveries for previous dues (common for all payment methods)
                        const recoveryQuery = `
                        INSERT INTO recoveries (
                            transactionid,
                            clientid,
                            trip_id,
                            amount,
                            payment_head,
                            reference,
                            CD,
                            CB,
                            MD,
                            Active,
                            Date
                        ) VALUES (?, ?, NULL, ?, ?, ?, NOW(), ?, NOW(), 1,?)
                        `;

                        await connection.execute(recoveryQuery, [
                            transactionID,
                            ClientID,
                            amountDeductedFromPreviousDues,
                            payment_head || 'Previous Dues Payment',
                            ReferenceNo || null,
                            auditUser,
                            recoveryDate
                        ]);

                        console.log(`Previous dues amount ${amountDeductedFromPreviousDues} recorded in ${payment_method} and recoveries table`);

                    } else if (payment_method === 'account') {
                        // Account payment
                        if (!AccountID) {
                            await connection.rollback();
                            connection.release();
                            return res.status(400).json({ message: 'Account ID is required for account payment' });
                        }

                        const [accountRows] = await connection.execute(
                            'SELECT Balance, AccountTitle FROM accounts WHERE ID = ? AND active = 1',
                            [AccountID]
                        );

                        if (accountRows.length === 0) {
                            await connection.rollback();
                            connection.release();
                            return res.status(404).json({ message: 'Account not found or inactive' });
                        }

                        const accountTitle = accountRows[0].AccountTitle;
                        const currentAccountBalance = parseFloat(accountRows[0].Balance || 0);
                        const newAccountBalance = currentAccountBalance + amountDeductedFromPreviousDues;

                        await connection.execute(
                            'UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ? AND active = 1',
                            [newAccountBalance, AccountID]
                        );

                        const transactionQuery = `
                            INSERT INTO transactions (
                                AccountID,
                                Purpose,
                                Debit,
                                Credit,
                                Date,
                                PaymentMode,
                                ReferenceNo,
                                CB,
                                CD,
                                MD,
                                active
                            ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                        `;

                        const [transactionResult] = await connection.execute(transactionQuery, [
                            AccountID,
                            purpose,
                            amountDeductedFromPreviousDues,
                            recoveryDate,
                            PaymentMode || 'Bank Transfer',
                            ReferenceNo || null,
                            auditUser
                        ]);

                        transactionID = transactionResult.insertId;
                        // Insert into recoveries for previous dues (common for all payment methods)
                        const recoveryQuery = `
                        INSERT INTO recoveries (
                            transactionid,
                            clientid,
                            trip_id,
                            amount,
                            payment_head,
                            reference,
                            CD,
                            CB,
                            MD,
                            Active,
                            Date
                        ) VALUES (?, ?, NULL, ?, ?, ?, NOW(), ?, NOW(), 1,?)
                        `;

                        await connection.execute(recoveryQuery, [
                            transactionID,
                            ClientID,
                            amountDeductedFromPreviousDues,
                            payment_head || 'Previous Dues Payment',
                            ReferenceNo || null,
                            auditUser,
                            recoveryDate
                        ]);

                        console.log(`Previous dues amount ${amountDeductedFromPreviousDues} recorded in ${payment_method} and recoveries table`);

                    } else if (payment_method === 'depo') {

                        // Depo payment handling
                        if (!DepoID) {
                            await connection.rollback();
                            connection.release();
                            return res.status(400).json({ message: 'Depo ID is required for depo payment' });
                        }

                        // Validate customer has purchased from this dealer
                        const [customerDepos] = await connection.execute(
                            `SELECT DISTINCT td.depo_id
                                FROM pol_sale ps
                                INNER JOIN trips t ON ps.trip_id = t.id AND t.active = 1
                                INNER JOIN trip_depos td ON ps.trip_id = td.trip_id AND td.Active = 1
                                WHERE ps.client_id = ? AND ps.Active = 1
                                AND td.depo_id IS NOT NULL`,
                            [ClientID]
                        );

                        const allowedDepoIds = customerDepos.map(row => row.depo_id);

                        if (allowedDepoIds.length > 0 && !allowedDepoIds.includes(parseInt(DepoID, 10))) {
                            await connection.rollback();
                            connection.release();
                            return res.status(400).json({
                                message: 'This customer has not purchased from the selected dealer. Please select a dealer from which the customer has purchased.'
                            });
                        }
                        // Get the credit head from request (default to 'credit')
                        const creditHead = req.body.CreditHead || 'credit';
                        const creditHeadLower = creditHead.toLowerCase();

                        // Get depo details for balance updates
                        const [depoRows] = await connection.execute(
                            `SELECT Balance, special_credit_limit FROM depo WHERE id = ? AND active = 1`,
                            [DepoID]
                        );

                        if (depoRows.length === 0) {
                            await connection.rollback();
                            connection.release();
                            return res.status(404).json({ message: 'Depo not found or inactive' });
                        }

                        const depo = depoRows[0];

                        // ============================================================
                        //  UPDATE BALANCES BASED ON CREDIT HEAD
                        // ============================================================
                        const amountToAdd = amountDeductedFromPreviousDues;

                        if (creditHeadLower === 'credit') {
                            // === CREDIT: Update pool table and depo.Balance ===

                            // Get current pool limit
                            const [currentLimitRows] = await connection.execute(
                                `SELECT DepoLimit 
                                FROM pool 
                                WHERE DepoID = ? AND active = 1 
                                ORDER BY ID DESC 
                                LIMIT 1`,
                                [DepoID]
                            );

                            let currentDepoLimit = 0;
                            if (currentLimitRows.length > 0) {
                                currentDepoLimit = parseFloat(currentLimitRows[0].DepoLimit || 0);
                            } else {
                                // If no pool entry exists, get from depo table
                                currentDepoLimit = parseFloat(depo.Balance || 0);
                            }

                            const newDepoLimit = currentDepoLimit + amountToAdd;

                            // Insert into recoveries for previous dues (common for all payment methods)
                            const recoveryQuery = `
                        INSERT INTO recoveries (
                            transactionid,
                            clientid,
                            trip_id,
                            amount,
                            payment_head,
                            reference,
                            CD,
                            CB,
                            MD,
                            Active,
                            Date
                        ) VALUES (null, ?, NULL, ?, ?, ?, NOW(), ?, NOW(), 1,?)
                        `;

                            const [recoveryResult] = await connection.execute(recoveryQuery, [
                                ClientID,
                                amountToAdd,
                                payment_head || 'Previous Dues Payment',
                                ReferenceNo || null,
                                auditUser,
                                recoveryDate
                            ]);

                            console.log(`Previous dues amount ${amountToAdd} recorded in ${payment_method} and recoveries table`);
                            const recoveryId = recoveryResult.insertId;

                            // ============================================================
                            // INSERT INTO SETTLEMENTS TABLE
                            // ============================================================
                            const settlementQuery = `
                            INSERT INTO settlements (
                                recovery_id,
                                client_id,
                                depo_id,
                                amount,
                                settlement_type,
                                reference_no,
                                settlement_date,
                                CB,
                                CD,
                                MD,
                                Active
                            ) VALUES (?, ?, ?, ?, 'PAYMENT_TO_SUPPLIER', ?, ?, ?, NOW(), NOW(), 1)
                        `;

                            const [settlementResult] = await connection.execute(settlementQuery, [
                                recoveryId,
                                ClientID,
                                DepoID,
                                amountToAdd,
                                ReferenceNo || null,
                                recoveryDate,
                                auditUser
                            ]);

                            const settlementId = settlementResult.insertId;
                            // Insert into pool table
                            await connection.execute(
                                `INSERT INTO pool (
                                DepoID, 
                                TripID,
                                Debit, 
                                Credit, 
                                DepoLimit,
                                Date,
                                payment_id,
                                recovery_id,
                                active
                            ) VALUES (?, null, 0, ?, ?, ?, NULL, ?, 1)`,
                                [
                                    DepoID,
                                    amountToAdd,
                                    newDepoLimit,
                                    recoveryDate,
                                    recoveryId
                                ]
                            );

                            // Update depo.Balance
                            await connection.execute(
                                `UPDATE depo SET Balance = Balance + ?, MD = NOW() WHERE id = ?`,
                                [amountToAdd, DepoID]
                            );

                            console.log(`[CREDIT] Added ${amountToAdd} to pool for depo ${DepoID}. New limit: ${newDepoLimit}`);

                        } else if (creditHeadLower === 'specialcredit') {
                            // === SPECIAL CREDIT: Update special_credit_limit table and depo.special_credit_limit ===

                            // Get current special credit limit
                            const [currentLimitRows] = await connection.execute(
                                `SELECT DepoLimit 
                                FROM special_credit_limit 
                                WHERE DepoID = ? AND active = 1 
                                ORDER BY ID DESC 
                                LIMIT 1`,
                                [DepoID]
                            );

                            let currentDepoLimit = 0;
                            if (currentLimitRows.length > 0) {
                                currentDepoLimit = parseFloat(currentLimitRows[0].DepoLimit || 0);
                            } else {
                                // If no special_credit_limit entry exists, get from depo table
                                currentDepoLimit = parseFloat(depo.special_credit_limit || 0);
                            }

                            const newDepoLimit = currentDepoLimit + amountToAdd;

                            // Insert into recoveries for previous dues (common for all payment methods)
                            const recoveryQuery = `
                        INSERT INTO recoveries (
                            transactionid,
                            clientid,
                            trip_id,
                            amount,
                            payment_head,
                            reference,
                            CD,
                            CB,
                            MD,
                            Active,
                            Date
                        ) VALUES (null, ?, NULL, ?, ?, ?, NOW(), ?, NOW(), 1,?)
                        `;

                            const [recoveryResult] = await connection.execute(recoveryQuery, [
                                ClientID,
                                amountToAdd,
                                payment_head || 'Previous Dues Payment',
                                ReferenceNo || null,
                                auditUser,
                                recoveryDate
                            ]);

                            console.log(`Previous dues amount ${amountToAdd} recorded in ${payment_method} and recoveries table`);
                            const recoveryId = recoveryResult.insertId;

                            // ============================================================
                            // INSERT INTO SETTLEMENTS TABLE
                            // ============================================================
                            const settlementQuery = `
                            INSERT INTO settlements (
                                recovery_id,
                                client_id,
                                depo_id,
                                amount,
                                settlement_type,
                                reference_no,
                                settlement_date,
                                CB,
                                CD,
                                MD,
                                Active
                            ) VALUES (?, ?, ?, ?, 'PAYMENT_TO_SUPPLIER', ?, ?, ?, NOW(), NOW(), 1)
                        `;

                            const [settlementResult] = await connection.execute(settlementQuery, [
                                recoveryId,
                                ClientID,
                                DepoID,
                                amountToAdd,
                                ReferenceNo || null,
                                recoveryDate,
                                auditUser
                            ]);

                            const settlementId = settlementResult.insertId;
                            // Insert into special_credit_limit table
                            await connection.execute(
                                `INSERT INTO special_credit_limit (
                                    DepoID, 
                                    TripID,
                                    Debit, 
                                    Credit, 
                                    DepoLimit,
                                    Date,
                                    payment_id,
                                    recovery_id,
                                    active
                                ) VALUES (?, null, 0, ?, ?, ?, NULL, ?, 1)`,
                                [
                                    DepoID,
                                    amountToAdd,
                                    newDepoLimit,
                                    recoveryDate,
                                    recoveryId
                                ]
                            );

                            // Update depo.special_credit_limit
                            await connection.execute(
                                `UPDATE depo SET special_credit_limit = special_credit_limit + ?, MD = NOW() WHERE id = ?`,
                                [amountToAdd, DepoID]
                            );

                            console.log(`[SPECIAL CREDIT] Added ${amountToAdd} to special_credit_limit for depo ${DepoID}. New limit: ${newDepoLimit}`);

                        } else if (creditHeadLower === 'cash') {
                            // === CASH: Add to advance_balance ===

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
                            const newAdvanceBalance = currentAdvanceBalance + amountToAdd;

                            // Insert into recoveries for previous dues (common for all payment methods)
                            const recoveryQuery = `
                        INSERT INTO recoveries (
                            transactionid,
                            clientid,
                            trip_id,
                            amount,
                            payment_head,
                            reference,
                            CD,
                            CB,
                            MD,
                            Active,
                            Date
                        ) VALUES (null, ?, NULL, ?, ?, ?, NOW(), ?, NOW(), 1,?)
                        `;

                            const [recoveryResult] = await connection.execute(recoveryQuery, [
                                ClientID,
                                amountToAdd,
                                payment_head || 'Previous Dues Payment',
                                ReferenceNo || null,
                                auditUser,
                                recoveryDate
                            ]);

                            console.log(`Previous dues amount ${amountToAdd} recorded in ${payment_method} and recoveries table`);
                            const recoveryId = recoveryResult.insertId;

                            // ============================================================
                            // INSERT INTO SETTLEMENTS TABLE
                            // ============================================================
                            const settlementQuery = `
                            INSERT INTO settlements (
                                recovery_id,
                                client_id,
                                depo_id,
                                amount,
                                settlement_type,
                                reference_no,
                                settlement_date,
                                CB,
                                CD,
                                MD,
                                Active
                            ) VALUES (?, ?, ?, ?, 'PAYMENT_TO_SUPPLIER', ?, ?, ?, NOW(), NOW(), 1)
                        `;

                            const [settlementResult] = await connection.execute(settlementQuery, [
                                recoveryId,
                                ClientID,
                                DepoID,
                                amountToAdd,
                                ReferenceNo || null,
                                recoveryDate,
                                auditUser
                            ]);

                            const settlementId = settlementResult.insertId;
                            // Insert into advance_balance table
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
                                ) VALUES (?, null, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                                [DepoID, recoveryId, amountToAdd, newAdvanceBalance, auditUser]
                            );

                            console.log(`[CASH] Added ${amountToAdd} to advance_balance for depo ${DepoID}. New balance: ${newAdvanceBalance}`);
                        }


                    }


                }



                // STEP 4: If remaining amount > 0, process trip payments
                let clientTripsWithBalance = [];
                let tripIdForRecovery = null;
                let totalAllocated = 0;
                const recoveryTransactionId = `REC-${Date.now()}-${ClientID}`;
                let settlementId = null;
                let amountToAdvanceBalance = 0;
                let depoIdForAdvanceBalance = null;
                let limitEntryId = null;
                let purchaseType = 'credit';
                let tableName = 'pool';
                let depoLimitColumn = 'Balance';
                let amountToLimit = 0;
                let recoveryId = null;

                if (remainingRecoveryAmount > 0) {
                    // Get all trips with balance for this client
                    const [tripsResult] = await connection.execute(
                        `SELECT
                        ps.id as pol_sale_id,
                        ps.trip_id as id,
                        ps.total_amount as client_total,
                        COALESCE((
                            SELECT SUM(amount)
                            FROM recoveries
                            WHERE clientid = ps.client_id
                            AND trip_id = ps.trip_id
                            AND Active = 1
                        ), 0) as total_trip_recovered,
                        -- Calculate remaining per sale using FIFO
                        CASE
                            WHEN ps.id = (
                                SELECT MIN(id)
                                FROM pol_sale
                                WHERE trip_id = ps.trip_id
                                AND client_id = ps.client_id
                                AND Active = 1
                            ) THEN
                                GREATEST(0, ps.total_amount - COALESCE((
                                    SELECT SUM(amount)
                                    FROM recoveries
                                    WHERE clientid = ps.client_id
                                    AND trip_id = ps.trip_id
                                    AND Active = 1
                                ), 0))
                            ELSE
                                GREATEST(0, ps.total_amount - GREATEST(0,
                                    COALESCE((
                                        SELECT SUM(amount)
                                        FROM recoveries
                                        WHERE clientid = ps.client_id
                                        AND trip_id = ps.trip_id
                                        AND Active = 1
                    ), 0) - (
                    SELECT SUM(ps2.total_amount)
                    FROM pol_sale ps2
                    WHERE ps2.trip_id = ps.trip_id
                    AND ps2.client_id = ps.client_id
                    AND ps2.Active = 1
                    AND ps2.id < ps.id
                        )
                    ))
                    END as remaining,
                    t.start_date,
                    t.total_amount as trip_total,
                    t.amount_collected as amount_collected
                    FROM pol_sale ps
                    INNER JOIN trips t ON ps.trip_id = t.id AND t.active = 1
                    WHERE ps.client_id = ?
                    AND ps.Active = 1
                    AND t.status != 'Cancelled'
                    AND t.active = 1
                    ORDER BY t.start_date ASC, t.id ASC`,
                        [ClientID]
                    );

                    let amountToAllocate = remainingRecoveryAmount;

                    // STEP 5: Iterate through trips
                    for (const trip of tripsResult) {
                        if (amountToAllocate <= 0.01) break;

                        const tripRemaining = parseFloat(trip.remaining) || 0;
                        const isFullPayment = amountToAllocate >= tripRemaining;
                        const allocatedThisTrip = isFullPayment ? tripRemaining : amountToAllocate;
                        const newAmountCollected = (parseFloat(trip.amount_collected) || 0) + allocatedThisTrip;
                        const newRemaining = tripRemaining - allocatedThisTrip;

                        // STEP 6: Check payment mode
                        if (payment_method === 'account') {
                            // Account payment handling
                            if (trip.remaining <= 0) {
                                continue;
                            }
                            if (!AccountID) {
                                await connection.rollback();
                                connection.release();
                                return res.status(400).json({ message: 'Account ID is required for account payment' });
                            }

                            const [accountRows] = await connection.execute(
                                'SELECT Balance, BankID, AccountTitle FROM accounts WHERE ID = ? AND active = 1',
                                [AccountID]
                            );

                            if (accountRows.length === 0) {
                                await connection.rollback();
                                connection.release();
                                return res.status(404).json({ message: 'Account not found or inactive' });
                            }

                            const accountTitle = accountRows[0].AccountTitle;
                            const customerName = await getCustomerName(connection, ClientID);
                            const purpose = `Payment Received from ${customerName}`;

                            // STEP 7: Update account balance
                            await connection.execute(
                                'UPDATE accounts SET Balance = Balance + ?, MD = NOW() WHERE ID = ? AND active = 1',
                                [allocatedThisTrip, AccountID]
                            );

                            // STEP 8: Insert into transactions
                            const transactionQuery = `
                                INSERT INTO transactions (
                                    Trip_id,
                                    AccountID, 
                                    Purpose, 
                                    Debit, 
                                    Credit, 
                                    Date, 
                                    PaymentMode, 
                                    ReferenceNo,
                                    CB,
                                    CD,
                                    MD,
                                    active
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                            `;
                            /* console.log('=== Transaction Parameters ===');
                            console.log('trip.id:', trip.id);
                            console.log('AccountID:', AccountID);
                            console.log('purpose:', purpose);
                            console.log('allocatedThisTrip:', allocatedThisTrip);
                            console.log('recoveryDate:', recoveryDate);
                            console.log('PaymentMode:', PaymentMode);
                            console.log('ReferenceNo:', ReferenceNo);
                            console.log('auditUser:', auditUser);
                            console.log('recoveryDate:', recoveryDate); */

                            const [transactionResult] = await connection.execute(transactionQuery, [
                                trip.id,
                                AccountID,
                                purpose,
                                0,
                                allocatedThisTrip,
                                recoveryDate,
                                PaymentMode || null,
                                ReferenceNo || null,
                                auditUser
                            ]);

                            const transactionId = transactionResult.insertId;

                            // STEP 9: Insert into recoveries
                            await connection.execute(
                                `INSERT INTO recoveries
                                (transactionid, clientid, trip_id, amount, payment_head, reference, CD, CB,date) 
                                VALUES (?, ?, ?, ?, ?, ?, NOW(), ?,?)`,
                                [
                                    transactionId,
                                    ClientID,
                                    trip.id,
                                    allocatedThisTrip,
                                    accountTitle,
                                    ReferenceNo || null,
                                    auditUser,
                                    recoveryDate
                                ]
                            );

                            // STEP 10: Update trip_depos. no need in case of payment to owner account or cash in hand
                            /*  const [tripsWithBalanceForDepo] = await connection.execute(
                                 `SELECT t.id as tripid, t.start_date, td.id as tripdepoid,
                                 COALESCE(SUM(td.payable_amount), 0) as total_payable,
                                 COALESCE(SUM(td.paid_amount), 0) as total_paid,
                                 (COALESCE(SUM(td.payable_amount), 0) - COALESCE(SUM(td.paid_amount), 0)) as remaining
                                 FROM trips t
                                 INNER JOIN trip_depos td ON td.trip_id = t.id AND td.Active = 1 
                                 INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.Active = 1 AND ps.client_id = ?
                                 WHERE t.id = ?
                                 AND t.status != 'Cancelled'
                                 AND t.active = 1
                                 AND td.purchase_type in ('credit', 'specialcredit')
                                 GROUP BY t.id, t.start_date
                                 HAVING (COALESCE(SUM(td.payable_amount), 0) - COALESCE(SUM(td.paid_amount), 0)) > 0.01
                                 ORDER BY t.start_date ASC, t.id, td.id ASC`,
                                 [ClientID, trip.id]
                             );
 
                             let remainingPayment = allocatedThisTrip;
                             for (const tripDepo of tripsWithBalanceForDepo) {
                                 if (remainingPayment <= 0) break;
 
                                 const currentPaid = parseFloat(tripDepo.paid_amount) || 0;
                                 const remaining = parseFloat(tripDepo.remaining) || 0;
                                 const paymentToApply = Math.min(remainingPayment, remaining);
                                 const newPaid = currentPaid + paymentToApply;
 
                                 await connection.execute(
                                     `UPDATE trip_depos 
                                     SET paid_amount = ?, MD = NOW()
                                     WHERE trip_id = ? AND id = ?`,
                                     [newPaid, tripDepo.tripid, tripDepo.tripdepoid]
                                 );
 
                                 remainingPayment -= paymentToApply;
                                 console.log(`Applied ${paymentToApply} to trip_depos ${tripDepo.tripdepoid}`);
                             } */

                            // Update trip amount_collected
                            await connection.execute(
                                `UPDATE trips SET amount_collected = ? WHERE id = ?`,
                                [newAmountCollected, trip.id]
                            );

                            amountToAllocate -= allocatedThisTrip;
                            totalAllocated += allocatedThisTrip;
                            tripIdForRecovery = trip.id;

                        } else if (payment_method === 'cash_in_hand') {
                            // Cash in Hand payment
                            if (trip.remaining <= 0) {
                                continue;
                            }
                            const [lastBalanceRows] = await connection.execute(`
                                SELECT balance FROM cash_in_hand 
                                WHERE Active = 1 
                                ORDER BY created_at DESC, id DESC 
                                LIMIT 1
                            `);

                            const currentBalance = lastBalanceRows.length > 0
                                ? parseFloat(lastBalanceRows[0]?.balance || 0)
                                : 0;
                            const newBalance = currentBalance + allocatedThisTrip;

                            const customerName = await getCustomerName(connection, ClientID);
                            const purpose = `Payment Received from ${customerName}`;

                            const cashInHandQuery = `
                                INSERT INTO cash_in_hand (
                                    debit,
                                    credit,
                                    balance,
                                    purpose,
                                    created_at,
                                    CB
                                ) VALUES (0, ?, ?, ?, ?, ?)
                            `;

                            const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                                allocatedThisTrip,
                                newBalance,
                                purpose,
                                recoveryDate,
                                auditUser
                            ]);

                            const cashInHandId = cashInHandResult.insertId;

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
                                allocatedThisTrip,
                                recoveryDate,
                                trip.id
                            ]);

                            const transactionId = transactionResult.insertId;

                            await connection.execute(
                                `INSERT INTO recoveries
                              (transactionid, clientid, trip_id, amount, payment_head, reference, CD, CB,Date)
                                VALUES (?, ?, ?, ?, ?, ?, NOW(), ?,?)`,
                                [
                                    transactionId,
                                    ClientID,
                                    trip.id,
                                    allocatedThisTrip,
                                    'Cash in Hand',
                                    ReferenceNo || null,
                                    auditUser,
                                    recoveryDate
                                ]
                            );

                            // Update trip amount_collected
                            await connection.execute(
                                `UPDATE trips SET amount_collected = ? WHERE id = ?`,
                                [newAmountCollected, trip.id]
                            );

                            amountToAllocate -= allocatedThisTrip;
                            totalAllocated += allocatedThisTrip;
                            tripIdForRecovery = trip.id;

                        } else if (payment_method === 'depo') {

                            if (trip.remaining <= 0) {
                                continue;
                            }

                            // Depo payment handling
                            if (!DepoID) {
                                await connection.rollback();
                                connection.release();
                                return res.status(400).json({ message: 'Depo ID is required for depo payment' });
                            }

                            // Validate customer has purchased from this dealer
                            const [customerDepos] = await connection.execute(
                                `SELECT DISTINCT td.depo_id
                                FROM pol_sale ps
                                INNER JOIN trips t ON ps.trip_id = t.id AND t.active = 1
                                INNER JOIN trip_depos td ON ps.trip_id = td.trip_id AND td.Active = 1
                                WHERE ps.client_id = ? AND ps.Active = 1
                                AND td.depo_id IS NOT NULL`,
                                [ClientID]
                            );

                            const allowedDepoIds = customerDepos.map(row => row.depo_id);

                            if (allowedDepoIds.length > 0 && !allowedDepoIds.includes(parseInt(DepoID, 10))) {
                                await connection.rollback();
                                connection.release();
                                return res.status(400).json({
                                    message: 'This customer has not purchased from the selected dealer. Please select a dealer from which the customer has purchased.'
                                });
                            }

                            // Get the credit head from request (default to 'credit')
                            const creditHead = req.body.CreditHead || 'credit';
                            const creditHeadLower = creditHead.toLowerCase();

                            // Get depo details for balance updates
                            const [depoRows] = await connection.execute(
                                `SELECT Balance, special_credit_limit FROM depo WHERE id = ? AND active = 1`,
                                [DepoID]
                            );

                            if (depoRows.length === 0) {
                                await connection.rollback();
                                connection.release();
                                return res.status(404).json({ message: 'Depo not found or inactive' });
                            }

                            const depo = depoRows[0];

                            // ============================================================
                            // STEP 1: UPDATE TRIP_DEPOS IN FIFO ORDER FOR THIS TRIP
                            // ============================================================
                            // Determine purchase type based on credit head
                            let purchaseType = 'credit';
                            if (creditHeadLower === 'specialcredit') {
                                purchaseType = 'specialcredit';
                            } else if (creditHeadLower === 'credit') {
                                purchaseType = 'credit';
                            } else if (creditHeadLower === 'cash') {
                                // For cash, we still need to update trip_depos for the trip
                                // Use the purchase type from the trip_depos
                                const [purchaseTypeCheck] = await connection.execute(
                                    `SELECT DISTINCT td.purchase_type
            FROM trip_depos td
            INNER JOIN trips t ON t.id = td.trip_id AND t.active = 1
            INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.client_id = ? AND ps.Active = 1
            WHERE td.depo_id = ? 
            AND td.Active = 1
            AND td.purchase_type IN ('credit', 'specialcredit') AND td.trip_id = ?
            ORDER BY td.purchase_type ASC`,
                                    [ClientID, DepoID, trip.id]
                                );

                                if (purchaseTypeCheck.length > 0) {
                                    purchaseType = purchaseTypeCheck[0].purchase_type;
                                }
                            }

                            // Get trip_depos with remaining balance for this specific trip
                            const [tripDeposWithBalance] = await connection.execute(
                                `SELECT td.id, td.trip_id, td.depo_id, td.paid_amount, td.payable_amount,
        (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining,
        t.start_date
        FROM trips t
        INNER JOIN trip_depos td ON td.trip_id = t.id AND td.Active = 1 AND td.depo_id = ?
        INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.Active = 1 AND ps.client_id = ?
        WHERE t.id = ?
        AND t.status != 'Cancelled'
        AND t.active = 1
        AND td.purchase_type = ?
        AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0.01
        ORDER BY t.start_date ASC, t.id ASC, td.id ASC`,
                                [DepoID, ClientID, trip.id, purchaseType]
                            );

                            // Apply payment to trip_depos in FIFO order
                            let remainingPayment = parseFloat(allocatedThisTrip);
                            let totalAppliedToTripDepos = 0;

                            for (const tripDepo of tripDeposWithBalance) {
                                if (remainingPayment <= 0) break;

                                const currentPaid = parseFloat(tripDepo.paid_amount) || 0;
                                const remaining = parseFloat(tripDepo.remaining) || 0;
                                const paymentToApply = Math.min(remainingPayment, remaining);
                                const newPaid = currentPaid + paymentToApply;

                                await connection.execute(
                                    `UPDATE trip_depos 
            SET paid_amount = ?, MD = NOW()
            WHERE id = ?`,
                                    [newPaid, tripDepo.id]
                                );

                                remainingPayment -= paymentToApply;
                                totalAppliedToTripDepos += paymentToApply;
                                console.log(`Applied ${paymentToApply} to trip_depos ${tripDepo.id}`);
                            }

                            // ============================================================
                            // STEP 2: INSERT INTO RECOVERIES TABLE
                            // ============================================================
                            const [recoveryResult] = await connection.execute(
                                `INSERT INTO recoveries
                                    (transactionid, clientid, trip_id, amount, payment_head, reference, CD, CB,date)
                                    VALUES (?, ?, ?, ?, ?, ?, NOW(), ?,?)`,
                                [
                                    null,
                                    ClientID,
                                    trip.id,
                                    allocatedThisTrip,
                                    `Depo Payment - ${creditHead}`,
                                    ReferenceNo || null,
                                    auditUser,
                                    recoveryDate
                                ]
                            );

                            recoveryId = recoveryResult.insertId;

                            // ============================================================
                            // STEP 3: INSERT INTO SETTLEMENTS TABLE
                            // ============================================================
                            const settlementQuery = `
        INSERT INTO settlements (
            recovery_id,
            client_id,
            depo_id,
            amount,
            settlement_type,
            reference_no,
            settlement_date,
            CB,
            CD,
            MD,
            Active
        ) VALUES (?, ?, ?, ?, 'PAYMENT_TO_SUPPLIER', ?, ?, ?, NOW(), NOW(), 1)
    `;

                            const [settlementResult] = await connection.execute(settlementQuery, [
                                recoveryId,
                                ClientID,
                                DepoID,
                                allocatedThisTrip,
                                ReferenceNo || null,
                                recoveryDate,
                                auditUser
                            ]);

                            settlementId = settlementResult.insertId;

                            // ============================================================
                            // STEP 4: UPDATE BALANCES BASED ON CREDIT HEAD
                            // ============================================================
                            const amountToAdd = parseFloat(allocatedThisTrip);

                            if (creditHeadLower === 'credit') {
                                // === CREDIT: Update pool table and depo.Balance ===

                                // Get current pool limit
                                const [currentLimitRows] = await connection.execute(
                                    `SELECT DepoLimit 
            FROM pool 
            WHERE DepoID = ? AND active = 1 
            ORDER BY ID DESC 
            LIMIT 1`,
                                    [DepoID]
                                );

                                let currentDepoLimit = 0;
                                if (currentLimitRows.length > 0) {
                                    currentDepoLimit = parseFloat(currentLimitRows[0].DepoLimit || 0);
                                } else {
                                    // If no pool entry exists, get from depo table
                                    currentDepoLimit = parseFloat(depo.Balance || 0);
                                }

                                const newDepoLimit = currentDepoLimit + amountToAdd;

                                // Insert into pool table
                                await connection.execute(
                                    `INSERT INTO pool (
                DepoID, 
                TripID,
                Debit, 
                Credit, 
                DepoLimit,
                Date,
                payment_id,
                recovery_id,
                active
            ) VALUES (?, ?, 0, ?, ?, ?, NULL, ?, 1)`,
                                    [
                                        DepoID,
                                        trip.id,
                                        amountToAdd,
                                        newDepoLimit,
                                        recoveryDate,
                                        recoveryId
                                    ]
                                );

                                // Update depo.Balance
                                await connection.execute(
                                    `UPDATE depo SET Balance = Balance + ?, MD = NOW() WHERE id = ?`,
                                    [amountToAdd, DepoID]
                                );

                                console.log(`[CREDIT] Added ${amountToAdd} to pool for depo ${DepoID}. New limit: ${newDepoLimit}`);

                            } else if (creditHeadLower === 'specialcredit') {
                                // === SPECIAL CREDIT: Update special_credit_limit table and depo.special_credit_limit ===

                                // Get current special credit limit
                                const [currentLimitRows] = await connection.execute(
                                    `SELECT DepoLimit 
            FROM special_credit_limit 
            WHERE DepoID = ? AND active = 1 
            ORDER BY ID DESC 
            LIMIT 1`,
                                    [DepoID]
                                );

                                let currentDepoLimit = 0;
                                if (currentLimitRows.length > 0) {
                                    currentDepoLimit = parseFloat(currentLimitRows[0].DepoLimit || 0);
                                } else {
                                    // If no special_credit_limit entry exists, get from depo table
                                    currentDepoLimit = parseFloat(depo.special_credit_limit || 0);
                                }

                                const newDepoLimit = currentDepoLimit + amountToAdd;

                                // Insert into special_credit_limit table
                                await connection.execute(
                                    `INSERT INTO special_credit_limit (
                DepoID, 
                TripID,
                Debit, 
                Credit, 
                DepoLimit,
                Date,
                payment_id,
                recovery_id,
                active
            ) VALUES (?, ?, 0, ?, ?, ?, NULL, ?, 1)`,
                                    [
                                        DepoID,
                                        trip.id,
                                        amountToAdd,
                                        newDepoLimit,
                                        recoveryDate,
                                        recoveryId
                                    ]
                                );

                                // Update depo.special_credit_limit
                                await connection.execute(
                                    `UPDATE depo SET special_credit_limit = special_credit_limit + ?, MD = NOW() WHERE id = ?`,
                                    [amountToAdd, DepoID]
                                );

                                console.log(`[SPECIAL CREDIT] Added ${amountToAdd} to special_credit_limit for depo ${DepoID}. New limit: ${newDepoLimit}`);

                            } else if (creditHeadLower === 'cash') {
                                // === CASH: Add to advance_balance ===

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
                                const newAdvanceBalance = currentAdvanceBalance + amountToAdd;

                                // Insert into advance_balance table
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
            ) VALUES (?, ?, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                                    [DepoID, trip.id, recoveryId, amountToAdd, newAdvanceBalance, auditUser]
                                );

                                console.log(`[CASH] Added ${amountToAdd} to advance_balance for depo ${DepoID}. New balance: ${newAdvanceBalance}`);
                            }

                            // ============================================================
                            // STEP 5: UPDATE TRIPS TABLE
                            // ============================================================
                            // Calculate total paid amount for this trip from trip_depos
                            const [tripDeposSum] = await connection.execute(
                                `SELECT COALESCE(SUM(paid_amount), 0) as total_paid
        FROM trip_depos
        WHERE trip_id = ? AND Active = 1`,
                                [trip.id]
                            );
                            const totalPaidForTrip = parseFloat(tripDeposSum[0]?.total_paid || 0);

                            // Update trips paid and amount_collected
                            await connection.execute(
                                `UPDATE trips 
        SET paid = ?,
            amount_collected = ?,
            MD = NOW()
        WHERE id = ?`,
                                [totalPaidForTrip, newAmountCollected, trip.id]
                            );

                            // ============================================================
                            // STEP 6: CHECK AND CLOSE TRIP IF ALL PAYMENTS CLEARED
                            // ============================================================
                            await checkAndCloseTrip(connection, trip.id);

                            // ============================================================
                            // STEP 7: UPDATE AMOUNT TO ALLOCATE FOR REMAINING TRIPS
                            // ============================================================
                            amountToAllocate -= allocatedThisTrip;
                            totalAllocated += allocatedThisTrip;
                            tripIdForRecovery = trip.id;

                            console.log(`[DEPO RECOVERY] Completed for trip ${trip.id}: Amount=${allocatedThisTrip}, Credit Head=${creditHead}, Trip Depos Updated=${totalAppliedToTripDepos}`);

                        }//end of depo ceck
                    } //end of trips iteration

                    // After trips handle credit sales recoveries
                    const remforcreditsalesrecovery = remainingRecoveryAmount - totalAllocated;

                    console.log(`[Rem amount] to recover from credit sales: ${remforcreditsalesrecovery} `);

                    if (remforcreditsalesrecovery > 0) {
                        const [creditsalesrows] = await db.execute(
                            `SELECT COALESCE(SUM(total_amount), 0) AS total_due
                                                FROM credit_sales
                                                WHERE ws_customer_id = ? AND Active = 1`,
                            [ClientID]
                        );
                        if (creditsalesrows && creditsalesrows.length > 0) {
                            const petrolpumpDues = parseFloat(creditsalesrows[0].total_due) || 0;

                            const recoveryAmount = parseFloat(remforcreditsalesrecovery);

                            console.log(`Petrol Pump Dues from credit sales: ${petrolpumpDues}. Amount available:  ${recoveryAmount}`);

                            if (payment_method === 'account') {

                                if (!AccountID) {
                                    await connection.rollback();
                                    connection.release();
                                    return res.status(400).json({ message: 'Account ID is required for account payment' });
                                }

                                const [accountRows] = await connection.execute(
                                    'SELECT Balance, BankID, AccountTitle FROM accounts WHERE ID = ? AND active = 1',
                                    [AccountID]
                                );

                                if (accountRows.length === 0) {
                                    await connection.rollback();
                                    connection.release();
                                    return res.status(404).json({ message: 'Account not found or inactive' });
                                }

                                const accountTitle = accountRows[0].AccountTitle;
                                const customerName = await getCustomerName(connection, ClientID);
                                const purpose = `Fuel Station Recovery from ${customerName}`;

                                // STEP 7: Update account balance
                                await connection.execute(
                                    'UPDATE accounts SET Balance = Balance + ?, MD = NOW() WHERE ID = ? AND active = 1',
                                    [remforcreditsalesrecovery, AccountID]
                                );

                                // STEP 8: Insert into transactions
                                const transactionQuery = `
                                INSERT INTO transactions (
                                    Trip_id,
                                    AccountID, 
                                    Purpose, 
                                    Debit, 
                                    Credit, 
                                    Date, 
                                    PaymentMode, 
                                    ReferenceNo,
                                    CB,
                                    CD,
                                    MD,
                                    active
                                ) VALUES (null, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                                `;


                                const [transactionResult] = await connection.execute(transactionQuery, [
                                    AccountID,
                                    purpose,
                                    0,
                                    remforcreditsalesrecovery,
                                    recoveryDate,
                                    PaymentMode || null,
                                    ReferenceNo || null,
                                    auditUser
                                ]);

                                const transactionId = transactionResult.insertId;

                                //  Insert into fuel station recoveries
                                await connection.execute(
                                    `INSERT INTO fuel_station_customer_recoveries
                                (transactionid, ws_customer_id, amount, payment_mode, reference, CD, CB,recovery_date,active)
                                VALUES (?, ?, ?, ?, ?, NOW(), ?,?,1)`,
                                    [
                                        transactionId,
                                        ClientID,
                                        remforcreditsalesrecovery,
                                        accountTitle,
                                        ReferenceNo || null,
                                        auditUser,
                                        recoveryDate
                                    ]
                                );

                                console.log(`Fuel Station recovery amount ${remforcreditsalesrecovery} recorded in ${payment_method} and fuel station recoveries table`);

                            } else if (payment_method === 'cash_in_hand') {

                                const customerName = await getCustomerName(connection, ClientID);
                                const purpose = `Fuel Station Recovery from ${customerName}`;
                                // Cash in Hand payment
                                const [lastBalanceRows] = await connection.execute(`
                                    SELECT balance FROM cash_in_hand 
                                    WHERE Active = 1 
                                    ORDER BY created_at DESC, id DESC 
                                    LIMIT 1
                                `);

                                const currentBalance = lastBalanceRows.length > 0
                                    ? parseFloat(lastBalanceRows[0]?.balance || 0)
                                    : 0;
                                const newBalance = currentBalance + remforcreditsalesrecovery;

                                const cashInHandQuery = `
                                    INSERT INTO cash_in_hand (
                                        debit,
                                        credit,
                                        balance,
                                        purpose,
                                        created_at,
                                        CB
                                    ) VALUES (0, ?, ?, ?, ?, ?)
                                `;

                                const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                                    remforcreditsalesrecovery,
                                    newBalance,
                                    purpose,
                                    recoveryDate,
                                    auditUser
                                ]);

                                const cashInHandId = cashInHandResult.insertId;

                                // Insert into transactions with cash_in_hand_id
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
                                    CB,
                                    CD,
                                    MD,
                                    active
                                ) VALUES (?, NULL, ?, 0, ?, ?, 'Cash', NULL, ?, NOW(), NOW(), 1)
                            `;

                                const [transactionResult] = await connection.execute(transactionQuery, [
                                    cashInHandId,
                                    purpose,
                                    remforcreditsalesrecovery,
                                    recoveryDate,
                                    auditUser
                                ]);

                                transactionID = transactionResult.insertId;
                                //  Insert into fuel station recoveries
                                await connection.execute(
                                    `INSERT INTO fuel_station_customer_recoveries
                                (transactionid, ws_customer_id, amount, payment_mode, reference, CD, CB,recovery_date,active)
                                VALUES (?, ?, ?, ?, ?, NOW(), ?,?,1)`,
                                    [
                                        transactionId,
                                        ClientID,
                                        remforcreditsalesrecovery,
                                        'Cash in Hand',
                                        ReferenceNo || null,
                                        auditUser,
                                        recoveryDate
                                    ]
                                );
                                console.log(`Fuel Station recovery amount ${remforcreditsalesrecovery} recorded in ${payment_method} and fuel station recoveries table`);

                            } else if (payment_method === 'depo') {



                                // Depo payment handling
                                if (!DepoID) {
                                    await connection.rollback();
                                    connection.release();
                                    return res.status(400).json({ message: 'Depo ID is required for depo payment' });
                                }


                                // Get the credit head from request (default to 'credit')
                                const creditHead = req.body.CreditHead || 'credit';
                                const creditHeadLower = creditHead.toLowerCase();

                                // Get depo details for balance updates
                                const [depoRows] = await connection.execute(
                                    `SELECT Balance, special_credit_limit FROM depo WHERE id = ? AND active = 1`,
                                    [DepoID]
                                );

                                if (depoRows.length === 0) {
                                    await connection.rollback();
                                    connection.release();
                                    return res.status(404).json({ message: 'Depo not found or inactive' });
                                }

                                const depo = depoRows[0];

                                // ============================================================
                                // STEP 1: UPDATE TRIP_DEPOS IN FIFO ORDER FOR THIS TRIP
                                // ============================================================



                                // Apply payment to trip_depos in FIFO order
                                let remainingPayment = parseFloat(remforcreditsalesrecovery);
                                let totalAppliedToTripDepos = 0;



                                // ============================================================
                                // STEP 2: INSERT INTO Fuel Station RECOVERIES TABLE
                                // ============================================================

                                const [recoveryResult] = await connection.execute(
                                    `INSERT INTO fuel_station_customer_recoveries
                                (transactionid, ws_customer_id, amount, payment_mode, reference, CD, CB,recovery_date,active)
                                VALUES (?, ?, ?, ?, ?, NOW(), ?,?,1)`,
                                    [
                                        null,
                                        ClientID,
                                        remforcreditsalesrecovery,
                                        creditHead,
                                        ReferenceNo || null,
                                        auditUser,
                                        recoveryDate
                                    ]
                                );


                                const recoveryId = recoveryResult.insertId;

                                // ============================================================
                                // STEP 3: INSERT INTO SETTLEMENTS TABLE
                                // ============================================================
                                const settlementQuery = `
                                    INSERT INTO settlements (
                                        recovery_id,
                                        client_id,
                                        depo_id,
                                        amount,
                                        settlement_type,
                                        reference_no,
                                        settlement_date,
                                        CB,
                                        CD,
                                        MD,
                                        Active
                                    ) VALUES (?, ?, ?, ?, 'PAYMENT_TO_SUPPLIER', ?, ?, ?, NOW(), NOW(), 1)
                                `;

                                const [settlementResult] = await connection.execute(settlementQuery, [
                                    recoveryId,
                                    ClientID,
                                    DepoID,
                                    remforcreditsalesrecovery,
                                    ReferenceNo || null,
                                    recoveryDate,
                                    auditUser
                                ]);

                                const settlementId = settlementResult.insertId;

                                // ============================================================
                                // STEP 4: UPDATE BALANCES BASED ON CREDIT HEAD
                                // ============================================================
                                const amountToAdd = parseFloat(remforcreditsalesrecovery);

                                if (creditHeadLower === 'credit') {
                                    // === CREDIT: Update pool table and depo.Balance ===

                                    // Get current pool limit
                                    const [currentLimitRows] = await connection.execute(
                                        `SELECT DepoLimit 
                                        FROM pool 
                                        WHERE DepoID = ? AND active = 1 
                                        ORDER BY ID DESC 
                                        LIMIT 1`,
                                        [DepoID]
                                    );

                                    let currentDepoLimit = 0;
                                    if (currentLimitRows.length > 0) {
                                        currentDepoLimit = parseFloat(currentLimitRows[0].DepoLimit || 0);
                                    } else {
                                        // If no pool entry exists, get from depo table
                                        currentDepoLimit = parseFloat(depo.Balance || 0);
                                    }

                                    const newDepoLimit = currentDepoLimit + amountToAdd;

                                    // Insert into pool table
                                    await connection.execute(
                                        `INSERT INTO pool (
                                        DepoID, 
                                        TripID,
                                        Debit, 
                                        Credit, 
                                        DepoLimit,
                                        Date,
                                        payment_id,
                                        recovery_id,
                                        active
                                    ) VALUES (?, ?, 0, ?, ?, ?, NULL, ?, 1)`,
                                        [
                                            DepoID,
                                            null,
                                            amountToAdd,
                                            newDepoLimit,
                                            recoveryDate,
                                            recoveryId
                                        ]
                                    );

                                    // Update depo.Balance
                                    await connection.execute(
                                        `UPDATE depo SET Balance = Balance + ?, MD = NOW() WHERE id = ?`,
                                        [amountToAdd, DepoID]
                                    );

                                    console.log(`[CREDIT] Added ${amountToAdd} to pool for depo ${DepoID}. New limit: ${newDepoLimit}`);

                                } else if (creditHeadLower === 'specialcredit') {
                                    // === SPECIAL CREDIT: Update special_credit_limit table and depo.special_credit_limit ===

                                    // Get current special credit limit
                                    const [currentLimitRows] = await connection.execute(
                                        `SELECT DepoLimit 
                                        FROM special_credit_limit 
                                        WHERE DepoID = ? AND active = 1 
                                        ORDER BY ID DESC 
                                        LIMIT 1`,
                                        [DepoID]
                                    );

                                    let currentDepoLimit = 0;
                                    if (currentLimitRows.length > 0) {
                                        currentDepoLimit = parseFloat(currentLimitRows[0].DepoLimit || 0);
                                    } else {
                                        // If no special_credit_limit entry exists, get from depo table
                                        currentDepoLimit = parseFloat(depo.special_credit_limit || 0);
                                    }

                                    const newDepoLimit = currentDepoLimit + amountToAdd;

                                    // Insert into special_credit_limit table
                                    await connection.execute(
                                        `INSERT INTO special_credit_limit (
                                        DepoID, 
                                        TripID,
                                        Debit, 
                                        Credit, 
                                        DepoLimit,
                                        Date,
                                        payment_id,
                                        recovery_id,
                                        active
                                    ) VALUES (?, ?, 0, ?, ?, ?, NULL, ?, 1)`,
                                        [
                                            DepoID,
                                            null,
                                            amountToAdd,
                                            newDepoLimit,
                                            recoveryDate,
                                            recoveryId
                                        ]
                                    );

                                    // Update depo.special_credit_limit
                                    await connection.execute(
                                        `UPDATE depo SET special_credit_limit = special_credit_limit + ?, MD = NOW() WHERE id = ?`,
                                        [amountToAdd, DepoID]
                                    );

                                    console.log(`[SPECIAL CREDIT] Added ${amountToAdd} to special_credit_limit for depo ${DepoID}. New limit: ${newDepoLimit}`);

                                } else if (creditHeadLower === 'cash') {
                                    // === CASH: Add to advance_balance ===

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
                                    const newAdvanceBalance = currentAdvanceBalance + amountToAdd;

                                    // Insert into advance_balance table
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
                                ) VALUES (?, ?, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                                        [DepoID, null, recoveryId, amountToAdd, newAdvanceBalance, auditUser]
                                    );

                                    console.log(`[CASH] Added ${amountToAdd} to advance_balance for depo ${DepoID}. New balance: ${newAdvanceBalance}`);
                                }



                                console.log(`[DEPO RECOVERY] Completed for  Amount=${amountToAdd}, Credit Head=${creditHead}, Fuel Station Recoveries Updated.`);

                            }//end of depo ceck


                        } //end credit sales rows available check


                    }


                    // Commit transaction
                    await connection.commit();
                    connection.release();

                    console.log(`✓ Recovery of  ${Amount} completed:`);
                    console.log(`  - Total allocated: ${totalAllocated.toFixed(2)} +  ${remforcreditsalesrecovery.toFixed(2)}`);
                    console.log(`  - Remaining to allocate: ${amountToAllocate.toFixed(2)}`);

                    return res.json({
                        success: true,
                        message: 'Recovery added successfully',
                        amountDeductedFromPreviousDues: amountDeductedFromPreviousDues,
                        totalAllocated: totalAllocated,
                        remainingRecoveryAmount: remainingRecoveryAmount,
                        tripIdForRecovery: tripIdForRecovery,
                        purchaseType: purchaseType || 'credit',
                        tableUsed: tableName || 'pool',
                        amountToLimit: amountToLimit || 0,
                        amountToAdvanceBalance: amountToAdvanceBalance || 0,
                        settlementId: settlementId,
                        limitEntryId: limitEntryId
                    });
                } //end if remaining amount>0 after previous dues recovery



                await connection.commit();
                connection.release();

                return res.json({
                    success: true,
                    message: 'Recovery added successfully - Previous dues cleared',
                    amountDeductedFromPreviousDues: amountDeductedFromPreviousDues,
                    remainingRecoveryAmount: remainingRecoveryAmount
                });
            } // end if client is suplier
            else if (ClientType === 'Local') {
                // For Local recoveries, ClientID refers to customer_id in customers table
                await connection.beginTransaction();
                const _CB = resolveAuditUser(CB || 'admin@gmail.com');

                let recoveryAmount = parseFloat(Amount);

                // ================================================================
                // ✅ NEW STEP: Deduct from recoveries_advance FIRST (Local Customers)
                // ================================================================
                let adv_RecoveryAmount = parseFloat(Amount);
                let amountDeductedFromAdvance = 0;

                const [advanceRows] = await connection.execute(
                    `SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS total_advance
                     FROM recoveries_advance
                     WHERE fs_customer_id = ? AND Active = 1
                     AND (ws_customer_id IS NULL OR ws_customer_id = 0)
                     AND (pump_id IS NULL OR pump_id = 0)`,
                    [ClientID]
                );

                let clientAdvanceBalance = parseFloat(advanceRows[0]?.total_advance || 0);

                if (clientAdvanceBalance > 0 && adv_RecoveryAmount > 0) {
                    if (adv_RecoveryAmount <= clientAdvanceBalance) {
                        // Entire recovery amount is covered by advance balance
                        amountDeductedFromAdvance = adv_RecoveryAmount;
                        const newAdvanceBalance = clientAdvanceBalance - adv_RecoveryAmount;

                        // Insert Debit entry into recoveries_advance
                        await connection.execute(
                            `INSERT INTO recoveries_advance (
                                fs_customer_id,
                                entrydate,
                                Debit,
                                Credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?, ?, ?, 0, ?, ?, ?, 1)`,
                            [
                                ClientID,
                                recoveryDate,
                                amountDeductedFromAdvance,
                                newAdvanceBalance,
                                auditUser,
                                auditUser
                            ]
                        );

                        adv_RecoveryAmount = 0;
                        console.log(`Deducted ${amountDeductedFromAdvance} from recoveries_advance. New Advance Balance: ${newAdvanceBalance}`);
                    } else {
                        // Amount is greater than advance balance - empty the advance entirely
                        amountDeductedFromAdvance = clientAdvanceBalance;
                        const newAdvanceBalance = 0;

                        await connection.execute(
                            `INSERT INTO recoveries_advance (
                                fs_customer_id,
                                entrydate,
                                Debit,
                                Credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?, ?, ?, 0, ?, ?, ?, 1)`,
                            [
                                ClientID,
                                recoveryDate,
                                amountDeductedFromAdvance,
                                newAdvanceBalance,
                                auditUser,
                                auditUser
                            ]
                        );

                        adv_RecoveryAmount = adv_RecoveryAmount - clientAdvanceBalance;
                        console.log(`Deducted all recoveries_advance (${amountDeductedFromAdvance}). Remaining: ${adv_RecoveryAmount}`);
                    }
                }
                // ================================================================

                // 1. Insert into recoveries table
                const recoveryQuery = `
                    INSERT INTO fuel_station_customer_recoveries (
                        customer_id,
                        Amount,
                        recovery_date,
                        payment_mode,
                        reference,
                        CB,
                        MB
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    `;
                await connection.execute(recoveryQuery, [
                    ClientID,
                    Amount,
                    recoveryDate,
                    payment_method, // or payment_mode if that's the correct value
                    ReferenceNo || null,
                    _CB,
                    _CB
                ]);
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
                    const customerName = name || (await connection.execute('SELECT customer_name FROM fuel_station_customer WHERE customer_id = ? AND active = 1', [ClientID]))[0][0]?.name || 'Unknown Customer';
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
                        CB,
                        CD,
                        MD,
                        active
                    ) VALUES (?, ?, 0, ?, ?, ?, ?, ?,CB, NOW(), NOW(), 1)
                `;

                    const [transactionResult] = await connection.execute(transactionQuery, [
                        AccountID,
                        purpose,
                        Amount,  // Credit = Amount (money received, increases account balance)
                        recoveryDate,
                        PaymentMode || null,
                        ReferenceNo || null,
                        null // Trip ID from FIFO (oldest trip with remaining balance)
                    ]);

                    transactionID = transactionResult.insertId;

                    // 4. Update Accounts table - add amount to balance (credit increases balance)
                    const updateAccountQuery = `
                    UPDATE accounts 
                    SET Balance = Balance + ?, CB = ?,
                        MD = NOW()
                    WHERE ID = ? AND active = 1
                `;

                    const [updateResult] = await connection.execute(updateAccountQuery, [
                        Amount,
                        _CB,
                        AccountID
                    ]);

                    if (updateResult.affectedRows === 0) {
                        await connection.rollback();
                        connection.release();
                        return res.status(404).json({ message: 'Account not found or inactive' });
                    }

                } else if (payment_method === 'depo') {

                    res.json({ message: 'Invalid Option for Local customers recovery.' });
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
                    const customerName = name || (await connection.execute('SELECT customer_name FROM fuel_station_customer WHERE customer_id = ? AND active = 1', [ClientID]))[0][0]?.name || 'Unknown Customer';
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
                            CB,
                            CD,
                            MD,
                            active
                        ) VALUES (?, NULL, ?, 0, ?, ?, 'Cash', ?, ?, NOW(), NOW(), 1)
                    `;

                    // The query expects 12 columns, so we need 12 values (including CB, CD, MD, active)
                    // But the query uses NOW() for CD, MD, and 1 for active, so only 9 placeholders are needed
                    // The placeholders are: ?, NULL, ?, 0, ?, ?, 'Cash', ?, ?, NOW(), NOW(), 1
                    // So the values should be: cashInHandId, purpose, Amount, recoveryDate, tripIdForTransaction, _CB
                    // Let's match the placeholders and values:
                    const [transactionResult] = await connection.execute(transactionQuery, [
                        cashInHandId,           // cash_in_hand_id
                        purpose,                // Purpose
                        Amount,                 // Credit
                        recoveryDate,           // Date
                        null,   // trip_id
                        _CB                     // CB
                    ]);

                    transactionID = transactionResult.insertId;
                }

                //Add Advance Amount to Customer recoveries_advance table
                if (CustomerAdvance > 0) {

                    // Get current limit
                    const [currentBalanceRows] = await connection.execute(
                        `SELECT balance
                                FROM recoveries_advance
                                WHERE fs_customer_id = ? AND active = 1
                                ORDER BY ID DESC 
                                LIMIT 1`,
                        [ClientID]
                    );

                    let currentBalance = 0;
                    if (currentBalanceRows.length > 0) {
                        currentBalance = parseFloat(currentBalanceRows[0].balance || 0);
                    }

                    currentBalance += CustomerAdvance;

                    const insertQuery_ra = `
                                INSERT INTO recoveries_advance (
                                    fs_customer_id,
                                    entrydate,
                                    Debit, 
                                    Credit, 
                                    balance,
                                    CB,
                                    MB,
                                    Active
                                ) VALUES (?, ?, 0, ?, ?, ?, ?, 1)
                            `;

                    const [insertResult_ra] = await connection.execute(insertQuery_ra, [
                        ClientID,           // ws_customer_id
                        recoveryDate,       // entrydate
                        recoveryAmount,     // Credit (inflow)
                        currentBalance,     // balance
                        auditUser,          // CB
                        auditUser           // MB
                    ]);


                    const newid = insertResult_ra.insertId;
                    if (newid > 0) {
                        console.log('Advance amount updated for local customer.');
                    }

                }

                await connection.commit();
                connection.release();
                return res.json({
                    success: true,
                    message: 'Recovery added for Local/Self client'
                });
            }
            else if (ClientType === 'Self') {
                // For Supplier or Self recoveries, ClientID refers to supplier_id in depo table


                await connection.beginTransaction();

                let recoveryAmount = parseFloat(Amount);
                let remainingRecoveryAmount = recoveryAmount;
                let clientTripsWithBalance = [];
                let tripIdForRecovery = null;
                let totalAllocated = 0;
                const recoveryTransactionId = `REC-${Date.now()}-${ClientID}`;
                let settlementId = null;
                let amountToAdvanceBalance = 0;
                let depoIdForAdvanceBalance = null;
                let limitEntryId = null;
                let purchaseType = 'credit';
                let tableName = 'pool';
                let depoLimitColumn = 'Balance';
                let amountToLimit = 0;
                let recoveryId = null;





                let transactionID = null;


                // Find trips for this client with remaining balance (FIFO) - BEFORE any payment processing
                let tripIdForTransaction = null;
                remainingRecoveryAmount = parseFloat(Amount);
                let amountToAllocate = remainingRecoveryAmount;

                if (remainingRecoveryAmount > 0) {

                    const [tripsResult] = await connection.execute(
                        `SELECT
                        ps.id as pol_sale_id,
                        ps.trip_id as id,
                        ps.total_amount as client_total,
                        COALESCE((
                            SELECT SUM(amount)
                            FROM recoveries
                            WHERE pump_id = ps.pump_id
                            AND trip_id = ps.trip_id
                            AND Active = 1
                        ), 0) as total_trip_recovered,
                        -- Calculate remaining per sale using FIFO
                        CASE
                            WHEN ps.id = (
                                SELECT MIN(id)
                                FROM pol_sale
                                WHERE trip_id = ps.trip_id
                                AND pump_id = ps.pump_id
                                AND Active = 1
                            ) THEN
                                GREATEST(0, ps.total_amount - COALESCE((
                                    SELECT SUM(amount)
                                    FROM recoveries
                                    WHERE pump_id = ps.pump_id
                                    AND trip_id = ps.trip_id
                                    AND Active = 1
                                ), 0))
                            ELSE
                                GREATEST(0, ps.total_amount - GREATEST(0,
                                    COALESCE((
                                        SELECT SUM(amount)
                                        FROM recoveries
                                        WHERE pump_id = ps.pump_id
                                        AND trip_id = ps.trip_id
                                        AND Active = 1
                    ), 0) - (
                    SELECT SUM(ps2.total_amount)
                    FROM pol_sale ps2
                    WHERE ps2.trip_id = ps.trip_id
                    AND ps2.pump_id = ps.pump_id
                    AND ps2.Active = 1
                    AND ps2.id < ps.id
                        )
                    ))
                    END as remaining,
                    t.start_date,
                    t.total_amount as total_amount,
                    t.amount_collected as amount_collected
                    FROM pol_sale ps
                    INNER JOIN trips t ON ps.trip_id = t.id AND t.active = 1
                    WHERE ps.pump_id  = ?
                    AND ps.Active = 1
                    AND t.status != 'Cancelled'
                    AND t.active = 1
                    ORDER BY t.start_date ASC, t.id ASC`,
                        [ClientID]
                    );

                    clientTripsWithBalance = tripsResult;

                    // Get TripID from oldest trip with remaining balance (FIFO)
                    if (clientTripsWithBalance.length > 0) {
                        tripIdForTransaction = clientTripsWithBalance[0].id;
                    }

                    for (const trip of tripsResult) {
                        if (amountToAllocate <= 0.01) break;

                        const tripRemaining = parseFloat(trip.remaining) || 0;
                        const isFullPayment = amountToAllocate >= tripRemaining;
                        const allocatedThisTrip = isFullPayment ? tripRemaining : amountToAllocate;
                        const newAmountCollected = (parseFloat(trip.amount_collected) || 0) + allocatedThisTrip;
                        const newRemaining = tripRemaining - allocatedThisTrip;

                        // STEP 6: Check payment mode
                        if (payment_method === 'account') {
                            // Account payment handling
                            if (trip.remaining <= 0) {
                                continue;
                            }
                            if (!AccountID) {
                                await connection.rollback();
                                connection.release();
                                return res.status(400).json({ message: 'Account ID is required for account payment' });
                            }

                            const [accountRows] = await connection.execute(
                                'SELECT Balance, BankID, AccountTitle FROM accounts WHERE ID = ? AND active = 1',
                                [AccountID]
                            );

                            if (accountRows.length === 0) {
                                await connection.rollback();
                                connection.release();
                                return res.status(404).json({ message: 'Account not found or inactive' });
                            }

                            const accountTitle = accountRows[0].AccountTitle;
                            const customerName = await getPumpName(connection, ClientID);
                            const purpose = `Payment Received from ${customerName}`;

                            // STEP 7: Update account balance
                            await connection.execute(
                                'UPDATE accounts SET Balance = Balance + ?, MD = NOW() WHERE ID = ? AND active = 1',
                                [allocatedThisTrip, AccountID]
                            );

                            // STEP 8: Insert into transactions
                            const transactionQuery = `
                                INSERT INTO transactions (
                                    Trip_id,
                                    AccountID, 
                                    Purpose, 
                                    Debit, 
                                    Credit, 
                                    Date, 
                                    PaymentMode, 
                                    ReferenceNo,
                                    CB,
                                    CD,
                                    MD,
                                    active
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                            `;
                            /*   console.log('=== Transaction Parameters ===');
                              console.log('trip.id:', trip.id);
                              console.log('AccountID:', AccountID);
                              console.log('purpose:', purpose);
                              console.log('allocatedThisTrip:', allocatedThisTrip);
                              console.log('recoveryDate:', recoveryDate);
                              console.log('PaymentMode:', PaymentMode);
                              console.log('ReferenceNo:', ReferenceNo);
                              console.log('auditUser:', auditUser);
                              console.log('recoveryDate:', recoveryDate); */

                            const [transactionResult] = await connection.execute(transactionQuery, [
                                trip.id,
                                AccountID,
                                purpose,
                                0,
                                allocatedThisTrip,
                                recoveryDate,
                                PaymentMode || null,
                                ReferenceNo || null,
                                auditUser
                            ]);

                            const transactionId = transactionResult.insertId;
                            console.log('pump_id ' + ClientID);
                            // STEP 9: Insert into recoveries
                            await connection.execute(
                                `INSERT INTO recoveries
                                (transactionid, pump_id, trip_id, amount, payment_head, reference, CD, CB,date) 
                                VALUES (?, ?, ?, ?, ?, ?, NOW(), ?,?)`,
                                [
                                    transactionId,
                                    ClientID,
                                    trip.id,
                                    allocatedThisTrip,
                                    accountTitle,
                                    ReferenceNo || null,
                                    auditUser,
                                    recoveryDate
                                ]
                            );

                            // STEP 10: Update trip_depos. no need in case of payment to owner account or cash in hand
                            /*  const [tripsWithBalanceForDepo] = await connection.execute(
                                 `SELECT t.id as tripid, t.start_date, td.id as tripdepoid,
                                 COALESCE(SUM(td.payable_amount), 0) as total_payable,
                                 COALESCE(SUM(td.paid_amount), 0) as total_paid,
                                 (COALESCE(SUM(td.payable_amount), 0) - COALESCE(SUM(td.paid_amount), 0)) as remaining
                                 FROM trips t
                                 INNER JOIN trip_depos td ON td.trip_id = t.id AND td.Active = 1 
                                 INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.Active = 1 AND ps.client_id = ?
                                 WHERE t.id = ?
                                 AND t.status != 'Cancelled'
                                 AND t.active = 1
                                 AND td.purchase_type in ('credit', 'specialcredit')
                                 GROUP BY t.id, t.start_date
                                 HAVING (COALESCE(SUM(td.payable_amount), 0) - COALESCE(SUM(td.paid_amount), 0)) > 0.01
                                 ORDER BY t.start_date ASC, t.id, td.id ASC`,
                                 [ClientID, trip.id]
                             );
 
                             let remainingPayment = allocatedThisTrip;
                             for (const tripDepo of tripsWithBalanceForDepo) {
                                 if (remainingPayment <= 0) break;
 
                                 const currentPaid = parseFloat(tripDepo.paid_amount) || 0;
                                 const remaining = parseFloat(tripDepo.remaining) || 0;
                                 const paymentToApply = Math.min(remainingPayment, remaining);
                                 const newPaid = currentPaid + paymentToApply;
 
                                 await connection.execute(
                                     `UPDATE trip_depos 
                                     SET paid_amount = ?, MD = NOW()
                                     WHERE trip_id = ? AND id = ?`,
                                     [newPaid, tripDepo.tripid, tripDepo.tripdepoid]
                                 );
 
                                 remainingPayment -= paymentToApply;
                                 console.log(`Applied ${paymentToApply} to trip_depos ${tripDepo.tripdepoid}`);
                             } */

                            // Update trip amount_collected
                            await connection.execute(
                                `UPDATE trips SET amount_collected = ? WHERE id = ?`,
                                [newAmountCollected, trip.id]
                            );



                            amountToAllocate -= allocatedThisTrip;
                            totalAllocated += allocatedThisTrip;
                            tripIdForRecovery = trip.id;

                        } else if (payment_method === 'cash_in_hand') {
                            // Cash in Hand payment
                            if (trip.remaining <= 0) {
                                continue;
                            }
                            const [lastBalanceRows] = await connection.execute(`
                                SELECT balance FROM cash_in_hand 
                                WHERE Active = 1 
                                ORDER BY created_at DESC, id DESC 
                                LIMIT 1
                            `);

                            const currentBalance = lastBalanceRows.length > 0
                                ? parseFloat(lastBalanceRows[0]?.balance || 0)
                                : 0;
                            const newBalance = currentBalance + allocatedThisTrip;

                            const customerName = await getCustomerName(connection, ClientID);
                            const purpose = `Payment Received from ${customerName}`;

                            const cashInHandQuery = `
                                INSERT INTO cash_in_hand (
                                    debit,
                                    credit,
                                    balance,
                                    purpose,
                                    created_at,
                                    CB
                                ) VALUES (0, ?, ?, ?, ?, ?)
                            `;

                            const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                                allocatedThisTrip,
                                newBalance,
                                purpose,
                                recoveryDate,
                                auditUser
                            ]);

                            const cashInHandId = cashInHandResult.insertId;

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
                                allocatedThisTrip,
                                recoveryDate,
                                trip.id
                            ]);

                            const transactionId = transactionResult.insertId;
                            console.log('pump_id ' + ClientID);
                            await connection.execute(
                                `INSERT INTO recoveries
                              (transactionid, pump_id, trip_id, amount, payment_head, reference, CD, CB,Date)
                                VALUES (?, ?, ?, ?, ?, ?, NOW(), ?,?)`,
                                [
                                    transactionId,
                                    ClientID,
                                    trip.id,
                                    allocatedThisTrip,
                                    'Cash in Hand',
                                    ReferenceNo || null,
                                    auditUser,
                                    recoveryDate
                                ]
                            );

                            // Update trip amount_collected
                            await connection.execute(
                                `UPDATE trips SET amount_collected = ? WHERE id = ?`,
                                [newAmountCollected, trip.id]
                            );


                            amountToAllocate -= allocatedThisTrip;
                            totalAllocated += allocatedThisTrip;
                            tripIdForRecovery = trip.id;

                        } else if (payment_method === 'depo') {

                            if (trip.remaining <= 0) {
                                continue;
                            }


                            // Depo payment handling
                            if (!DepoID) {
                                await connection.rollback();
                                connection.release();
                                return res.status(400).json({ message: 'Depo ID is required for depo payment' });
                            }

                            // Validate customer has purchased from this dealer
                            const [customerDepos] = await connection.execute(
                                `SELECT DISTINCT td.depo_id
                                FROM pol_sale ps
                                INNER JOIN trips t ON ps.trip_id = t.id AND t.active = 1
                                INNER JOIN trip_depos td ON ps.trip_id = td.trip_id AND td.Active = 1
                                WHERE ps.pump_id = ? AND ps.Active = 1
                                AND td.depo_id IS NOT NULL`,
                                [ClientID]
                            );

                            const allowedDepoIds = customerDepos.map(row => row.depo_id);

                            if (allowedDepoIds.length > 0 && !allowedDepoIds.includes(parseInt(DepoID, 10))) {
                                await connection.rollback();
                                connection.release();
                                return res.status(400).json({
                                    message: 'This customer has not purchased from the selected dealer. Please select a dealer from which the customer has purchased.'
                                });
                            }

                            // Insert into recoveries
                            const [recoveryResult] = await connection.execute(
                                `INSERT INTO recoveries
                                (transactionid, pump_id, trip_id, amount, payment_head, reference, CD, CB,Date)
                                VALUES (?, ?, ?, ?, ?, ?, NOW(), ?,?)`,
                                [
                                    null,
                                    ClientID,
                                    trip.id,
                                    allocatedThisTrip,
                                    'Depo Payment',
                                    ReferenceNo || null,
                                    auditUser,
                                    recoveryDate
                                ]
                            );

                            recoveryId = recoveryResult.insertId;

                            // Insert into settlements
                            const settlementQuery = `
                                INSERT INTO settlements (
                                    recovery_id,
                                    client_id,
                                    depo_id,
                                    amount,
                                    settlement_type,
                                    reference_no,
                                    settlement_date,
                                    CB,
                                    CD,
                                    MD,
                                    Active
                                ) VALUES (?, ?, ?, ?, 'PAYMENT_TO_SUPPLIER', ?, ?, ?, NOW(), NOW(), 1)
                            `;

                            const [settlementResult] = await connection.execute(settlementQuery, [
                                recoveryId,
                                ClientID,
                                DepoID,
                                allocatedThisTrip,
                                ReferenceNo || null,
                                recoveryDate,
                                auditUser
                            ]);

                            settlementId = settlementResult.insertId;

                            // Determine purchase type
                            const [purchaseTypeCheck] = await connection.execute(
                                `SELECT DISTINCT td.purchase_type
                                FROM trip_depos td
                                INNER JOIN trips t ON t.id = td.trip_id AND t.active = 1
                                INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.pump_id = ? AND ps.Active = 1
                                WHERE td.depo_id = ? 
                                AND td.Active = 1
                                AND td.purchase_type IN ('credit', 'specialcredit') AND td.trip_id = ?
                                ORDER BY td.purchase_type ASC`,
                                [ClientID, DepoID, trip.id]
                            );

                            if (purchaseTypeCheck.length > 0) {
                                const hasSpecialCredit = purchaseTypeCheck.some(row => row.purchase_type === 'specialcredit');
                                if (hasSpecialCredit) {
                                    purchaseType = 'specialcredit';
                                    tableName = 'special_credit_limit';
                                    depoLimitColumn = 'special_credit_limit';
                                } else {
                                    purchaseType = 'credit';
                                    tableName = 'pool';
                                    depoLimitColumn = 'Balance';
                                }
                            }

                            // Get initial balance
                            const [initialBalanceRows] = await connection.execute(
                                `SELECT Credit as initial_balance
                                FROM ${tableName} 
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
                                : 0;

                            // Get current limit
                            const [currentLimitRows] = await connection.execute(
                                `SELECT DepoLimit 
                                FROM ${tableName} 
                                WHERE DepoID = ? AND active = 1 
                                ORDER BY ID DESC 
                                LIMIT 1`,
                                [DepoID]
                            );

                            let currentDepoLimit = 0;
                            if (currentLimitRows.length > 0) {
                                currentDepoLimit = parseFloat(currentLimitRows[0].DepoLimit || 0);
                            } else {
                                const [depoLimitRows] = await connection.execute(
                                    `SELECT ${depoLimitColumn} FROM depo WHERE id = ?`,
                                    [DepoID]
                                );
                                if (depoLimitRows.length > 0) {
                                    currentDepoLimit = parseFloat(depoLimitRows[0][depoLimitColumn] || 0);
                                }
                            }

                            const amountNeededToRecoverInitialBalance = Math.max(0, initialBalance - currentDepoLimit);
                            amountToLimit = 0;
                            amountToAdvanceBalance = 0;
                            depoIdForAdvanceBalance = DepoID;

                            if (allocatedThisTrip <= amountNeededToRecoverInitialBalance) {
                                amountToLimit = allocatedThisTrip;
                                amountToAdvanceBalance = 0;
                            } else {
                                amountToLimit = amountNeededToRecoverInitialBalance;
                                amountToAdvanceBalance = allocatedThisTrip - amountToLimit;
                            }

                            const newDepoLimit = Math.min(initialBalance, currentDepoLimit + amountToLimit);

                            // Update trip_depos
                            const [tripDeposWithBalance] = await connection.execute(
                                `SELECT td.id, td.trip_id, td.depo_id, td.paid_amount, td.payable_amount,
                                (td.payable_amount - COALESCE(td.paid_amount, 0)) as remaining,
                                t.start_date
                                FROM trips t
                                INNER JOIN trip_depos td ON td.trip_id = t.id AND td.Active = 1 AND td.depo_id = ?
                                INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.Active = 1 AND ps.client_id = ?
                                WHERE t.id = ?
                                AND t.status != 'Cancelled'
                                AND t.active = 1
                                AND td.purchase_type = ?
                                AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0.01
                                ORDER BY t.start_date ASC, t.id ASC, td.id ASC`,
                                [DepoID, ClientID, trip.id, purchaseType]
                            );

                            let remainingPayment = parseFloat(allocatedThisTrip);
                            for (const tripDepo of tripDeposWithBalance) {
                                if (remainingPayment <= 0) break;

                                const currentPaid = parseFloat(tripDepo.paid_amount) || 0;
                                const remaining = parseFloat(tripDepo.remaining) || 0;
                                const paymentToApply = Math.min(remainingPayment, remaining);
                                const newPaid = currentPaid + paymentToApply;

                                await connection.execute(
                                    `UPDATE trip_depos 
                                    SET paid_amount = ?, MD = NOW()
                                    WHERE id = ?`,
                                    [newPaid, tripDepo.id]
                                );

                                remainingPayment -= paymentToApply;
                                console.log(`Applied ${paymentToApply} to trip_depos ${tripDepo.id}`);
                            }

                            // Insert into pool/special_credit_limit table
                            if (amountToLimit > 0) {
                                const insertQuery = `
                                    INSERT INTO ${tableName} (
                                        DepoID, 
                                        TripID,
                                        Debit, 
                                        Credit, 
                                        DepoLimit,
                                        Date,
                                        payment_id,
                                        recovery_id,
                                        active
                                    ) VALUES (?, ?, 0, ?, ?, ?, NULL, ?, 1)
                                `;

                                const [insertResult] = await connection.execute(insertQuery, [
                                    DepoID,
                                    trip.id,
                                    amountToLimit,
                                    newDepoLimit,
                                    recoveryDate,
                                    recoveryId
                                ]);

                                limitEntryId = insertResult.insertId;
                                console.log(`${tableName} credit for recovery: Amount=${amountToLimit}, New DepoLimit=${newDepoLimit}`);
                            }

                            // Update trip amount_collected
                            await connection.execute(
                                `UPDATE trips SET amount_collected = ? WHERE id = ?`,
                                [newAmountCollected, trip.id]
                            );


                            amountToAllocate -= allocatedThisTrip;
                            totalAllocated += allocatedThisTrip;
                            tripIdForRecovery = trip.id;
                        } //end of depo ceck
                    } //end of trips iteration
                } //end of recoveryamount > 0


                // Handle advance_balance for depo payments
                if (payment_method === 'depo' && amountToAdvanceBalance > 0 && depoIdForAdvanceBalance) {
                    const [lastAdvanceRows] = await connection.execute(
                        `SELECT Balance FROM advance_balance 
                            WHERE DepoID = ? AND Active = 1 
                            ORDER BY ID DESC LIMIT 1`,
                        [depoIdForAdvanceBalance]
                    );

                    const currentAdvanceBalanceFromTable = lastAdvanceRows.length > 0
                        ? parseFloat(lastAdvanceRows[0].Balance || 0)
                        : 0;
                    const newAdvanceBalanceInTable = currentAdvanceBalanceFromTable + amountToAdvanceBalance;

                    await connection.execute(
                        `INSERT INTO advance_balance (
                                DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                            ) VALUES (?, ?, ?, NULL, 0, ?, ?, NOW(), NOW(), NOW(), ?, 1)`,
                        [depoIdForAdvanceBalance, tripIdForRecovery, recoveryId, amountToAdvanceBalance, newAdvanceBalanceInTable, auditUser]
                    );
                    console.log(`Advance balance credit: Amount=${amountToAdvanceBalance}, New Balance=${newAdvanceBalanceInTable}`);
                }


                //Add Advance Amount to Customer recoveries_advance table
                if (CustomerAdvance > 0) {

                    // Get current limit
                    const [currentBalanceRows] = await connection.execute(
                        `SELECT balance
                                FROM recoveries_advance
                                WHERE pump_id = ? AND active = 1
                                ORDER BY ID DESC 
                                LIMIT 1`,
                        [ClientID]
                    );

                    let currentBalance = 0;
                    if (currentBalanceRows.length > 0) {
                        currentBalance = parseFloat(currentBalanceRows[0].balance || 0);
                    }

                    currentBalance += CustomerAdvance;

                    const insertQuery_ra = `
                                INSERT INTO recoveries_advance (
                                    pump_id,
                                    entrydate,
                                    Debit, 
                                    Credit, 
                                    balance,
                                    CB,
                                    MB,
                                    Active
                                ) VALUES (?, ?, 0, ?, ?, ?, ?, 1)
                            `;

                    const [insertResult_ra] = await connection.execute(insertQuery_ra, [
                        ClientID,           // ws_customer_id
                        recoveryDate,       // entrydate
                        recoveryAmount,     // Credit (inflow)
                        currentBalance,     // balance
                        auditUser,          // CB
                        auditUser           // MB
                    ]);

                    const newid = insertResult_ra.insertId;
                    if (newid > 0) {
                        console.log('Advance amount updated for petrol pump.');
                    }

                }
                //update pump cash record
                //Get daily shift entry
                const [pumpdailyshift] = await connection.execute(
                    'SELECT id, pump_id FROM daily_sales_entries WHERE pump_id = ? AND active = 1 order by entry_date DESC Limit 1',
                    [ClientID]
                );

                const dailysalesentryid = pumpdailyshift[0].id;
                //console.log('Daily Sales Entry ' + dailysalesentryid);
                const [pumpcashinhand] = await connection.execute(
                    'SELECT id, total_cash_outflow, final_cash_in_hand FROM cash_management WHERE daily_entry_id = ? AND active = 1 Limit 1',
                    [dailysalesentryid]
                );
                //console.log('Before update, Cash Management Data ' + JSON.stringify(pumpcashinhand));

                const pumpcashid = pumpcashinhand[0].id;
                let total_cash_outflow = parseFloat(pumpcashinhand[0].total_cash_outflow) + parseFloat(recoveryAmount);
                let final_cash_in_hand = pumpcashinhand[0].final_cash_in_hand - recoveryAmount;

                //console.log('New Cash out flow ' + total_cash_outflow);
                //console.log('Pump Final Cash in hand ' + final_cash_in_hand);

                await connection.execute(
                    `UPDATE cash_management SET total_cash_outflow = ?,  final_cash_in_hand=? WHERE id = ?`,
                    [total_cash_outflow, final_cash_in_hand, pumpcashid]
                );
                /*  const [pumpcashinhandau] = await connection.execute(
                     'SELECT id, total_cash_outflow, final_cash_in_hand FROM cash_management WHERE daily_entry_id = ? AND active = 1 Limit 1',
                     [dailysalesentryid]
                 ); */
                //console.log('After update, Cash Management Data ' + JSON.stringify(pumpcashinhandau));

                await connection.execute(
                    `INSERT INTO cash_outflow_owner
                                (cash_management_id, amount, person_type, person_id, person_name, purpose, notes, approved_by, CD, CB)
                                VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, NOW(), ?)`,
                    [
                        pumpcashid,                                    // cash_management_id
                        recoveryAmount,                             // amount
                        'Trip Recovery',                               // purpose
                        'Amount Recovered for Trip',        // notes
                        auditUser,                                     // approvedby
                        auditUser                                     // CB

                    ]
                );

                await connection.commit();
                connection.release();
                return res.json({
                    success: true,
                    message: 'Recovery added for Local/Self client'
                });
            } //end client type= self check

        } catch (error) {
            await connection.rollback();
            connection.release();
            console.error('Error during recovery allocation:', error);
            return res.status(500).json({
                success: false,
                message: 'Server Error',
                error: error.message,
                sqlMessage: error.sqlMessage
            });
        }

    } catch (error) {
        console.error('Error adding recovery:', error);
        return res.status(500).json({
            success: false,
            message: 'Server Error',
            error: error.message,
            sqlMessage: error.sqlMessage
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
async function getPumpName(connection, clientId) {
    try {
        const [rows] = await connection.execute(
            'SELECT name FROM petrol_pumps WHERE id = ?',
            [clientId]
        );
        return rows.length > 0 ? (rows[0].name || `Pump ${clientId}`) : `Pump ${clientId}`;
    } catch (err) {
        console.error('Error fetching petrol pump name:', err);
        return `Pump ${clientId}`;
    }
}

async function getSelfCustomerName(connection, clientId) {
    try {
        const [rows] = await connection.execute(
            'SELECT name FROM petrol+pumps WHERE id = ?',
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
            const clientId = recovery.ClientID;

            // Step 1a: Reverse Previous_Dues deduction
            // When a recovery is deleted, we need to restore the amount that was deducted from Previous_Dues
            // Since recoveries are applied to Previous_Dues FIRST (before POL Sale dues), we restore the full recovery amount
            // Note: This might slightly over-restore if the recovery was split between Previous_Dues and trips,
            // but it's safer than under-restoring. The trip amount_collected will be reversed separately below.
            const [customerRows] = await connection.execute(
                'SELECT Previous_Dues FROM customers WHERE id = ? AND active = 1',
                [clientId]
            );

            if (customerRows.length > 0) {
                const currentPreviousDues = parseFloat(customerRows[0].Previous_Dues || 0) || 0;
                // Restore the full recovery amount to Previous_Dues
                // (The recovery was deducted from Previous_Dues first, then any remainder went to trips)
                const restoredPreviousDues = currentPreviousDues + amount;

                await connection.execute(
                    'UPDATE customers SET Previous_Dues = ?, MD = NOW() WHERE id = ?',
                    [restoredPreviousDues, clientId]
                );

                console.log(`Restored ${amount} to Previous_Dues for customer ${clientId}. New Previous_Dues: ${restoredPreviousDues}`);
            }

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

                // Step 4f: Reverse trip_depos.paid_amount and advance_balance for each depo
                for (const [depoId, totalSettlementAmount] of depoSettlementMap.entries()) {
                    // Get trip_depos entries for this depo that have paid_amount > 0 (FIFO order)
                    const [tripDeposRows] = await connection.execute(
                        `SELECT td.id, td.trip_id, td.paid_amount, td.payable_amount, t.start_date
                         FROM trip_depos td
                         INNER JOIN trips t ON t.id = td.trip_id
                         WHERE td.depo_id = ? AND td.Active = 1 AND td.paid_amount > 0
                         ORDER BY t.start_date ASC, t.id ASC, td.id ASC`,
                        [depoId]
                    );

                    let remainingToReverse = totalSettlementAmount;

                    // Reverse paid_amount from trip_depos (oldest first - FIFO reversal)
                    for (const tripDepo of tripDeposRows) {
                        if (remainingToReverse <= 0) break;

                        const currentPaid = parseFloat(tripDepo.paid_amount || 0);
                        const amountToReverse = Math.min(remainingToReverse, currentPaid);
                        const newPaid = currentPaid - amountToReverse;

                        // Update trip_depos.paid_amount
                        await connection.execute(
                            `UPDATE trip_depos SET paid_amount = ?, MD = NOW() WHERE id = ?`,
                            [newPaid, tripDepo.id]
                        );

                        remainingToReverse -= amountToReverse;
                        console.log(`Reversed ${amountToReverse} from trip_depos ${tripDepo.id}, new paid_amount: ${newPaid}`);
                    }

                    // If there's still amount remaining after reversing all trip_depos,
                    // it means that amount was added to advance_balance (table). Reverse it via a Debit entry.
                    if (remainingToReverse > 0) {
                        // Get current advance balance from advance_balance table (latest Balance)
                        const [lastAdvanceRows] = await connection.execute(
                            `SELECT Balance
                             FROM advance_balance
                             WHERE DepoID = ? AND Active = 1
                             ORDER BY ID DESC
                             LIMIT 1`,
                            [depoId]
                        );
                        const currentAdvanceBalanceFromTable = lastAdvanceRows.length > 0
                            ? parseFloat(lastAdvanceRows[0].Balance || 0)
                            : 0;

                        const newAdvanceBalanceInTable = Math.max(0, currentAdvanceBalanceFromTable - remainingToReverse);
                        const CB = resolveAuditUser(req.body, 'Admin');

                        // Insert Debit entry to advance_balance table to reverse the excess
                        await connection.execute(
                            `INSERT INTO advance_balance (
                                DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                            ) VALUES (?, NULL, ?, NULL, ?, 0, ?, NOW(), NOW(), NOW(), ?, 1)`,
                            [depoId, id, remainingToReverse, newAdvanceBalanceInTable, CB]
                        );
                        console.log(`Reversed advance_balance for depo ${depoId}: -${remainingToReverse}, new advance_balance: ${newAdvanceBalanceInTable}`);
                    }

                    // Update trips.paid and trips.amount_collected for affected trips
                    const affectedTripIds = [...new Set(tripDeposRows.map(td => td.trip_id))];
                    for (const tripId of affectedTripIds) {
                        const [tripDepoSum] = await connection.execute(
                            `SELECT 
                             COALESCE(SUM(CASE WHEN purchase_type = 'cash' THEN paid_amount ELSE 0 END), 0) as cash_paid,
                             COALESCE(SUM(paid_amount), 0) as total_collected
                             FROM trip_depos 
                             WHERE trip_id = ? AND Active = 1`,
                            [tripId]
                        );

                        const tripPaid = parseFloat(tripDepoSum[0]?.cash_paid || 0);
                        const tripCollected = parseFloat(tripDepoSum[0]?.total_collected || 0);

                        await connection.execute(
                            `UPDATE trips 
                             SET paid = ?, amount_collected = ?, MD = NOW()
                             WHERE id = ?`,
                            [tripPaid, tripCollected, tripId]
                        );
                        console.log(`Updated trip ${tripId}: paid=${tripPaid}, amount_collected=${tripCollected}`);
                    }
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

