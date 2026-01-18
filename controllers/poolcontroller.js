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

        const query = `
            SELECT 
                p.ID,
                p.DepoID,
                p.Debit,
                p.Credit,
                p.DepoLimit,
                p.active,
                p.TripID,
                p.payment_id,
                p.recovery_id,
                d.name as DepoName,
                t.trip_no,
                pay.id as payment_display_id,
                r.id as recovery_display_id,
                c.name as customer_name
            FROM pool p
            INNER JOIN depo d ON p.DepoID = d.id
            LEFT JOIN trips t ON p.TripID = t.id
            LEFT JOIN payments pay ON p.payment_id = pay.id
            LEFT JOIN recoveries r ON p.recovery_id = r.id
            LEFT JOIN customers c ON r.ClientID = c.id AND c.active = 1
            WHERE p.DepoID = ? AND p.active = 1
            ORDER BY p.ID ASC
        `;
        const [rows] = await db.execute(query, [depoId]);
        
        // Build reason for each row
        // Priority: recovery_id > payment_id > TripID > initial balance
        const rowsWithReason = rows.map(row => {
            let reason = '';
            
            // Priority 1: Recovery (direct payment from customer)
            if (row.recovery_id && row.recovery_display_id) {
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

