const db = require('../models/db');
const jwt = require('jsonwebtoken');
const config = require('../config/config.json');

// Get all vehicle expenses for a specific vehicle
exports.getVehicleExpenses = async (req, res) => {
    try {
        const vehicle_id = req.query.vehicle_id;
        
        if (!vehicle_id) {
            return res.status(400).json({ message: 'Vehicle ID is required' });
        }

        const query = `
            SELECT 
                ve.id,
                ve.vehicle_id,
                ve.trip_id,
                ve.transaction_id,
                ve.expense_date,
                ve.expense_type,
                ve.description,
                ve.amount,
                ve.CD,
                ve.MD,
                ve.CB,
                ve.Active,
                t.trip_no,
                v.number as vehicle_number
            FROM vehicle_expenses ve
            LEFT JOIN trips t ON ve.trip_id = t.id AND t.active = 1
            LEFT JOIN vehicles v ON ve.vehicle_id = v.id
            WHERE ve.vehicle_id = ? AND ve.Active = 1
            ORDER BY ve.expense_date DESC, ve.CD DESC
        `;
        
        const [rows] = await db.execute(query, [vehicle_id]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching vehicle expenses:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ 
                message: 'Server Error', 
                error: err.message 
            });
        }
    }
};

// Get total expenses for a vehicle
exports.getVehicleTotalExpenses = async (req, res) => {
    try {
        const vehicle_id = req.query.vehicle_id;
        
        if (!vehicle_id) {
            return res.status(400).json({ message: 'Vehicle ID is required' });
        }

        const query = `
            SELECT 
                COALESCE(SUM(amount), 0) as total_expenses
            FROM vehicle_expenses
            WHERE vehicle_id = ? AND Active = 1
        `;
        
        const [rows] = await db.execute(query, [vehicle_id]);
        const total = parseFloat(rows[0]?.total_expenses || 0);
        
        res.json({ total_expenses: total });
    } catch (err) {
        console.error('Error fetching vehicle total expenses:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({ total_expenses: 0 });
        } else {
            res.status(500).json({ 
                message: 'Server Error', 
                error: err.message 
            });
        }
    }
};

// Get total expenses for all vehicles (for table display)
exports.getAllVehiclesTotalExpenses = async (req, res) => {
    try {
        const query = `
            SELECT 
                vehicle_id,
                COALESCE(SUM(amount), 0) as total_expenses
            FROM vehicle_expenses
            WHERE Active = 1
            GROUP BY vehicle_id
        `;
        
        const [rows] = await db.execute(query);
        
        // Convert to object for easy lookup
        const expensesMap = {};
        rows.forEach(row => {
            expensesMap[row.vehicle_id] = parseFloat(row.total_expenses || 0);
        });
        
        res.json(expensesMap);
    } catch (err) {
        console.error('Error fetching all vehicles total expenses:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({});
        } else {
            res.status(500).json({ 
                message: 'Server Error', 
                error: err.message 
            });
        }
    }
};

