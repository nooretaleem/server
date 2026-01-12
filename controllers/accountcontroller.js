const db = require('../models/db');

// Get all accounts for a specific bank (only active ones)
exports.getAccounts = async (req, res) => {
    try {
        const bankId = req.query.bankId;
        if (!bankId) {
            return res.status(400).json({ message: 'Bank ID is required' });
        }

        const query = `
            SELECT 
                a.ID,
                a.BankID,
                a.AccountNo,
                a.AccountTitle,
                a.Balance,
                a.CD,
                a.MD,
                a.active,
                COALESCE(COUNT(t.ID), 0) as transactionCount
            FROM accounts a
            LEFT JOIN transactions t ON t.AccountID = a.ID AND t.active = 1
            WHERE a.BankID = ? AND a.active = 1
            GROUP BY a.ID, a.BankID, a.AccountNo, a.AccountTitle, a.Balance, a.CD, a.MD, a.active
            ORDER BY a.ID DESC
        `;
        const [rows] = await db.execute(query, [bankId]);
        
        // Add hasReferences flag to each account
        const accountsWithReferences = rows.map(account => ({
            ...account,
            transactionCount: parseInt(account.transactionCount) || 0,
            hasReferences: (parseInt(account.transactionCount) || 0) > 0
        }));
        
        res.json(accountsWithReferences);
    } catch (err) {
        console.error('Error fetching accounts:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single account by ID
exports.getAccount = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Account ID is required' });
        }

        const query = `
            SELECT 
                ID,
                BankID,
                AccountNo,
                AccountTitle,
                Balance,
                CD,
                MD,
                active
            FROM accounts
            WHERE ID = ? AND active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }
        
        // Check if account has references in transactions table
        const [transactionRows] = await db.execute(
            'SELECT COUNT(*) as count FROM transactions WHERE AccountID = ? AND active = 1',
            [id]
        );
        const transactionCount = transactionRows[0]?.count || 0;
        const hasReferences = transactionCount > 0;

        const accountData = rows[0];
        accountData.hasReferences = hasReferences;
        accountData.transactionCount = transactionCount;
        accountData.paymentCount = 0;
        
        res.json(accountData);
    } catch (err) {
        console.error('Error fetching account:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new account
exports.addAccount = async (req, res) => {
    try {
        const {
            BankID,
            AccountNo,
            AccountTitle,
            Balance
        } = req.body;

        if (!BankID) {
            return res.status(400).json({ message: 'Bank ID is required' });
        }
        if (!AccountNo) {
            return res.status(400).json({ message: 'Account number is required' });
        }
        if (!AccountTitle) {
            return res.status(400).json({ message: 'Account title is required' });
        }

        // Get bank branch to check for duplicates within same bank and branch
        const [bankRows] = await db.execute('SELECT Branch FROM bank WHERE ID = ? AND active = 1', [BankID]);
        if (bankRows.length === 0) {
            return res.status(404).json({ message: 'Bank not found' });
        }
        const bankBranch = bankRows[0].Branch || null;

        // Check for duplicate account number or account title in the same bank and branch
        const duplicateCheckQuery = `
            SELECT a.ID, a.AccountNo, a.AccountTitle, b.Branch
            FROM accounts a
            INNER JOIN bank b ON a.BankID = b.ID
            WHERE a.BankID = ? 
              AND (a.AccountNo = ? OR a.AccountTitle = ?)
              AND a.active = 1
              AND (b.Branch = ? OR (b.Branch IS NULL AND ? IS NULL))
        `;
        const [duplicateRows] = await db.execute(duplicateCheckQuery, [
            BankID,
            AccountNo,
            AccountTitle,
            bankBranch,
            bankBranch
        ]);

        if (duplicateRows.length > 0) {
            const duplicate = duplicateRows[0];
            if (duplicate.AccountNo === AccountNo && duplicate.AccountTitle === AccountTitle) {
                return res.status(400).json({ 
                    message: 'An account with the same account number and account title already exists in this bank branch.' 
                });
            } else if (duplicate.AccountNo === AccountNo) {
                return res.status(400).json({ 
                    message: 'An account with the same account number already exists in this bank branch.' 
                });
            } else if (duplicate.AccountTitle === AccountTitle) {
                return res.status(400).json({ 
                    message: 'An account with the same account title already exists in this bank branch.' 
                });
            }
        }

        const query = `
            INSERT INTO accounts (BankID, AccountNo, AccountTitle, Balance, active) 
            VALUES (?, ?, ?, ?, 1)
        `;

        const [result] = await db.execute(query, [
            BankID,
            AccountNo,
            AccountTitle,
            Balance || 0
        ]);

        res.json({
            message: 'Account added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding account:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'accounts table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update account
exports.updateAccount = async (req, res) => {
    try {
        const {
            ID,
            BankID,
            AccountNo,
            AccountTitle,
            Balance
        } = req.body;

        if (!ID) {
            return res.status(400).json({ message: 'Account ID is required' });
        }
        if (!AccountNo) {
            return res.status(400).json({ message: 'Account number is required' });
        }
        if (!AccountTitle) {
            return res.status(400).json({ message: 'Account title is required' });
        }

        // Get current account's bank to check for duplicates
        const [currentAccount] = await db.execute('SELECT BankID FROM accounts WHERE ID = ? AND active = 1', [ID]);
        if (currentAccount.length === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }
        const accountBankID = BankID || currentAccount[0].BankID;

        // Get bank branch to check for duplicates within same bank and branch
        const [bankRows] = await db.execute('SELECT Branch FROM bank WHERE ID = ? AND active = 1', [accountBankID]);
        if (bankRows.length === 0) {
            return res.status(404).json({ message: 'Bank not found' });
        }
        const bankBranch = bankRows[0].Branch || null;

        // Check if account is referenced in transactions
        const [transactionRows] = await db.execute(
            'SELECT COUNT(*) as count FROM transactions WHERE AccountID = ? AND active = 1',
            [ID]
        );
        const transactionCount = transactionRows[0]?.count || 0;
        const hasReferences = transactionCount > 0;

        // If account has references, only allow updating AccountTitle (name)
        if (hasReferences) {
            // Check if user is trying to change AccountNo or Balance
            const [currentAccountData] = await db.execute(
                'SELECT AccountNo, Balance FROM accounts WHERE ID = ? AND active = 1',
                [ID]
            );

            if (currentAccountData.length === 0) {
                return res.status(404).json({ message: 'Account not found' });
            }

            const currentAccountNo = currentAccountData[0].AccountNo;
            const currentBalance = parseFloat(currentAccountData[0].Balance || 0);
            const newBalance = parseFloat(Balance || 0);

            // If trying to change AccountNo or Balance, show error
            if (AccountNo !== currentAccountNo) {
                return res.status(400).json({ 
                    message: `Cannot change account number. This account is currently being used in ${transactionCount} transaction${transactionCount > 1 ? 's' : ''}.` 
                });
            }

            if (Math.abs(newBalance - currentBalance) > 0.01) {
                return res.status(400).json({ 
                    message: `Cannot change account balance. This account is currently being used in ${transactionCount} transaction${transactionCount > 1 ? 's' : ''}.` 
                });
            }
            // Check for duplicate account title only (AccountNo and Balance cannot be changed)
            const duplicateTitleQuery = `
                SELECT a.ID, a.AccountTitle, b.Branch
                FROM accounts a
                INNER JOIN bank b ON a.BankID = b.ID
                WHERE a.BankID = ? 
                  AND a.ID != ?
                  AND a.AccountTitle = ?
                  AND a.active = 1
                  AND (b.Branch = ? OR (b.Branch IS NULL AND ? IS NULL))
            `;
            const [duplicateTitleRows] = await db.execute(duplicateTitleQuery, [
                accountBankID,
                ID,
                AccountTitle,
                bankBranch,
                bankBranch
            ]);

            if (duplicateTitleRows.length > 0) {
                return res.status(400).json({ 
                    message: 'An account with the same account title already exists in this bank branch.' 
                });
            }

            // Only update AccountTitle, keep AccountNo and Balance unchanged
            const query = `
                UPDATE accounts SET 
                    AccountTitle = ?,
                    MD = NOW()
                WHERE ID = ? AND active = 1
            `;

            const [result] = await db.execute(query, [
                AccountTitle,
                ID
            ]);

            if (result.affectedRows === 0) {
                return res.status(404).json({ message: 'Account not found' });
            }

            return res.json({ 
                message: 'Account title updated successfully. Account number and balance cannot be changed as the account has transaction history.' 
            });
        }

        // If no references, allow full update (including AccountNo and Balance)
        // Check for duplicate account number or account title in the same bank and branch (excluding current account)
        const duplicateCheckQuery = `
            SELECT a.ID, a.AccountNo, a.AccountTitle, b.Branch
            FROM accounts a
            INNER JOIN bank b ON a.BankID = b.ID
            WHERE a.BankID = ? 
              AND a.ID != ?
              AND (a.AccountNo = ? OR a.AccountTitle = ?)
              AND a.active = 1
              AND (b.Branch = ? OR (b.Branch IS NULL AND ? IS NULL))
        `;
        const [duplicateRows] = await db.execute(duplicateCheckQuery, [
            accountBankID,
            ID,
            AccountNo,
            AccountTitle,
            bankBranch,
            bankBranch
        ]);

        if (duplicateRows.length > 0) {
            const duplicate = duplicateRows[0];
            if (duplicate.AccountNo === AccountNo && duplicate.AccountTitle === AccountTitle) {
                return res.status(400).json({ 
                    message: 'An account with the same account number and account title already exists in this bank branch.' 
                });
            } else if (duplicate.AccountNo === AccountNo) {
                return res.status(400).json({ 
                    message: 'An account with the same account number already exists in this bank branch.' 
                });
            } else if (duplicate.AccountTitle === AccountTitle) {
                return res.status(400).json({ 
                    message: 'An account with the same account title already exists in this bank branch.' 
                });
            }
        }

        const query = `
            UPDATE accounts SET 
                AccountNo = ?,
                AccountTitle = ?,
                Balance = ?,
                MD = NOW()
            WHERE ID = ? AND active = 1
        `;

        const [result] = await db.execute(query, [
            AccountNo,
            AccountTitle,
            Balance || 0,
            ID
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }

        res.json({ message: 'Account updated successfully' });
    } catch (err) {
        console.error('Error updating account:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete account (soft delete - set Active = 0)
exports.deleteAccount = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Account ID is required' });
        }

        // Check if account is referenced in transactions table
        const [transactionRows] = await db.execute(
            'SELECT COUNT(*) as count FROM transactions WHERE AccountID = ? AND active = 1',
            [id]
        );
        const transactionCount = transactionRows[0]?.count || 0;

        if (transactionCount > 0) {
            return res.status(400).json({ 
                message: `Cannot delete this account. It is currently being used in ${transactionCount} transaction${transactionCount > 1 ? 's' : ''}.` 
            });
        }

        // Note: AccountID is in transactions table, not payments table

        // Soft delete: set Active = 0 instead of deleting the record
        const [result] = await db.execute('UPDATE accounts SET active = 0, MD = NOW() WHERE ID = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }

        res.json({ message: 'Account deleted successfully' });
    } catch (err) {
        console.error('Error deleting account:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

