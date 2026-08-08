const db = require('../models/db');

function resolveAuditUser(req) {
    const body = req.body || {};
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

async function insertCashInHandAdjustment(connection, amount, purpose, auditUser) {
    const adjustedAmount = Number(amount) || 0;
    if (adjustedAmount === 0) {
        return null;
    }

    const [currentBalanceRows] = await connection.execute(`
        SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
        FROM cash_in_hand
        WHERE Active = 1
    `);
    const currentBalance = parseFloat(currentBalanceRows[0]?.balance || 0) || 0;

    const creditAmount = adjustedAmount > 0 ? adjustedAmount : 0;
    const debitAmount = adjustedAmount < 0 ? Math.abs(adjustedAmount) : 0;
    const newBalance = currentBalance + creditAmount - debitAmount;

    const [result] = await connection.execute(`
        INSERT INTO cash_in_hand (
            debit,
            credit,
            balance,
            purpose,
            created_at,
            CB,
            MB
        ) VALUES (?, ?, ?, ?, NOW(), ?, ?)
    `, [
        debitAmount,
        creditAmount,
        newBalance,
        purpose || null,
        auditUser,
        auditUser
    ]);

    return result.insertId;
}

// Get all cash in hand records
/* exports.getCashInHand_old = async (req, res) => {
    try {
        const id = req.query.id;

        if (id) {
            // Get single record - simply select all columns including balance
            const query = `
                SELECT 
                    id,
                    debit,
                    credit,
                    balance,
                    purpose,
                    created_at
                FROM cash_in_hand
                WHERE id = ? AND Active = 1
            `;
            const [rows] = await db.execute(query, [id]);

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Cash in hand record not found' });
            }

            res.json(rows[0]);
        } else {
            // Get all records - simply select all columns including balance from the table
            const query = `
                SELECT 
                    id,
                    debit,
                    credit,
                    balance,
                    purpose,
                    created_at
                        FROM cash_in_hand
                WHERE Active = 1
                ORDER BY created_at DESC, id DESC
            `;
            const [rows] = await db.execute(query);
            res.json(rows);
        }
    } catch (err) {
        console.error('Error fetching cash in hand:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message,
                sqlMessage: err.sqlMessage
            });
        }
    }
}; */

exports.getCashInHand = async (req, res) => {
    let connection;

    try {
        connection = await db.getConnection();
        const id = req.query.id;

        if (id) {
            // Get single record
            const query = `
        SELECT 
          id,
          debit,
          credit,
          balance,
          purpose,
          created_at
        FROM cash_in_hand
        WHERE id = ? AND Active = 1
      `;
            const [rows] = await connection.execute(query, [id]);

            if (rows.length === 0) {
                // ✅ Let finally handle release
                return res.status(404).json({ message: 'Cash in hand record not found' });
            }

            return res.status(200).json(rows[0]);

        } else {
            // Get all records
            const query = `
        SELECT 
          id,
          debit,
          credit,
          balance,
          purpose,
          created_at
        FROM cash_in_hand
        WHERE Active = 1
        ORDER BY created_at DESC, id DESC
      `;
            const [rows] = await connection.execute(query);

            return res.status(200).json(rows);
        }

    } catch (err) {
        console.error('Error fetching cash in hand:', err);

        // Handle missing table gracefully
        if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.status(200).json([]);
        }

        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });

    } finally {
        // ✅ Always release connection
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};
// Get cash accounts for dropdown (returns default account with id = 1)
exports.getCashAccounts = async (req, res) => {
    try {
        // Return default cash account with id = 1
        res.json([{
            id: 1,
            name: 'Cash Account',
            account_number: 'CASH-001',
            is_active: 1
        }]);
    } catch (err) {
        console.error('Error fetching cash accounts:', err);
        res.json([{
            id: 1,
            name: 'Cash Account',
            account_number: 'CASH-001',
            is_active: 1
        }]);
    }
};