// Add vehicle expense
exports.addVehicleExpense = async (req, res) => {
    const connection = await db.getConnection();
    
    try {
        await connection.beginTransaction();
        
        const {
            vehicle_id,
            trip_id,
            expense_date,
            expense_type,
            description,
            amount,
            account_head, // 'cash_in_hand' or 'account'
            account_id, // Required if account_head is 'account'
            bank_id, // Required if account_head is 'account'
            payment_mode, // Optional
            reference_no // Optional
        } = req.body;

        // Validate required fields
        if (!vehicle_id || !expense_date || !expense_type || !amount || !account_head) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ message: 'Missing required fields' });
        }

        if (account_head === 'account' && (!account_id || !bank_id)) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ message: 'Account ID and Bank ID are required when Account Head is Account' });
        }

        // Get current user from token
        const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
        let CB = 'admin@gmail.com'; // Default
        if (token) {
            try {
                const decoded = jwt.verify(token, config.secret);
                CB = decoded.email || decoded.username || 'admin@gmail.com';
            } catch (err) {
                console.log('Token verification failed, using default CB');
            }
        }

        let transaction_id = null;
        let cash_in_hand_id = null;

        // Create transaction based on account head
        if (account_head === 'cash_in_hand') {
            // Insert into cash_in_hand table
            const [cashInHandResult] = await connection.execute(
                `INSERT INTO cash_in_hand (debit, credit, balance, purpose, created_at, active)
                 VALUES (?, 0, 0, ?, NOW(), 1)`,
                [amount, `Vehicle Expense: ${expense_type}`]
            );
            
            cash_in_hand_id = cashInHandResult.insertId;
            
            // Insert into transactions table with cash_in_hand_id
            const [transactionResult] = await connection.execute(
                `INSERT INTO transactions (
                    AccountID, cash_in_hand_id, Purpose, Debit, Credit, Balance, 
                    PaymentMode, ReferenceNo, CD, CB, Active
                ) VALUES (NULL, ?, ?, ?, 0, 0, 'Cash', NULL, NOW(), ?, 1)`,
                [
                    cash_in_hand_id,
                    `Vehicle Expense: ${expense_type}`,
                    amount,
                    CB
                ]
            );
            
            transaction_id = transactionResult.insertId;
            
            // Recalculate cash in hand balance
            const [allRecords] = await connection.execute(`
                SELECT id, debit, credit
                FROM cash_in_hand
                WHERE Active = 1
                ORDER BY id ASC
            `);
            
            let runningBalance = 0;
            for (const record of allRecords) {
                runningBalance += (parseFloat(record.credit || 0) - parseFloat(record.debit || 0));
                await connection.execute(
                    `UPDATE cash_in_hand SET balance = ? WHERE id = ?`,
                    [runningBalance, record.id]
                );
            }
        } else if (account_head === 'account') {
            // Insert into transactions table
            const [transactionResult] = await connection.execute(
                `INSERT INTO transactions (
                    AccountID, cash_in_hand_id, Purpose, Debit, Credit, Balance, 
                    PaymentMode, ReferenceNo, CD, CB, Active
                ) VALUES (?, NULL, ?, ?, 0, 0, ?, ?, NOW(), ?, 1)`,
                [
                    account_id,
                    `Vehicle Expense: ${expense_type}`,
                    amount,
                    payment_mode || 'Cash',
                    reference_no || null,
                    CB
                ]
            );
            
            transaction_id = transactionResult.insertId;
            
            // Recalculate account balance
            const [allTransactions] = await connection.execute(`
                SELECT ID, Debit, Credit
                FROM transactions
                WHERE AccountID = ? AND Active = 1
                ORDER BY ID ASC
            `, [account_id]);
            
            let runningBalance = 0;
            for (const trans of allTransactions) {
                runningBalance += (parseFloat(trans.Credit || 0) - parseFloat(trans.Debit || 0));
                await connection.execute(
                    `UPDATE transactions SET Balance = ? WHERE ID = ?`,
                    [runningBalance, trans.ID]
                );
            }
        }

        // Insert vehicle expense
        const [expenseResult] = await connection.execute(
            `INSERT INTO vehicle_expenses (
                vehicle_id, trip_id, transaction_id, expense_date, expense_type,
                description, amount, CD, CB, Active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, 1)`,
            [
                vehicle_id,
                trip_id || null,
                transaction_id,
                expense_date,
                expense_type,
                description || null,
                amount,
                CB
            ]
        );

        await connection.commit();
        connection.release();

        res.json({
            success: true,
            message: 'Vehicle expense added successfully',
            id: expenseResult.insertId
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error adding vehicle expense:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Delete vehicle expense (soft delete)
exports.deleteVehicleExpense = async (req, res) => {
    const connection = await db.getConnection();
    
    try {
        await connection.beginTransaction();
        
        const { id } = req.body;
        
        if (!id) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ message: 'Expense ID is required' });
        }

        // Get the expense to find transaction_id
        const [expenseRows] = await connection.execute(
            `SELECT transaction_id FROM vehicle_expenses WHERE id = ? AND Active = 1`,
            [id]
        );

        if (expenseRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Vehicle expense not found' });
        }

        const transaction_id = expenseRows[0].transaction_id;

        // Soft delete vehicle expense
        await connection.execute(
            `UPDATE vehicle_expenses SET Active = 0, MD = NOW() WHERE id = ?`,
            [id]
        );

        // Soft delete associated transaction if exists
        if (transaction_id) {
            // Get transaction details to find cash_in_hand_id and account_id
            const [transRow] = await connection.execute(
                `SELECT AccountID, cash_in_hand_id FROM transactions WHERE ID = ?`,
                [transaction_id]
            );
            
            if (transRow.length > 0) {
                const accountId = transRow[0].AccountID;
                const cashInHandId = transRow[0].cash_in_hand_id;
                
                // Soft delete transaction
                await connection.execute(
                    `UPDATE transactions SET Active = 0, MD = NOW() WHERE ID = ?`,
                    [transaction_id]
                );
                
                // Soft delete cash_in_hand entry if it exists
                if (cashInHandId) {
                    await connection.execute(
                        `UPDATE cash_in_hand SET Active = 0 WHERE id = ?`,
                        [cashInHandId]
                    );
                    console.log(`Soft deleted cash_in_hand entry ${cashInHandId} for vehicle expense ${id}`);
                    
                    // Recalculate cash in hand balance
                    const [allRecords] = await connection.execute(`
                        SELECT id, debit, credit
                        FROM cash_in_hand
                        WHERE Active = 1
                        ORDER BY id ASC
                    `);
                    
                    let runningBalance = 0;
                    for (const record of allRecords) {
                        runningBalance += (parseFloat(record.credit || 0) - parseFloat(record.debit || 0));
                        await connection.execute(
                            `UPDATE cash_in_hand SET balance = ? WHERE id = ?`,
                            [runningBalance, record.id]
                        );
                    }
                }
                
                // Recalculate account balance if account was used
                if (accountId) {
                    const [allTransactions] = await connection.execute(`
                        SELECT ID, Debit, Credit
                        FROM transactions
                        WHERE AccountID = ? AND Active = 1
                        ORDER BY ID ASC
                    `, [accountId]);
                    
                    let runningBalance = 0;
                    for (const trans of allTransactions) {
                        runningBalance += (parseFloat(trans.Credit || 0) - parseFloat(trans.Debit || 0));
                        await connection.execute(
                            `UPDATE transactions SET Balance = ? WHERE ID = ?`,
                            [runningBalance, trans.ID]
                        );
                    }
                }
            }
        }

        await connection.commit();
        connection.release();

        res.json({
            success: true,
            message: 'Vehicle expense deleted successfully'
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error deleting vehicle expense:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

