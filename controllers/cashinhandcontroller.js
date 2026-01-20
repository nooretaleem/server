const db = require('../models/db');

// Helper function to recalculate all balances in cash_in_hand table
async function recalculateAllBalances(connection) {
    try {
        // Get all active records ordered by created_at and id
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

// Get all cash in hand records
exports.getCashInHand = async (req, res) => {
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
    try {
        // Calculate balance from sum of all active records (same as dashboard calculation)
        const query = `
            SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
            FROM cash_in_hand
            WHERE Active = 1
        `;
        
        const [rows] = await db.execute(query);
        const balance = parseFloat(rows[0]?.balance || 0);
        
        res.json({
            balance: Number(balance)
        });
    } catch (err) {
        console.error('Error fetching balance:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Get cash in hand records by date (grouped)
exports.getCashInHandByDate = async (req, res) => {
    try {
        // Get the last active record for each date with its balance value from the database
        const query = `
            SELECT 
                DATE_FORMAT(created_at, '%Y-%m-%d') as date,
                balance
            FROM cash_in_hand cih1
            WHERE Active = 1
            AND id = (
                SELECT MAX(id)
                FROM cash_in_hand cih2
                WHERE DATE_FORMAT(cih2.created_at, '%Y-%m-%d') = DATE_FORMAT(cih1.created_at, '%Y-%m-%d')
                AND cih2.Active = 1
            )
            ORDER BY DATE(created_at) DESC, id DESC
        `;
        
        const [rows] = await db.execute(query);
            
        // Map results to expected format
        const result = rows.map(row => ({
            date: row.date,
            balance: parseFloat(row.balance || 0)
        }));
        
        res.json(result);
    } catch (err) {
        console.error('Error fetching cash in hand by date:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Get cash in hand history for a specific date
exports.getCashInHandHistoryByDate = async (req, res) => {
    try {
        const date = req.query.date;
        
        if (!date) {
            return res.status(400).json({ message: 'Date is required' });
        }

        // Ensure date is in YYYY-MM-DD format
        let formattedDate = date;
        if (date && typeof date === 'string') {
            // If date includes time or other format, extract just the date part
            formattedDate = date.split('T')[0].split(' ')[0];
        }
        
        console.log('Fetching history for date:', date, 'Formatted:', formattedDate);
        
        // Use DATE_FORMAT to match dates properly and avoid timezone issues
        // Simply select all columns including balance from the table
        // Only show active records (Active = 1)
        // Order by balance DESC (highest first) since higher balance = earlier transaction
        // Then by created_at ASC and id ASC as tiebreakers
        const query = `
            SELECT 
                id,
                debit,
                credit,
                balance,
                purpose,
                created_at
                    FROM cash_in_hand
            WHERE DATE_FORMAT(created_at, '%Y-%m-%d') = ?
            AND Active = 1
            ORDER BY balance DESC, created_at ASC, id ASC
        `;
        
        const [rows] = await db.execute(query, [formattedDate]);
        console.log('History query result:', rows.length, 'records found');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching cash in hand history:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Add cash in hand record
exports.addCashInHand = async (req, res) => {
    try {
        console.log('Received cash in hand data:', req.body);
        
        const {
            debit,
            purpose
        } = req.body;

        // When adding cash in hand, it's cash received, so we use credit field
        // The 'debit' parameter name is kept for backward compatibility but represents credit amount
        const creditAmount = debit;
        
        if (!creditAmount || creditAmount <= 0) {
            return res.status(400).json({ message: 'Amount must be greater than 0' });
        }

        // Get connection for transaction
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Format date if provided, otherwise use NOW()
            let dateValue = 'NOW()';
            let queryParams;
            
            if (req.body.date) {
                dateValue = '?';
                queryParams = [
                    0, // debit = 0
                    creditAmount, // credit = amount received
                    purpose || null,
                    req.body.date
                ];
            } else {
                queryParams = [
                    0, // debit = 0
                    creditAmount, // credit = amount received
                    purpose || null
                ];
            }

            // Get current balance and calculate new balance
            // Credit adds to balance, Debit subtracts from balance
            // Only count active records (same as dashboard calculation)
            const [currentBalanceRows] = await connection.execute(`
                SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
                FROM cash_in_hand
                WHERE Active = 1
            `);
            const currentBalance = parseFloat(currentBalanceRows[0]?.balance || 0);
            const newBalance = currentBalance + creditAmount; // Credit adds to balance

            // Insert into cash_in_hand table (always create new row)
            const query = `
                INSERT INTO cash_in_hand (
                    debit,
                    credit,
                    balance,
                    purpose,
                    created_at
                ) VALUES (?, ?, ?, ?, ${dateValue})
            `;
            
            // Update queryParams to include balance
            if (req.body.date) {
                queryParams = [
                    0, // debit = 0 (cash received, no debit)
                    creditAmount, // credit = amount received
                    newBalance,
                    purpose || null,
                    req.body.date
                ];
            } else {
                queryParams = [
                    0, // debit = 0 (cash received, no debit)
                    creditAmount, // credit = amount received
                    newBalance,
                    purpose || null
                ];
            }
            
            console.log('Add Cash in Hand - Query parameters:', JSON.stringify(queryParams, null, 2));

            const [result] = await connection.execute(query, queryParams);
            
            console.log('Cash in hand added successfully with ID:', result.insertId);

            // Commit transaction
            await connection.commit();
            connection.release();

            res.json({
                message: 'Cash in hand added successfully',
                id: result.insertId
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error adding cash in hand:', err);
        console.error('Error details:', {
            code: err.code,
            sqlMessage: err.sqlMessage,
            sqlState: err.sqlState,
            errno: err.errno
        });
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ 
                message: 'cash_in_hand table does not exist. Please create the table first.',
                error: err.message,
                sqlMessage: err.sqlMessage
            });
        } else {
            res.status(500).json({ 
                message: 'Server Error', 
                error: err.message,
                sqlMessage: err.sqlMessage,
                code: err.code
            });
        }
    }
};

// Update cash in hand record
exports.updateCashInHand = async (req, res) => {
    try {
        console.log('Received update cash in hand data:', req.body);
        
        const {
            id,
            debit,
            purpose,
            date
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Record ID is required' });
        }

        // Check if record is referenced before updating
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
                    message: 'Cannot update: This record is referenced in transactions table.' 
                });
            }
        } catch (checkErr) {
            // If tables don't exist, continue with update
            if (checkErr.code !== 'ER_NO_SUCH_TABLE') {
                throw checkErr;
            }
        }

        if (!debit || debit <= 0) {
            return res.status(400).json({ message: 'Debit amount must be greater than 0' });
        }

        // Format date if provided
        let formattedDate = null;
        if (date) {
            formattedDate = date;
        }

        const query = `
            UPDATE cash_in_hand SET
                debit = ?,
                purpose = ?,
                created_at = ?
            WHERE id = ?
        `;

        const queryParams = [
            debit || 0,
            purpose || null,
            formattedDate || null,
            id
        ];
        
        console.log('Update Cash in Hand - Query parameters:', JSON.stringify(queryParams, null, 2));

        const [result] = await db.execute(query, queryParams);
        
        console.log('Update Cash in Hand - Update result:', result);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Cash in hand record not found' });
        }

        res.json({ message: 'Cash in hand updated successfully' });
    } catch (err) {
        console.error('Error updating cash in hand:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message,
            sqlMessage: err.sqlMessage 
        });
    }
};

// Check if cash in hand record is referenced in other tables
exports.checkCashInHandReferences = async (req, res) => {
    try {
        const id = req.query.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Record ID is required' });
        }

        // Check if referenced in transactions table
        const transactionQuery = `
            SELECT COUNT(*) as count
            FROM transactions
            WHERE cash_in_hand_id = ?
        `;
        
        try {
        const [transactionRows] = await db.execute(transactionQuery, [id]);

        const transactionCount = transactionRows[0]?.count || 0;
            const isReferenced = transactionCount > 0;

        res.json({
            id: parseInt(id),
            is_referenced: isReferenced,
            transaction_count: transactionCount,
                expense_count: 0
        });
        } catch (checkErr) {
        // If tables don't exist, assume not referenced
            if (checkErr.code === 'ER_NO_SUCH_TABLE') {
            res.json({
                    id: parseInt(id),
                is_referenced: false,
                transaction_count: 0,
                expense_count: 0
            });
        } else {
                throw checkErr;
            }
        }
    } catch (err) {
        console.error('Error checking references:', err);
            res.status(500).json({ 
                message: 'Server Error', 
                error: err.message 
            });
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
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const { accountId, amount, purpose, date, paymentMode, referenceNo } = req.body;

        // Validation
        if (!accountId) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ message: 'Bank account ID is required' });
        }

        if (!amount || amount <= 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ message: 'Amount must be greater than 0' });
        }

        // Check if account exists and is active (also get bank and account details)
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
            connection.release();
            return res.status(404).json({ message: 'Bank account not found or inactive' });
        }

        const accountInfo = accountRows[0];
        const currentAccountBalance = parseFloat(accountInfo.Balance) || 0;

        // Check cash in hand balance
        const [cashBalanceRows] = await connection.execute(`
            SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
            FROM cash_in_hand
            WHERE Active = 1
        `);
        const currentCashBalance = parseFloat(cashBalanceRows[0]?.balance || 0);

        if (currentCashBalance < amount) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ 
                message: `Insufficient cash in hand balance. Available: ${currentCashBalance.toFixed(2)}, Required: ${amount.toFixed(2)}` 
            });
        }

        // Format date
        const formattedDate = date ? date : new Date().toISOString().slice(0, 19).replace('T', ' ');

        // Build purpose including bank and account info
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
        const cashInHandQuery = `
            INSERT INTO cash_in_hand (
                debit,
                credit,
                balance,
                purpose,
                created_at
            ) VALUES (?, 0, ?, ?, ?)
        `;
        const [cashInHandResult] = await connection.execute(cashInHandQuery, [
            amount,
            newCashBalance,
            transferPurpose,
            formattedDate
        ]);
        
        const cashInHandId = cashInHandResult.insertId;

        // Step 2: Update bank account balance (add amount)
        const newAccountBalance = currentAccountBalance + amount;
        await connection.execute(
            'UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ?',
            [newAccountBalance, accountId]
        );

        // Step 3: Add transaction record
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
            ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1)
        `;
        
        const [transactionResult] = await connection.execute(transactionQuery, [
            accountId,
            cashInHandId,
            transferPurpose,
            amount, // Credit = money received in bank account
            formattedDate,
            paymentMode || null,
            referenceNo || null
        ]);

        await connection.commit();
        connection.release();

        res.json({
            message: 'Funds transferred successfully',
            transactionId: transactionResult.insertId,
            cashInHandId: cashInHandId,
            newCashBalance: newCashBalance,
            newAccountBalance: newAccountBalance
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error transferring funds:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

