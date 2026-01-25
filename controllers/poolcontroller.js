const db = require('../models/db');

// Get all pools with depo names (showing only current/latest depo limit per depo)
exports.getPools = async (req, res) => {
    try {
        const query = `
            SELECT 
                p.ID,
                p.DepoID,
                p.Debit,
                p.Credit,
                p.DepoLimit,
                p.active,
                d.name as DepoName
            FROM pool p
            INNER JOIN depo d ON p.DepoID = d.id
            INNER JOIN (
                SELECT DepoID, MAX(ID) as MaxID
                FROM pool
                WHERE active = 1
                GROUP BY DepoID
            ) latest ON p.DepoID = latest.DepoID AND p.ID = latest.MaxID
            WHERE p.active = 1
            ORDER BY d.name ASC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching pools:', err);
        console.error('Error code:', err.code);
        console.error('Error SQL state:', err.sqlState);
        console.error('Error message:', err.message);
        console.error('Full error:', JSON.stringify(err, null, 2));
        
        if (err.code === 'ER_NO_SUCH_TABLE') {
            // Table doesn't exist - return empty array
            console.log('Pool table does not exist, returning empty array');
            res.json([]);
        } else if (err.code === 'ER_BAD_FIELD_ERROR') {
            // Column doesn't exist - might be case sensitivity or wrong column name
            res.status(500).json({ 
                message: 'Database schema error', 
                error: 'One or more columns do not exist. Please run the create_pool_table.sql script to create the table.',
                details: err.message,
                hint: 'Check if the pool table exists and has the correct column names (ID, DepoID, Debit, Credit, DepoLimit, active)'
            });
        } else {
            res.status(500).json({ 
                message: 'Server Error', 
                error: err.message,
                code: err.code,
                sqlState: err.sqlState,
                hint: 'Please check server console for more details'
            });
        }
    }
};

// Get pool transaction history for a specific depo
exports.getPoolHistory = async (req, res) => {
    try {
        const depoId = req.query.depoId;
        if (!depoId) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        // Get pool entries
        const poolQuery = `
            SELECT 
                p.ID,
                p.DepoID,
                p.Debit,
                p.Credit,
                0 as AdvancePayment,
                p.DepoLimit,
                p.active,
                p.TripID,
                p.payment_id,
                p.recovery_id,
                d.name as DepoName,
                t.trip_no,
                pay.id as payment_display_id,
                r.id as recovery_display_id,
                c.name as customer_name,
                NULL as transaction_id,
                NULL as transaction_date,
                p.CD as pool_date,
                NULL as is_advance_payment
            FROM pool p
            INNER JOIN depo d ON p.DepoID = d.id
            LEFT JOIN trips t ON p.TripID = t.id
            LEFT JOIN payments pay ON p.payment_id = pay.id
            LEFT JOIN recoveries r ON p.recovery_id = r.id
            LEFT JOIN customers c ON r.ClientID = c.id AND c.active = 1
            WHERE p.DepoID = ? AND p.active = 1
        `;
        const [poolRows] = await db.execute(poolQuery, [depoId]);
        
        // Get depo name first
        const [depoNameRows] = await db.execute('SELECT name FROM depo WHERE id = ? AND active = 1', [depoId]);
        const depoName = depoNameRows.length > 0 ? depoNameRows[0].name : null;
        
        // Get advance payment transactions from advance_balance table
        let advanceRows = [];
        if (depoName) {
            // Get advance payments added (Credit entries from advance_balance table)
            const advanceAddedQuery = `
                SELECT 
                    ab.ID,
                    ab.DepoID,
                    0 as Debit,
                    0 as Credit,
                    ab.Credit as AdvancePayment,
                    NULL as DepoLimit,
                    ab.Active as active,
                    ab.TripID,
                    ab.payment_id,
                    ab.recovery_id,
                    ? as DepoName,
                    NULL as trip_no,
                    ab.payment_id as payment_display_id,
                    ab.recovery_id as recovery_display_id,
                    NULL as customer_name,
                    NULL as transaction_id,
                    ab.Date as transaction_date,
                    CASE 
                        WHEN ab.payment_id IS NOT NULL THEN CONCAT('Advance Payment (Payment #', ab.payment_id, ')')
                        WHEN ab.recovery_id IS NOT NULL THEN CONCAT('Advance Payment (Recovery #', ab.recovery_id, ')')
                        ELSE 'Advance Payment'
                    END as transaction_purpose,
                    ab.Date as pool_date,
                    1 as is_advance_payment,
                    0 as is_advance_usage,
                    0 as consumed_amount
                FROM advance_balance ab
                WHERE ab.DepoID = ?
                  AND ab.Active = 1
                  AND ab.Credit > 0
            `;
            const [advanceAddedRows] = await db.execute(advanceAddedQuery, [depoName, depoId]);
            
            // Get advance payments consumed from trip transactions
            // Read from advance_balance table Debit entries with TripID
            const advanceConsumedQuery = `
                SELECT 
                    ab.ID as advance_balance_id,
                    ab.Debit as consumed_amount,
                    ab.Date as transaction_date,
                    CONCAT('Advance Payment Used for Trip ', tr.trip_no) as transaction_purpose,
                    tr.id as trip_id
                FROM advance_balance ab
                INNER JOIN trips tr ON ab.TripID = tr.id AND tr.Active = 1
                WHERE ab.DepoID = ?
                  AND ab.Active = 1
                  AND ab.Debit > 0
                  AND ab.TripID IS NOT NULL
                ORDER BY ab.Date ASC, ab.ID ASC
            `;
            const [advanceConsumedRows] = await db.execute(advanceConsumedQuery, [depoId]);
            
            // Calculate consumed amounts for each advance payment transaction using FIFO
            // Sort advance payments by date (oldest first) and consumed transactions by date (oldest first)
            const sortedAdvancePayments = [...advanceAddedRows].sort((a, b) => {
                const dateA = new Date(a.transaction_date || 0);
                const dateB = new Date(b.transaction_date || 0);
                return dateA - dateB;
            });
            
            const sortedConsumedTransactions = [...advanceConsumedRows].sort((a, b) => {
                const dateA = new Date(a.transaction_date || 0);
                const dateB = new Date(b.transaction_date || 0);
                return dateA - dateB;
            });
            
            // Track remaining amounts for each advance payment and consumed transaction
            const advancePaymentRemaining = sortedAdvancePayments.map(ap => ({
                ...ap,
                remaining: parseFloat(ap.AdvancePayment || 0),
                consumed: 0
            }));
            
            const consumedTransactionRemaining = sortedConsumedTransactions.map(ct => ({
                ...ct,
                remaining: parseFloat(ct.consumed_amount || 0)
            }));
            
            // Allocate consumed transactions to advance payments using FIFO
            for (const consumed of consumedTransactionRemaining) {
                let remainingToAllocate = consumed.remaining;
                
                for (const advancePayment of advancePaymentRemaining) {
                    if (remainingToAllocate <= 0) break;
                    if (advancePayment.remaining <= 0) continue;
                    
                    // Check if consumed transaction date is after or equal to advance payment date
                    const advanceDate = new Date(advancePayment.transaction_date || 0);
                    const consumedDate = new Date(consumed.transaction_date || 0);
                    if (consumedDate < advanceDate) continue;
                    
                    // Allocate as much as possible
                    const allocation = Math.min(remainingToAllocate, advancePayment.remaining);
                    advancePayment.consumed += allocation;
                    advancePayment.remaining -= allocation;
                    remainingToAllocate -= allocation;
                }
            }
            
            // Update advanceAddedRows with consumed amounts from FIFO allocation
            console.log('FIFO Allocation Results:');
            console.log('Payment rows:', advancePaymentRemaining.map(ap => ({
                transaction_id: ap.transaction_id,
                date: ap.transaction_date,
                amount: ap.AdvancePayment,
                consumed: ap.consumed,
                remaining: ap.remaining
            })));
            
            advanceAddedRows.forEach((row, index) => {
                // Find the matching payment in the FIFO allocation results
                // Match by index since both arrays are sorted by date
                const matchingPayment = advancePaymentRemaining[index];
                
                if (matchingPayment && matchingPayment.consumed > 0) {
                    advanceAddedRows[index].consumed_amount = matchingPayment.consumed;
                    console.log(`Payment ${index + 1}: Payment=${matchingPayment.AdvancePayment}, Consumed=${matchingPayment.consumed}, Remaining=${matchingPayment.remaining}`);
                } else {
                    advanceAddedRows[index].consumed_amount = null; // Show blank if not consumed yet
                    console.log(`Payment ${index + 1}: Not consumed yet`);
                }
            });
            
            // Get advance payments used (from trips table)
            // Read advance_balance directly from trip_depos table for this specific depo
            // IMPORTANT: Only show if this specific depo actually used advance balance (advance_balance > 0)
            // Include both 'credit' and 'advance' purchase types
            const advanceUsedQuery = `
                SELECT 
                    NULL as ID,
                    ? as DepoID,
                    0 as Debit,
                    0 as Credit,
                    ab.Debit as AdvancePayment,
                    NULL as DepoLimit,
                    1 as active,
                    tr.id as TripID,
                    NULL as payment_id,
                    NULL as recovery_id,
                    ? as DepoName,
                    tr.trip_no,
                    NULL as payment_display_id,
                    NULL as recovery_display_id,
                    NULL as customer_name,
                    NULL as transaction_id,
                    tr.start_date as transaction_date,
                    CONCAT('Advance Payment Used for Trip ', tr.trip_no) as transaction_purpose,
                    NULL as pool_date,
                    1 as is_advance_payment,
                    1 as is_advance_usage,
                    ab.Debit as consumed_amount
                FROM advance_balance ab
                INNER JOIN trips tr ON ab.TripID = tr.id
                WHERE ab.DepoID = ?
                  AND ab.Active = 1
                  AND tr.Active = 1
                  AND ab.Debit > 0
                  AND ab.TripID IS NOT NULL
            `;
            const [advanceUsedRows] = await db.execute(advanceUsedQuery, [depoId, depoName, depoId]);
            
            // Filter out rows where AdvancePayment is 0 or null, and convert to number
            const validAdvanceUsedRows = advanceUsedRows
                .filter(row => row.AdvancePayment > 0)
                .map(row => ({
                    ...row,
                    AdvancePayment: parseFloat(row.AdvancePayment) || 0,
                    consumed_amount: parseFloat(row.consumed_amount) || 0
                }));
            
            // NOTE: Old "Advance Payment - TRIP-#" transactions from transactions table are NOT included
            // We now read advance usage directly from trip_depos.advance_balance
            // This prevents duplicate entries for consumed advance
            
            // Combine additions and usages only (no old trip transactions)
            advanceRows = [...advanceAddedRows, ...validAdvanceUsedRows];
            
            // Sort by date
            advanceRows.sort((a, b) => {
                const dateA = a.transaction_date ? new Date(a.transaction_date) : new Date(0);
                const dateB = b.transaction_date ? new Date(b.transaction_date) : new Date(0);
                if (dateA.getTime() !== dateB.getTime()) {
                    return dateA.getTime() - dateB.getTime();
                }
                return (a.transaction_id || a.TripID || 0) - (b.transaction_id || b.TripID || 0);
            });
        }
        
        // Combine pool entries and advance payments
        let allRows = [...poolRows, ...advanceRows];
        
        // Sort chronologically: by date (CD for pool entries, Date for transactions), then by ID
        allRows.sort((a, b) => {
            let dateA, dateB;
            
            if (a.is_advance_payment) {
                dateA = a.transaction_date ? new Date(a.transaction_date) : new Date(0);
            } else {
                // For pool entries, use CD (creation date)
                dateA = a.pool_date ? new Date(a.pool_date) : new Date(0);
            }
            
            if (b.is_advance_payment) {
                dateB = b.transaction_date ? new Date(b.transaction_date) : new Date(0);
            } else {
                // For pool entries, use CD (creation date)
                dateB = b.pool_date ? new Date(b.pool_date) : new Date(0);
            }
            
            // If both have dates, sort by date
            if (dateA.getTime() !== dateB.getTime() && dateA.getTime() !== 0 && dateB.getTime() !== 0) {
                return dateA.getTime() - dateB.getTime();
            }
            
            // If one has date and other doesn't, prioritize the one with date
            if (dateA.getTime() !== 0 && dateB.getTime() === 0) return -1;
            if (dateA.getTime() === 0 && dateB.getTime() !== 0) return 1;
            
            // Both are pool entries or both are advance payments, sort by ID/transaction_id
            if (a.is_advance_payment && b.is_advance_payment) {
                return (a.transaction_id || 0) - (b.transaction_id || 0);
            } else if (!a.is_advance_payment && !b.is_advance_payment) {
                return a.ID - b.ID;
            } else {
                // Mixed: use date if available, otherwise use ID
                return (a.transaction_id || a.ID || 0) - (b.transaction_id || b.ID || 0);
            }
        });
        
        // Calculate DepoLimit for advance payments (they don't affect credit limit, so use previous pool entry's limit)
        let currentDepoLimit = null;
        for (let i = 0; i < allRows.length; i++) {
            if (allRows[i].is_advance_payment) {
                // For advance payments, use the current depo limit (doesn't change)
                allRows[i].DepoLimit = currentDepoLimit;
            } else {
                // For pool entries, update current depo limit
                currentDepoLimit = allRows[i].DepoLimit;
            }
        }
        
        // Build reason for each row
        const rowsWithReason = allRows.map(row => {
            let reason = '';
            
            // Check if it's an advance payment
            if (row.is_advance_payment) {
                reason = row.transaction_purpose || `Advance Payment Added`;
            }
            // Priority 1: Recovery (direct payment from customer)
            else if (row.recovery_id && row.recovery_display_id) {
                if (row.customer_name) {
                    reason = `Direct payment from customer "${row.customer_name}" (Recovery ID: ${row.recovery_display_id})`;
                } else {
                    reason = `Direct payment from customer (Recovery ID: ${row.recovery_display_id})`;
                }
            }
            // Priority 2: Payment made to dealer
            else if (row.payment_id && row.payment_display_id) {
                reason = `Payment made to dealer (Payment ID: ${row.payment_display_id})`;
            }
            // Priority 3: Fuel purchased on credit for trip
            else if (row.TripID && row.trip_no) {
                reason = `Fuel purchased on credit for Trip ${row.trip_no}`;
            }
            // Default: Initial balance or other
            else {
                reason = 'Initial balance';
            }
            
            return {
                ...row,
                Reason: reason
            };
        });
        
        res.json(rowsWithReason);
    } catch (err) {
        console.error('Error fetching pool history:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single pool by ID
exports.getPool = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Pool ID is required' });
        }

        const query = `
            SELECT 
                p.ID,
                p.DepoID,
                p.Debit,
                p.Credit,
                p.DepoLimit,
                p.active,
                d.name as DepoName
            FROM pool p
            INNER JOIN depo d ON p.DepoID = d.id
            WHERE p.ID = ? AND p.active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Pool not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching pool:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new pool
exports.addPool = async (req, res) => {
    try {
        const {
            DepoID,
            Debit,
            Credit
        } = req.body;

        if (!DepoID) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        const debitAmount = parseFloat(Debit) || 0;
        const creditAmount = parseFloat(Credit) || 0;

        if (debitAmount === 0 && creditAmount === 0) {
            return res.status(400).json({ message: 'Either Debit or Credit amount must be greater than 0' });
        }

        if (debitAmount > 0 && creditAmount > 0) {
            return res.status(400).json({ message: 'Cannot have both Debit and Credit in the same transaction' });
        }

        // Get current depo balance from depo table
        const [depoRows] = await db.execute(
            `SELECT Balance FROM depo WHERE id = ?`,
            [DepoID]
        );

        if (depoRows.length === 0) {
            return res.status(404).json({ message: 'Depo not found' });
        }

        const currentDepoBalance = parseFloat(depoRows[0].Balance || 0);
        
        // Calculate new depo balance: Debit adds, Credit subtracts
        let newDepoBalance = currentDepoBalance;
        if (debitAmount > 0) {
            newDepoBalance = currentDepoBalance + debitAmount;
        } else if (creditAmount > 0) {
            newDepoBalance = currentDepoBalance - creditAmount;
        }

        const query = `
            INSERT INTO pool (DepoID, Debit, Credit, DepoLimit, active) 
            VALUES (?, ?, ?, ?, 1)
        `;

        const [result] = await db.execute(query, [
            DepoID,
            debitAmount,
            creditAmount,
            newDepoBalance
        ]);

        // Update depo balance
        await db.execute(
            `UPDATE depo SET Balance = ?, updated_at = NOW() WHERE id = ?`,
            [newDepoBalance, DepoID]
        );

        res.json({
            message: 'Pool added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding pool:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'pool table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update pool - updates the first entry for depo_id and recalculates all rows
exports.updatePool = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            ID,
            DepoID,
            Debit,
            Credit
        } = req.body;

        if (!ID) {
            connection.release();
            return res.status(400).json({ message: 'Pool ID is required' });
        }
        if (!DepoID) {
            connection.release();
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        const debitAmount = parseFloat(Debit) || 0;
        const creditAmount = parseFloat(Credit) || 0;

        if (debitAmount === 0 && creditAmount === 0) {
            connection.release();
            return res.status(400).json({ message: 'Either Debit or Credit amount must be greater than 0' });
        }

        if (debitAmount > 0 && creditAmount > 0) {
            connection.release();
            return res.status(400).json({ message: 'Cannot have both Debit and Credit in the same transaction' });
        }

        await connection.beginTransaction();

        // Get the FIRST entry for this depo_id (the initial amount entry)
        const [firstPoolRows] = await connection.execute(
            `SELECT ID, Debit, Credit FROM pool 
             WHERE DepoID = ? AND active = 1 
             ORDER BY ID ASC 
             LIMIT 1`,
            [DepoID]
        );

        if (firstPoolRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'No pool record found for this depo' });
        }

        const firstPoolId = firstPoolRows[0].ID;

        // Update the FIRST entry for this depo with the new amount (this becomes the initial amount)
        await connection.execute(
            `UPDATE pool SET 
                Debit = ?,
                Credit = ?
            WHERE ID = ? AND active = 1`,
            [debitAmount, creditAmount, firstPoolId]
        );

        // Get ALL records for this depo_id, ordered by ID (to recalculate from the beginning)
        const [allPools] = await connection.execute(
            `SELECT ID, Debit, Credit FROM pool 
             WHERE DepoID = ? AND active = 1 
             ORDER BY ID ASC`,
            [DepoID]
        );

        // Recalculate DepoLimit for all rows from scratch
        // Start from 0 and build up based on Debit (adds) and Credit (subtracts)
        let runningLimit = 0;
        for (const pool of allPools) {
            const poolDebit = parseFloat(pool.Debit) || 0;
            const poolCredit = parseFloat(pool.Credit) || 0;
            
            if (poolDebit > 0) {
                runningLimit = runningLimit + poolDebit;
            } else if (poolCredit > 0) {
                runningLimit = runningLimit - poolCredit;
            }

            // Update DepoLimit for this record
            await connection.execute(
                'UPDATE pool SET DepoLimit = ? WHERE ID = ?',
                [runningLimit, pool.ID]
            );
        }

        // Update depo balance to match the final running limit
        await connection.execute(
            `UPDATE depo SET Balance = ?, updated_at = NOW() WHERE id = ?`,
            [runningLimit, DepoID]
        );

        await connection.commit();
        connection.release();

        console.log(`Updated first pool entry (ID: ${firstPoolId}) for depo ${DepoID} with new initial amount and recalculated all ${allPools.length} rows`);
        res.json({ message: 'Pool updated successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error updating pool:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete pool (soft delete - set active = 0)
exports.deletePool = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Pool ID is required' });
        }

        // Soft delete: set active = 0 instead of deleting the record
        const [result] = await db.execute('UPDATE pool SET active = 0 WHERE ID = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Pool not found' });
        }

        res.json({ message: 'Pool deleted successfully' });
    } catch (err) {
        console.error('Error deleting pool:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

