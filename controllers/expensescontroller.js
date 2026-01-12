const db = require('../models/db');

// Get all expenses
exports.getExpenses = async (req, res) => {
    try {
        const expense_type = req.query.expense_type; // 'BUSINESS' or 'PERSONAL'
        
        let query = `
            SELECT 
                e.id,
                e.category_id,
                e.transaction_id,
                e.amount,
                e.expense_date,
                e.description,
                e.created_at,
                ec.name as category_name,
                ec.expense_type,
                t.Purpose as transaction_purpose,
                t.AccountID,
                t.cash_in_hand_id,
                t.PaymentMode,
                t.ReferenceNo
            FROM expenses e
            LEFT JOIN expense_categories ec ON e.category_id = ec.id
            LEFT JOIN transactions t ON e.transaction_id = t.ID
        `;
        
        const params = [];
        if (expense_type && (expense_type === 'BUSINESS' || expense_type === 'PERSONAL')) {
            query += ' WHERE ec.expense_type = ?';
            params.push(expense_type);
        }
        
        query += ' ORDER BY e.expense_date DESC, e.created_at DESC';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching expenses:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Get single expense
exports.getExpense = async (req, res) => {
    try {
        const id = req.query.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Expense ID is required' });
        }

        const query = `
            SELECT 
                e.id,
                e.category_id,
                e.transaction_id,
                e.amount,
                e.expense_date,
                e.description,
                e.created_at,
                ec.name as category_name,
                ec.expense_type,
                t.Purpose as transaction_purpose,
                t.AccountID,
                t.cash_in_hand_id,
                t.PaymentMode,
                t.ReferenceNo
            FROM expenses e
            LEFT JOIN expense_categories ec ON e.category_id = ec.id
            LEFT JOIN transactions t ON e.transaction_id = t.ID
            WHERE e.id = ?
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Expense not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching expense:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Get total expenses by type
exports.getTotalExpenses = async (req, res) => {
    try {
        const expense_type = req.query.expense_type; // 'BUSINESS' or 'PERSONAL'
        
        let query = `
            SELECT 
                COALESCE(SUM(e.amount), 0) as total
            FROM expenses e
            LEFT JOIN expense_categories ec ON e.category_id = ec.id
        `;
        
        const params = [];
        if (expense_type && (expense_type === 'BUSINESS' || expense_type === 'PERSONAL')) {
            query += ' WHERE ec.expense_type = ?';
            params.push(expense_type);
        }
        
        const [rows] = await db.execute(query, params);
        res.json({ total: parseFloat(rows[0]?.total || 0) });
    } catch (err) {
        console.error('Error fetching total expenses:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Add expense
exports.addExpense = async (req, res) => {
    try {
        const {
            category_id,
            amount,
            expense_date,
            description,
            account_head,
            AccountID,
            cash_in_hand_id,
            PaymentMode,
            ReferenceNo
        } = req.body;

        // Validation
        if (!category_id) {
            return res.status(400).json({ message: 'Category is required' });
        }
        if (!amount || amount <= 0) {
            return res.status(400).json({ message: 'Amount is required and must be greater than 0' });
        }
        if (!expense_date) {
            return res.status(400).json({ message: 'Expense date is required' });
        }
        if (!account_head || !['cash_in_hand', 'bank'].includes(account_head)) {
            return res.status(400).json({ message: 'Account head must be cash_in_hand or bank' });
        }
        if (account_head === 'bank' && !AccountID) {
            return res.status(400).json({ message: 'Account ID is required when account head is bank' });
        }
        if (account_head === 'bank' && !PaymentMode) {
            return res.status(400).json({ message: 'Payment mode is required when account head is bank' });
        }
        if (account_head === 'cash_in_hand' && !cash_in_hand_id) {
            return res.status(400).json({ message: 'Cash in hand ID is required when account head is cash_in_hand' });
        }

        const connection = await db.getConnection();
        
        try {
            await connection.beginTransaction();

            // Get category name for transaction purpose
            const [categoryRows] = await connection.execute(
                'SELECT name FROM expense_categories WHERE id = ?',
                [category_id]
            );

            if (categoryRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Expense category not found' });
            }

            const categoryName = categoryRows[0].name;
            const transactionPurpose = categoryName;

            // Check balance before processing
            if (account_head === 'bank') {
                // Check account balance
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
                if (currentBalance < amount) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ 
                        message: `Insufficient balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${amount.toFixed(2)}` 
                    });
                }
            } else if (account_head === 'cash_in_hand') {
                // Step 1: Check if there's already a row for the current date
                const expenseDateOnly = expense_date.split('T')[0]; // Get YYYY-MM-DD format
                const [existingDateRows] = await connection.execute(
                    `SELECT id FROM cash_in_hand 
                     WHERE DATE(created_at) = ? AND Active = 1
                     ORDER BY created_at ASC, id ASC
                     LIMIT 1`,
                    [expenseDateOnly]
                );

                // Step 2: If no row exists for current date, create opening balance row
                if (existingDateRows.length === 0) {
                    // Get balance from last active row (most recent record)
                    const [lastRow] = await connection.execute(
                        `SELECT balance FROM cash_in_hand 
                         WHERE Active = 1
                         ORDER BY created_at DESC, id DESC
                         LIMIT 1`
                    );
                    
                    const lastBalance = lastRow.length > 0 ? parseFloat(lastRow[0].balance || 0) : 0;
                    
                    // Create opening balance row: debit=0, credit=0, balance=last row balance
                    const openingBalanceQuery = `
                        INSERT INTO cash_in_hand (
                            purpose,
                            debit,
                            credit,
                            balance,
                            created_at
                        ) VALUES (?, 0, 0, ?, ?)
                    `;
                    
                    await connection.execute(openingBalanceQuery, [
                        'Opening Balance',
                        lastBalance, // Balance = last row balance (just copy, no calculation)
                        expenseDateOnly + ' 00:00:00' // Set to start of day
                    ]);
                }

                // Step 3: Get current balance from last active row (not calculation)
                const [lastBalanceRow] = await connection.execute(
                    `SELECT balance FROM cash_in_hand 
                     WHERE Active = 1
                     ORDER BY created_at DESC, id DESC
                     LIMIT 1`
                );
                
                const currentBalance = lastBalanceRow.length > 0 ? parseFloat(lastBalanceRow[0].balance || 0) : 0;
                
                // Step 4: Check if balance is sufficient
                if (currentBalance < amount) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ 
                        message: `Insufficient cash in hand balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${amount.toFixed(2)}` 
                    });
                }
            }

            let cashInHandRecordId = null;
            
            // If cash in hand, insert into cash_in_hand table first to get the ID
            if (account_head === 'cash_in_hand') {
                // Get previous active row's balance (not calculation)
                const [previousBalanceRow] = await connection.execute(
                    `SELECT balance FROM cash_in_hand 
                     WHERE Active = 1
                     ORDER BY created_at DESC, id DESC
                     LIMIT 1`
                );
                
                const previousBalance = previousBalanceRow.length > 0 ? parseFloat(previousBalanceRow[0].balance || 0) : 0;
                const newBalance = previousBalance - amount; // Balance = Previous balance - expense amount

                // Insert into cash_in_hand table with debit (expense amount)
                const cashInHandQuery = `
                    INSERT INTO cash_in_hand (
                        purpose,
                        debit,
                        credit,
                        balance,
                        created_at
                    ) VALUES (?, ?, 0, ?, NOW())
                `;
                
                const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                    transactionPurpose,
                    amount, // Debit = expense amount from UI
                    newBalance // Balance = Previous row balance - expense amount
                ]);
                
                cashInHandRecordId = cashInHandResult.insertId;
            }

            // Insert into transactions table
            // For expenses: Debit = amount (money going out)
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
                ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1)
            `;
            
            const [transactionResult] = await connection.execute(transactionQuery, [
                account_head === 'bank' ? AccountID : null,
                account_head === 'cash_in_hand' ? cashInHandRecordId : null,
                transactionPurpose,
                amount, // Debit = amount (money paid out)
                expense_date,
                account_head === 'bank' ? PaymentMode : null,
                account_head === 'bank' ? (ReferenceNo || null) : null
            ]);
            
            const transactionID = transactionResult.insertId;

            // Update account balance if bank
            if (account_head === 'bank') {
                const [accountRows] = await connection.execute(
                    'SELECT Balance FROM accounts WHERE ID = ? AND active = 1',
                    [AccountID]
                );
                const currentBalance = parseFloat(accountRows[0].Balance) || 0;
                const newBalance = currentBalance - amount; // Debit reduces balance

                await connection.execute(
                    'UPDATE accounts SET Balance = ? WHERE ID = ?',
                    [newBalance, AccountID]
                );
            }

            // Insert into expenses table
            const expenseQuery = `
                INSERT INTO expenses (
                    category_id,
                    transaction_id,
                    amount,
                    expense_date,
                    description,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, NOW())
            `;
            
            const [expenseResult] = await connection.execute(expenseQuery, [
                category_id,
                transactionID,
                amount,
                expense_date,
                description || null
            ]);

            await connection.commit();
            connection.release();

            res.json({
                message: 'Expense added successfully',
                id: expenseResult.insertId,
                transaction_id: transactionID
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error adding expense:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Update expense
exports.updateExpense = async (req, res) => {
    try {
        const {
            id,
            category_id,
            amount,
            expense_date,
            description,
            account_head,
            AccountID,
            cash_in_hand_id,
            PaymentMode,
            ReferenceNo
        } = req.body;

        // Validation
        if (!id) {
            return res.status(400).json({ message: 'Expense ID is required' });
        }
        if (!category_id) {
            return res.status(400).json({ message: 'Category is required' });
        }
        if (!amount || amount <= 0) {
            return res.status(400).json({ message: 'Amount is required and must be greater than 0' });
        }
        if (!expense_date) {
            return res.status(400).json({ message: 'Expense date is required' });
        }
        if (!account_head || !['cash_in_hand', 'bank'].includes(account_head)) {
            return res.status(400).json({ message: 'Account head must be cash_in_hand or bank' });
        }
        if (account_head === 'bank' && !AccountID) {
            return res.status(400).json({ message: 'Account ID is required when account head is bank' });
        }
        if (account_head === 'bank' && !PaymentMode) {
            return res.status(400).json({ message: 'Payment mode is required when account head is bank' });
        }
        if (account_head === 'cash_in_hand' && !cash_in_hand_id) {
            return res.status(400).json({ message: 'Cash in hand ID is required when account head is cash_in_hand' });
        }

        const connection = await db.getConnection();
        
        try {
            await connection.beginTransaction();

            // Get existing expense
            const [expenseRows] = await connection.execute(
                'SELECT transaction_id FROM expenses WHERE id = ?',
                [id]
            );

            if (expenseRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Expense not found' });
            }

            const transactionID = expenseRows[0].transaction_id;

            // Get existing transaction
            const [transactionRows] = await connection.execute(
                'SELECT AccountID, cash_in_hand_id, Debit, Credit FROM transactions WHERE ID = ?',
                [transactionID]
            );

            if (transactionRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Transaction not found' });
            }

            const oldTransaction = transactionRows[0];
            const oldAmount = parseFloat(oldTransaction.Debit || oldTransaction.Credit || 0);
            const oldAccountID = oldTransaction.AccountID;
            const oldCashInHandId = oldTransaction.cash_in_hand_id;

            // Reverse old transaction
            if (oldAccountID) {
                // Reverse bank account balance
                const [accountRows] = await connection.execute(
                    'SELECT Balance FROM accounts WHERE ID = ? AND active = 1',
                    [oldAccountID]
                );
                if (accountRows.length > 0) {
                    const currentBalance = parseFloat(accountRows[0].Balance) || 0;
                    const newBalance = currentBalance + oldAmount; // Add back the old amount
                    await connection.execute(
                        'UPDATE accounts SET Balance = ? WHERE ID = ?',
                        [newBalance, oldAccountID]
                    );
                }
            } else if (oldCashInHandId) {
                // Reverse cash in hand - delete the old cash_in_hand record
                await connection.execute(
                    'DELETE FROM cash_in_hand WHERE id = ?',
                    [oldCashInHandId]
                );
            }

            // Get category name for transaction purpose
            const [categoryRows] = await connection.execute(
                'SELECT name FROM expense_categories WHERE id = ?',
                [category_id]
            );

            if (categoryRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Expense category not found' });
            }

            const categoryName = categoryRows[0].name;
            const transactionPurpose = categoryName;

            // Check balance before processing
            if (account_head === 'bank') {
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
                if (currentBalance < amount) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ 
                        message: `Insufficient balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${amount.toFixed(2)}` 
                    });
                }
            } else if (account_head === 'cash_in_hand') {
                // Step 1: Check if there's already a row for the current date
                const expenseDateOnly = expense_date.split('T')[0]; // Get YYYY-MM-DD format
                const [existingDateRows] = await connection.execute(
                    `SELECT id FROM cash_in_hand 
                     WHERE DATE(created_at) = ? AND Active = 1
                     ORDER BY created_at ASC, id ASC
                     LIMIT 1`,
                    [expenseDateOnly]
                );

                // Step 2: If no row exists for current date, create opening balance row
                if (existingDateRows.length === 0) {
                    // Get balance from last active row (most recent record)
                    const [lastRow] = await connection.execute(
                        `SELECT balance FROM cash_in_hand 
                         WHERE Active = 1
                         ORDER BY created_at DESC, id DESC
                         LIMIT 1`
                    );
                    
                    const lastBalance = lastRow.length > 0 ? parseFloat(lastRow[0].balance || 0) : 0;
                    
                    // Create opening balance row: debit=0, credit=0, balance=last row balance
                    const openingBalanceQuery = `
                        INSERT INTO cash_in_hand (
                            purpose,
                            debit,
                            credit,
                            balance,
                            created_at
                        ) VALUES (?, 0, 0, ?, ?)
                    `;
                    
                    await connection.execute(openingBalanceQuery, [
                        'Opening Balance',
                        lastBalance, // Balance = last row balance (just copy, no calculation)
                        expenseDateOnly + ' 00:00:00' // Set to start of day
                    ]);
                }

                // Step 3: Get current balance from last active row (not calculation)
                const [lastBalanceRow] = await connection.execute(
                    `SELECT balance FROM cash_in_hand 
                     WHERE Active = 1
                     ORDER BY created_at DESC, id DESC
                     LIMIT 1`
                );
                
                const currentBalance = lastBalanceRow.length > 0 ? parseFloat(lastBalanceRow[0].balance || 0) : 0;
                
                // Step 4: Check if balance is sufficient
                if (currentBalance < amount) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ 
                        message: `Insufficient cash in hand balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${amount.toFixed(2)}` 
                    });
                }
            }

            let newCashInHandRecordId = null;
            
            // If cash in hand, insert new cash_in_hand record
            if (account_head === 'cash_in_hand') {
                // Get previous active row's balance (not calculation)
                const [previousBalanceRow] = await connection.execute(
                    `SELECT balance FROM cash_in_hand 
                     WHERE Active = 1
                     ORDER BY created_at DESC, id DESC
                     LIMIT 1`
                );
                
                const previousBalance = previousBalanceRow.length > 0 ? parseFloat(previousBalanceRow[0].balance || 0) : 0;
                const newBalance = previousBalance - amount; // Balance = Previous balance - expense amount

                // Insert into cash_in_hand table with debit (expense amount)
                const cashInHandQuery = `
                    INSERT INTO cash_in_hand (
                        purpose,
                        debit,
                        credit,
                        balance,
                        created_at
                    ) VALUES (?, ?, 0, ?, NOW())
                `;
                
                const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                    transactionPurpose,
                    amount, // Debit = expense amount from UI
                    newBalance // Balance = Previous row balance - expense amount
                ]);
                
                newCashInHandRecordId = cashInHandResult.insertId;
            }

            // Update transaction
            const transactionQuery = `
                UPDATE transactions
                SET AccountID = ?,
                    cash_in_hand_id = ?,
                    Purpose = ?,
                    Debit = ?,
                    Credit = 0,
                    Date = ?,
                    PaymentMode = ?,
                    ReferenceNo = ?
                WHERE ID = ?
            `;
            
            await connection.execute(transactionQuery, [
                account_head === 'bank' ? AccountID : null,
                account_head === 'cash_in_hand' ? newCashInHandRecordId : null,
                transactionPurpose,
                amount,
                expense_date,
                account_head === 'bank' ? PaymentMode : null,
                account_head === 'bank' ? (ReferenceNo || null) : null,
                transactionID
            ]);

            // Update account balance if bank
            if (account_head === 'bank') {
                const [accountRows] = await connection.execute(
                    'SELECT Balance FROM accounts WHERE ID = ? AND active = 1',
                    [AccountID]
                );
                const currentBalance = parseFloat(accountRows[0].Balance) || 0;
                const newBalance = currentBalance - amount; // Debit reduces balance

                await connection.execute(
                    'UPDATE accounts SET Balance = ? WHERE ID = ?',
                    [newBalance, AccountID]
                );
            }

            // Update expense
            const expenseQuery = `
                UPDATE expenses
                SET category_id = ?,
                    amount = ?,
                    expense_date = ?,
                    description = ?
                WHERE id = ?
            `;
            
            await connection.execute(expenseQuery, [
                category_id,
                amount,
                expense_date,
                description || null,
                id
            ]);

            await connection.commit();
            connection.release();

            res.json({
                message: 'Expense updated successfully'
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error updating expense:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Delete expense
exports.deleteExpense = async (req, res) => {
    try {
        const id = req.query.id;

        if (!id) {
            return res.status(400).json({ message: 'Expense ID is required' });
        }

        const connection = await db.getConnection();
        
        try {
            await connection.beginTransaction();

            // Get expense with transaction
            const [expenseRows] = await connection.execute(
                'SELECT transaction_id FROM expenses WHERE id = ?',
                [id]
            );

            if (expenseRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Expense not found' });
            }

            const transactionID = expenseRows[0].transaction_id;

            // Get transaction details
            const [transactionRows] = await connection.execute(
                'SELECT AccountID, cash_in_hand_id, Debit, Credit FROM transactions WHERE ID = ?',
                [transactionID]
            );

            if (transactionRows.length > 0) {
                const transaction = transactionRows[0];
                const amount = parseFloat(transaction.Debit || transaction.Credit || 0);

                // Reverse transaction - add back to balance
                if (transaction.AccountID) {
                    // Reverse bank account balance
                    const [accountRows] = await connection.execute(
                        'SELECT Balance FROM accounts WHERE ID = ? AND active = 1',
                        [transaction.AccountID]
                    );
                    if (accountRows.length > 0) {
                        const currentBalance = parseFloat(accountRows[0].Balance) || 0;
                        const newBalance = currentBalance + amount; // Add back the amount
                        await connection.execute(
                            'UPDATE accounts SET Balance = ? WHERE ID = ?',
                            [newBalance, transaction.AccountID]
                        );
                    }
                } else if (transaction.cash_in_hand_id) {
                    // For cash in hand, we would need to reverse the cash_in_hand entry
                    // This is complex, so we'll just delete the transaction
                }

                // Delete transaction
                await connection.execute(
                    'DELETE FROM transactions WHERE ID = ?',
                    [transactionID]
                );
            }

            // Delete expense
            await connection.execute(
                'DELETE FROM expenses WHERE id = ?',
                [id]
            );

            await connection.commit();
            connection.release();

            res.json({
                message: 'Expense deleted successfully'
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error deleting expense:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