// Get balance for a cash account
exports.getCashInHandBalance = async (req, res) => {
    let connection;

    try {
        connection = await db.getConnection();

        // Calculate balance from sum of all active records
        const query = `
      SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
      FROM cash_in_hand
      WHERE Active = 1
    `;

        const [rows] = await connection.execute(query);
        const balance = parseFloat(rows[0]?.balance || 0);

        // Also get the latest balance from the table for verification
        const [latestRows] = await connection.execute(`
      SELECT balance
      FROM cash_in_hand
      WHERE Active = 1
      ORDER BY id DESC
      LIMIT 1
    `);

        const latestStoredBalance = latestRows.length > 0 ? parseFloat(latestRows[0]?.balance || 0) : 0;

        // Log if there's a mismatch (indicates balances need recalculation)
        if (Math.abs(balance - latestStoredBalance) > 0.01) {
            console.warn(
                `Cash in Hand balance mismatch - SUM calculation: ${balance}, ` +
                `Latest stored balance: ${latestStoredBalance}. Balances may need recalculation.`
            );
        }

        return res.status(200).json({
            balance: Number(balance)
        });

    } catch (err) {
        console.error('Error fetching balance:', err);
        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};

// Get cash in hand records by date (grouped)
exports._getCashInHandByDate = async (req, res) => {
    let connection;

    try {
        connection = await db.getConnection();

        // Get the last active record for each date with its balance value
        // Using a more efficient approach with GROUP BY
        const query = `
      SELECT 
        DATE(created_at) as date,
        balance
      FROM cash_in_hand
      WHERE Active = 1
      AND id IN (
        SELECT MAX(id)
        FROM cash_in_hand
        WHERE Active = 1
        GROUP BY DATE(created_at)
      )
      ORDER BY DATE(created_at) DESC, id DESC
    `;

        const [rows] = await connection.execute(query);

        // Map results to expected format
        const result = rows.map(row => ({
            date: row.date,
            balance: parseFloat(row.balance || 0)
        }));

        return res.status(200).json(result);

    } catch (err) {
        console.error('Error fetching cash in hand by date:', err);
        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};

exports.getCashInHandByDate = async (req, res) => {
    let connection;

    try {
        connection = await db.getConnection();

        // Most efficient: Using SUM() as window function
        const query = `
            WITH daily_changes AS (
                SELECT 
                    DATE(created_at) as date,
                    COALESCE(SUM(credit - debit), 0) AS daily_change
                FROM cash_in_hand
                WHERE Active = 1
                GROUP BY DATE(created_at)
            )
            SELECT 
                date,
                SUM(daily_change) OVER (ORDER BY date ASC) AS balance
            FROM daily_changes
            ORDER BY date DESC
        `;

        const [rows] = await connection.execute(query);

        const result = rows.map(row => ({
            date: row.date,
            balance: Number(Number(row.balance).toFixed(2))
        }));

        return res.status(200).json(result);

    } catch (err) {
        console.error('Error fetching cash in hand by date:', err);
        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};

// Get cash in hand history for a specific date
exports._getCashInHandHistoryByDate = async (req, res) => {
    let connection;

    try {
        connection = await db.getConnection();
        const date = req.query.date;
        console.log('Date:', date);

        if (!date) {
            // ✅ Let finally handle release
            return res.status(400).json({ message: 'Date is required' });
        }

        // Ensure date is in YYYY-MM-DD format
        let formattedDate = date;
        if (date && typeof date === 'string') {
            // If date includes time or other format, extract just the date part
            formattedDate = date.split('T')[0].split(' ')[0];
        }

        console.log('Fetching history for date:', date, 'Formatted:', formattedDate);

        // ✅ Use DATE() to match all records for the day regardless of time
        const [rows] = await connection.execute(
            `SELECT 
        id,
        debit,
        credit,
        balance,
        purpose,
        created_at
      FROM cash_in_hand
      WHERE DATE(created_at) = ? AND Active = 1
      ORDER BY id ASC`,
            [formattedDate]
        );

        const [openbalance] = await connection.execute(`SELECT
            COALESCE(SUM(credit - debit), 0) AS opening_balance
            FROM cash_in_hand
            WHERE DATE(created_at) < ?
            AND Active = 1`, [formattedDate]);

        const [todayrows] = await connection.execute(`SELECT
            id,
            debit,
            credit,
            purpose,
            created_at
            FROM cash_in_hand
            WHERE DATE(created_at)=?
            AND Active=1
            ORDER BY id`, [formattedDate]);

        // ✅ Calculate running balance (if you want to recalculate from transactions)
        // This is useful if stored balances might be incorrect
        let runningBalance = 0;
        const result = rows.map(row => {
            runningBalance = runningBalance + (Number(row.credit) || 0) - (Number(row.debit) || 0);
            return {
                ...row,
                debit: Number(row.debit) || 0,
                credit: Number(row.credit) || 0,
                balance: Number(row.balance) || 0,
                running_balance: Number(runningBalance.toFixed(2))
            };
        });

        return res.status(200).json(result);

    } catch (err) {
        console.error('Error fetching cash in hand history:', err);
        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};

exports.getCashInHandHistoryByDate = async (req, res) => {
    let connection;

    try {
        connection = await db.getConnection();

        const date = req.query.date;

        if (!date) {
            return res.status(400).json({
                message: 'Date is required'
            });
        }

        const formattedDate = date.split('T')[0].split(' ')[0];

        // Calculate opening balance from ALL transactions before the selected date
        const [openingRows] = await connection.execute(
            `SELECT COALESCE(SUM(credit - debit), 0) AS opening_balance
             FROM cash_in_hand
             WHERE DATE(created_at) < ?
             AND Active = 1`,
            [formattedDate]
        );

        let runningBalance = Number(openingRows[0].opening_balance) || 0;

        // Get transactions for the selected date
        const [rows] = await connection.execute(
            `SELECT
                id,
                debit,
                credit,
                purpose,
                created_at
             FROM cash_in_hand
             WHERE DATE(created_at) = ?
             AND Active = 1
             ORDER BY id ASC`,
            [formattedDate]
        );

        const result = rows.map(row => {
            const debit = Number(row.debit) || 0;
            const credit = Number(row.credit) || 0;

            runningBalance = runningBalance + credit - debit;

            return {
                id: row.id,
                purpose: row.purpose,
                created_at: row.created_at,
                debit: debit,
                credit: credit,
                balance: Number(runningBalance.toFixed(2))  // ← This is what frontend expects
            };
        });

        // Return just the array, not an object with opening_balance
        return res.status(200).json(result);

    } catch (err) {
        console.error(err);

        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });

    } finally {
        if (connection) connection.release();
    }
};
// Add cash in hand record
exports.addCashInHand = async (req, res) => {
    let connection;

    try {
        const auditUser = resolveAuditUser(req);
        const { debit, purpose } = req.body;

        // ✅ Validate BEFORE connecting
        const creditAmount = debit;
        if (!creditAmount || creditAmount <= 0) {
            return res.status(400).json({ message: 'Amount must be greater than 0' });
        }

        // ✅ Connect AFTER validation
        connection = await db.getConnection();
        await connection.beginTransaction();

        // Get current balance and calculate new balance
        const [currentBalanceRows] = await connection.execute(
            `SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
       FROM cash_in_hand
       WHERE Active = 1`
        );
        const currentBalance = parseFloat(currentBalanceRows[0]?.balance || 0);
        const newBalance = currentBalance + creditAmount; // Credit adds to balance

        // Prepare query with or without date
        let query, queryParams;

        if (req.body.date) {
            query = `
        INSERT INTO cash_in_hand (
          debit,
          credit,
          balance,
          purpose,
          created_at,
          CB,
          MB
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
            queryParams = [
                0, // debit = 0 (cash received, no debit)
                creditAmount,
                newBalance,
                purpose || null,
                req.body.date,
                auditUser,
                auditUser
            ];
        } else {
            query = `
        INSERT INTO cash_in_hand (
          debit,
          credit,
          balance,
          purpose,
          CB,
          MB
        ) VALUES (?, ?, ?, ?, ?, ?)
      `;
            queryParams = [
                0, // debit = 0 (cash received, no debit)
                creditAmount,
                newBalance,
                purpose || null,
                auditUser,
                auditUser
            ];
        }

        console.log('Add Cash in Hand - Amount:', creditAmount, 'New Balance:', newBalance);

        const [result] = await connection.execute(query, queryParams);

        console.log('Cash in hand added successfully with ID:', result.insertId);

        // ✅ Commit - NO manual release here
        await connection.commit();

        return res.status(200).json({
            message: 'Cash in hand added successfully',
            id: result.insertId,
            new_balance: newBalance
        });

    } catch (err) {
        // ✅ Rollback if transaction was started
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackErr) {
                console.error('Rollback error:', rollbackErr);
            }
        }

        console.error('Error adding cash in hand:', err);

        // Handle specific errors
        if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({
                message: 'cash_in_hand table does not exist. Please create the table first.'
            });
        }

        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });

    } finally {
        // ✅ Single release point
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};
// Update cash in hand record
exports.updateCashInHand = async (req, res) => {
    let connection;

    try {
        const auditUser = resolveAuditUser(req);
        console.log('Received update cash in hand data:', req.body);

        const { id, debit, purpose, date } = req.body;

        // ✅ Validate first
        if (!id) {
            return res.status(400).json({ message: 'Record ID is required' });
        }

        if (!debit || debit <= 0) {
            return res.status(400).json({ message: 'Debit amount must be greater than 0' });
        }

        // ✅ Connect after validation
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Check if record exists and get current values
        const [existingRecord] = await connection.execute(
            `SELECT id, debit, credit, balance, purpose, created_at
       FROM cash_in_hand
       WHERE id = ? AND Active = 1`,
            [id]
        );

        if (existingRecord.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Cash in hand record not found' });
        }

        // 2. Check if record is referenced in transactions table
        try {
            const [transactionRows] = await connection.execute(
                `SELECT COUNT(*) as count
         FROM transactions
         WHERE cash_in_hand_id = ?`,
                [id]
            );

            const transactionCount = transactionRows[0]?.count || 0;
            if (transactionCount > 0) {
                await connection.rollback();
                return res.status(400).json({
                    message: 'Cannot update: This record is referenced in transactions table.'
                });
            }
        } catch (checkErr) {
            // If table doesn't exist, continue with update
            if (checkErr.code !== 'ER_NO_SUCH_TABLE') {
                throw checkErr;
            }
        }

        // 3. Get the record before update to adjust balance
        const oldDebit = parseFloat(existingRecord[0].debit || 0);
        const diff = debit - oldDebit;

        // 4. Update all subsequent records' balances
        if (diff !== 0) {
            // Update the current record and all records after it
            await connection.execute(
                `UPDATE cash_in_hand
         SET balance = balance - ?
         WHERE id >= ? AND Active = 1
         ORDER BY id ASC`,
                [diff, id]
            );
        }

        // 5. Update the record itself
        const formattedDate = date || existingRecord[0].created_at;

        const [result] = await connection.execute(
            `UPDATE cash_in_hand SET
        debit = ?,
        purpose = ?,
        created_at = ?,
        MB = ?,
        MD = NOW()
      WHERE id = ? AND Active = 1`,
            [
                debit || 0,
                purpose || existingRecord[0].purpose || null,
                formattedDate || null,
                auditUser,
                id
            ]
        );

        // 6. Get the updated balance
        const [updatedRecord] = await connection.execute(
            `SELECT balance
       FROM cash_in_hand
       WHERE id = ? AND Active = 1`,
            [id]
        );

        const newBalance = updatedRecord.length > 0 ? parseFloat(updatedRecord[0].balance || 0) : 0;

        // ✅ Commit - NO manual release here
        await connection.commit();

        return res.status(200).json({
            message: 'Cash in hand updated successfully',
            id: id,
            new_balance: newBalance,
            updated_fields: {
                debit: debit,
                purpose: purpose || existingRecord[0].purpose,
                created_at: formattedDate
            }
        });

    } catch (err) {
        // ✅ Rollback if transaction was started
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackErr) {
                console.error('Rollback error:', rollbackErr);
            }
        }

        console.error('Error updating cash in hand:', err);

        if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({
                message: 'cash_in_hand table does not exist. Please create the table first.'
            });
        }

        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });

    } finally {
        // ✅ Single release point
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};

// ============================================
// CHECK CASH IN HAND REFERENCES - FIXED
// ============================================
exports.checkCashInHandReferences = async (req, res) => {
    let connection;

    try {
        const id = req.query.id;

        if (!id) {
            return res.status(400).json({ message: 'Record ID is required' });
        }

        const recordId = parseInt(id, 10);
        if (isNaN(recordId) || recordId <= 0) {
            return res.status(400).json({ message: 'Valid Record ID is required' });
        }

        console.log(`[checkCashInHandReferences] Checking references for record ID: ${recordId}`);

        connection = await db.getConnection();
        console.log('[checkCashInHandReferences] Database connection established');

        // Check if the record exists
        const [recordExists] = await connection.execute(
            'SELECT id FROM cash_in_hand WHERE id = ? AND Active = 1',
            [recordId]
        );

        if (recordExists.length === 0) {
            return res.status(200).json({
                id: recordId,
                is_referenced: false,
                transaction_count: 0,
                expense_count: 0,
                record_exists: false
            });
        }

        let transactionCount = 0;
        let isReferenced = false;

        // Check references in transactions table
        try {
            const [columnCheck] = await connection.execute(
                "SELECT COUNT(*) as count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'cash_in_hand_id'"
            );

            if (columnCheck[0]?.count > 0) {
                const [transactionRows] = await connection.execute(
                    'SELECT COUNT(*) as count FROM transactions WHERE cash_in_hand_id = ? AND Active = 1',
                    [recordId]
                );
                transactionCount = transactionRows[0]?.count || 0;
                isReferenced = transactionCount > 0;
            }
        } catch (checkErr) {
            console.error('[checkCashInHandReferences] Error checking transactions:', checkErr);
        }

        console.log(`[checkCashInHandReferences] Result: is_referenced=${isReferenced}, count=${transactionCount}`);

        return res.status(200).json({
            id: recordId,
            is_referenced: isReferenced,
            transaction_count: transactionCount,
            expense_count: 0,
            record_exists: true
        });

    } catch (err) {
        console.error('[checkCashInHandReferences] Fatal Error:', err);
        return res.status(200).json({
            id: parseInt(req.query.id) || null,
            is_referenced: false,
            transaction_count: 0,
            expense_count: 0,
            record_exists: false
        });
    } finally {
        if (connection) {
            try {
                connection.release();
                console.log('[checkCashInHandReferences] Connection released');
            } catch (releaseErr) {
                console.error('[checkCashInHandReferences] Error releasing connection:', releaseErr.message);
            }
        }
    }
};
// Delete cash in hand record
exports.deleteCashInHand = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Record ID is required' });
        }

        // Check if record is referenced before deleting
        const transactionQuery = `
            SELECT COUNT(*) as count
            FROM transactions
            WHERE cash_in_hand_id = ?
        `;

        try {
            const [transactionRows] = await db.execute(transactionQuery, [id]);

            const transactionCount = transactionRows[0]?.count || 0;

            if (transactionCount > 0) {
                return res.status(400).json({
                    message: 'Cannot delete: This record is referenced in transactions table.'
                });
            }
        } catch (checkErr) {
            // If tables don't exist, continue with delete
            if (checkErr.code !== 'ER_NO_SUCH_TABLE') {
                throw checkErr;
            }
        }

        // Get connection for transaction
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const query = 'DELETE FROM cash_in_hand WHERE id = ?';
            const [result] = await connection.execute(query, [id]);

            if (result.affectedRows === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Cash in hand record not found' });
            }

            // Recalculate all balances after deletion
            await recalculateAllBalances(connection);

            await connection.commit();
            connection.release();

            res.json({ message: 'Cash in hand record deleted successfully' });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error deleting cash in hand:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Transfer funds from cash in hand to bank account
exports.transferToBank = async (req, res) => {
    let connection;

    try {
        const auditUser = resolveAuditUser(req);
        const { accountId, amount, purpose, date, paymentMode, referenceNo } = req.body;

        // ✅ Validate FIRST before connecting
        if (!accountId) {
            return res.status(400).json({ message: 'Bank account ID is required' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ message: 'Amount must be greater than 0' });
        }

        // ✅ Connect AFTER validation
        connection = await db.getConnection();
        await connection.beginTransaction();

        // Check if account exists and is active
        const [accountRows] = await connection.execute(
            `SELECT 
        ID,
        BankID,
        AccountTitle,
        AccountNo,
        Balance
       FROM accounts 
       WHERE ID = ? AND active = 1`,
            [accountId]
        );

        if (accountRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Bank account not found or inactive' });
        }

        const accountInfo = accountRows[0];
        const currentAccountBalance = parseFloat(accountInfo.Balance) || 0;

        // Check cash in hand balance
        const [cashBalanceRows] = await connection.execute(
            `SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
       FROM cash_in_hand
       WHERE Active = 1`
        );
        const currentCashBalance = parseFloat(cashBalanceRows[0]?.balance || 0);

        if (currentCashBalance < amount) {
            await connection.rollback();
            return res.status(400).json({
                message: `Insufficient cash in hand balance. Available: ${currentCashBalance.toFixed(2)}, Required: ${amount.toFixed(2)}`
            });
        }

        // Format date
        const formattedDate = date || new Date().toISOString().slice(0, 19).replace('T', ' ');

        // Get bank name
        let bankName = 'Bank';
        if (accountInfo.BankID) {
            try {
                const [bankRows] = await connection.execute(
                    'SELECT Name FROM bank WHERE ID = ? AND active = 1',
                    [accountInfo.BankID]
                );
                if (bankRows.length > 0) {
                    bankName = bankRows[0].Name || bankName;
                }
            } catch (bankErr) {
                console.error('Error fetching bank name:', bankErr);
            }
        }

        const accountTitle = accountInfo.AccountTitle || '';
        const accountNo = accountInfo.AccountNo || '';
        const basePurpose = purpose || 'Transfer to Bank Account';
        const transferPurpose = `${basePurpose} - ${bankName} / ${accountTitle}${accountNo ? ' (' + accountNo + ')' : ''}`;

        // Step 1: Add debit entry to cash_in_hand (money going out)
        const newCashBalance = currentCashBalance - amount;
        const [cashInHandResult] = await connection.execute(
            `INSERT INTO cash_in_hand (
        debit,
        credit,
        balance,
        purpose,
        created_at,
        CB,
        MB
      ) VALUES (?, 0, ?, ?, ?, ?, ?)`,
            [amount, newCashBalance, transferPurpose, formattedDate, auditUser, auditUser]
        );

        const cashInHandId = cashInHandResult.insertId;

        // Step 2: Update bank account balance (add amount)
        const newAccountBalance = currentAccountBalance + amount;
        await connection.execute(
            'UPDATE accounts SET Balance = ?, MB = ?, MD = NOW() WHERE ID = ?',
            [newAccountBalance, auditUser, accountId]
        );

        // Step 3: Add transaction record
        const [transactionResult] = await connection.execute(
            `INSERT INTO transactions (
        AccountID,
        cash_in_hand_id,
        Purpose,
        Debit,
        Credit,
        Date,
        PaymentMode,
        ReferenceNo,
        active
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1)`,
            [
                accountId,
                cashInHandId,
                transferPurpose,
                amount,
                formattedDate,
                paymentMode || null,
                referenceNo || null
            ]
        );

        // ✅ Commit - NO manual release here
        await connection.commit();

        return res.status(200).json({
            message: 'Funds transferred successfully',
            transactionId: transactionResult.insertId,
            cashInHandId: cashInHandId,
            newCashBalance: newCashBalance,
            newAccountBalance: newAccountBalance
        });

    } catch (err) {
        // ✅ Rollback if transaction was started
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackErr) {
                console.error('Rollback error:', rollbackErr);
            }
        }

        console.error('Error transferring funds:', err);
        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });

    } finally {
        // ✅ Single release point
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};

exports.getCashinHandTransfers = async (req, res) => {
    let connection;

    try {
        const { pumpId, date } = req.query;

        if (!pumpId || !date) {
            return res.status(400).json({ message: 'pumpId and date are required' });
        }

        const pumpIdNum = parseInt(pumpId, 10);
        if (isNaN(pumpIdNum) || pumpIdNum <= 0) {
            return res.status(400).json({ message: 'Valid pumpId is required' });
        }

        connection = await db.getConnection();

        // 1. Get daily_entry_id from daily_sales_entries
        const [dailyEntries] = await connection.execute(
            `SELECT id, CD 
       FROM daily_sales_entries
       WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1
       LIMIT 1`,
            [pumpIdNum, date]
        );

        if (dailyEntries.length === 0) {
            return res.status(200).json({
                cdDateTime: null,
                dailyEntryId: null,
                transfers: []
            });
        }

        const dailyEntryId = dailyEntries[0].id;
        const cdDateTime = dailyEntries[0].CD;

        // 2. Get cash_management_id
        const [cashMgmtRows] = await connection.execute(
            `SELECT id 
       FROM cash_management
       WHERE daily_entry_id = ? AND Active = 1
       ORDER BY id DESC 
       LIMIT 1`,
            [dailyEntryId]
        );

        if (cashMgmtRows.length === 0) {
            return res.status(200).json({
                cdDateTime,
                dailyEntryId,
                transfers: []
            });
        }

        const cashManagementId = cashMgmtRows[0].id;

        // 3. Get transfers
        const [transfers] = await connection.execute(
            `SELECT 
        id, 
        amount, 
        recipient_name, 
        recipient_role, 
        reason, 
        receipt_number
       FROM cash_outflow_net
       WHERE cash_management_id = ? AND Active = 1
       ORDER BY id ASC`,
            [cashManagementId]
        );

        return res.status(200).json({
            cdDateTime,
            dailyEntryId,
            transfers
        });

    } catch (err) {
        console.error('Error fetching cash in hand transfers:', err);
        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};

exports.saveCashinHandTransfers = async (req, res) => {
    let connection;

    try {
        const dailyEntryId = req.body.dailyEntryId || req.body.daily_entry_id;
        const existingTransfers = req.body.existingTransfers || req.body.existing_transfers || [];
        const newTransfers = req.body.newTransfers || req.body.new_transfers || [];
        const removedIds = req.body.removedIds || req.body.removed_transfer_ids || [];
        const currentUser = req.body.currentUser || req.body.current_user;

        if (!dailyEntryId || !currentUser) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [dailyEntryRows] = await connection.execute(
            `SELECT dse.pump_id, p.name AS pump_name
            FROM daily_sales_entries dse
            JOIN petrol_pumps p ON dse.pump_id = p.id
            WHERE dse.id = ? AND dse.Active = 1
            ORDER BY dse.id DESC`,
            [dailyEntryId]
        );

        if (dailyEntryRows.length === 0) {
            await connection.rollback();
            return res.status(400).json({ message: 'Daily sales entry not found' });
        }

        const pumpName = dailyEntryRows[0].pump_name;

        const [cashMgmtRows] = await connection.execute(
            `SELECT id, total_cash_outflow, total_cash_in_hand
            FROM cash_management
            WHERE daily_entry_id = ? AND Active = 1
            ORDER BY id DESC 
            LIMIT 1`,
            [dailyEntryId]
        );

        if (cashMgmtRows.length === 0) {
            await connection.rollback();
            return res.status(400).json({ message: 'Cash management record not found' });
        }

        const cashManagementId = cashMgmtRows[0].id;
        const oldTotalCashOutflow = Number(cashMgmtRows[0].total_cash_outflow) || 0;
        const totalCashInHand = Number(cashMgmtRows[0].total_cash_in_hand) || 0;

        const [oldNetRows] = await connection.execute(
            `SELECT IFNULL(SUM(amount), 0) AS total
            FROM cash_outflow_net
            WHERE cash_management_id = ? AND Active = 1`,
            [cashManagementId]
        );
        const oldNetTotal = Number(oldNetRows[0]?.total) || 0;

        if (Array.isArray(removedIds) && removedIds.length > 0) {
            const placeholders = removedIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE cash_outflow_net 
                SET Active = 0, MD = NOW(), MB = ? 
                WHERE id IN (${placeholders})`,
                [currentUser, ...removedIds]
            );
        }

        if (Array.isArray(existingTransfers) && existingTransfers.length > 0) {
            for (const trans of existingTransfers) {
                await connection.execute(
                    `UPDATE cash_outflow_net
                    SET amount = ?, 
                        recipient_name = ?, 
                        recipient_role = ?, 
                        reason = ?,
                        receipt_number = ?, 
                        MB = ?, 
                        MD = NOW()
                    WHERE id = ? AND Active = 1`,
                    [
                        Number(trans.amount) || 0,
                        trans.recipient_name || null,
                        trans.recipient_role || null,
                        trans.reason || null,
                        trans.receipt_number || null,
                        currentUser,
                        trans.id
                    ]
                );
            }
        }

        if (Array.isArray(newTransfers) && newTransfers.length > 0) {
            for (const trans of newTransfers) {
                await connection.execute(
                    `INSERT INTO cash_outflow_net
                    (cash_management_id, amount, recipient_name, recipient_role, reason,
                        receipt_number, approved_by, CB, MB, CD, MD, Active)
                    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NOW(), NOW(), 1)`,
                    [
                        cashManagementId,
                        Number(trans.amount) || 0,
                        trans.recipient_name || null,
                        trans.recipient_role || null,
                        trans.reason || null,
                        trans.receipt_number || null,
                        currentUser,
                        currentUser
                    ]
                );
            }
        }

        const [newNetRows] = await connection.execute(
            `SELECT IFNULL(SUM(amount), 0) AS total
            FROM cash_outflow_net
            WHERE cash_management_id = ? AND Active = 1`,
            [cashManagementId]
        );
        const newNetTotal = Number(newNetRows[0]?.total) || 0;
        const netDelta = newNetTotal - oldNetTotal;
        const newTotalCashOutflow = oldTotalCashOutflow + netDelta;
        const newFinalCashInHand = totalCashInHand - newTotalCashOutflow;

        if (netDelta !== 0) {
            const purpose = `Transferred from ${pumpName}`;
            await insertCashInHandAdjustment(connection, netDelta, purpose, currentUser);
            await recalculateAllBalances(connection);
        }

        await connection.execute(
            `UPDATE cash_management
            SET total_cash_outflow = ?,
                final_cash_in_hand = ?,
                MD = NOW(),
                MB = ?
            WHERE id = ?`,
            [newTotalCashOutflow, newFinalCashInHand, currentUser, cashManagementId]
        );

        await connection.commit();

        return res.status(200).json({
            message: 'Transfers saved successfully',
            new_total_cash_outflow: newTotalCashOutflow,
            new_final_cash_in_hand: newFinalCashInHand
        });
    } catch (err) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackErr) {
                console.error('Rollback error:', rollbackErr);
            }
        }
        console.error('Error saving cash in hand transfers:', err);
        return res.status(500).json({
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};
