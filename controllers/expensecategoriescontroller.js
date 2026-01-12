const db = require('../models/db');

// Get all expense categories
exports.getExpenseCategories = async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                name,
                expense_type,
                created_at
            FROM expense_categories
            ORDER BY name ASC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching expense categories:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Get single expense category
exports.getExpenseCategory = async (req, res) => {
    try {
        const id = req.query.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Category ID is required' });
        }

        const query = `
            SELECT 
                id,
                name,
                expense_type,
                created_at
            FROM expense_categories
            WHERE id = ?
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Expense category not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching expense category:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Add expense category
exports.addExpenseCategory = async (req, res) => {
    try {
        const { name, expense_type } = req.body;

        // Validation
        if (!name || name.trim() === '') {
            return res.status(400).json({ message: 'Category name is required' });
        }
        if (!expense_type || !['BUSINESS', 'PERSONAL'].includes(expense_type)) {
            return res.status(400).json({ message: 'Expense type must be BUSINESS or PERSONAL' });
        }

        const connection = await db.getConnection();
        
        try {
            await connection.beginTransaction();

            // Check if category with same name and type already exists
            const [existingRows] = await connection.execute(
                'SELECT id FROM expense_categories WHERE name = ? AND expense_type = ?',
                [name.trim(), expense_type]
            );

            if (existingRows.length > 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Category "${name}" already exists for ${expense_type} expenses` 
                });
            }

            // Insert new category
            const insertQuery = `
                INSERT INTO expense_categories (name, expense_type, created_at)
                VALUES (?, ?, NOW())
            `;
            
            const [result] = await connection.execute(insertQuery, [
                name.trim(),
                expense_type
            ]);

            await connection.commit();
            connection.release();

            res.json({
                message: 'Expense category added successfully',
                id: result.insertId
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error adding expense category:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Update expense category
exports.updateExpenseCategory = async (req, res) => {
    try {
        const { id, name, expense_type } = req.body;

        // Validation
        if (!id) {
            return res.status(400).json({ message: 'Category ID is required' });
        }
        if (!name || name.trim() === '') {
            return res.status(400).json({ message: 'Category name is required' });
        }
        if (!expense_type || !['BUSINESS', 'PERSONAL'].includes(expense_type)) {
            return res.status(400).json({ message: 'Expense type must be BUSINESS or PERSONAL' });
        }

        const connection = await db.getConnection();
        
        try {
            await connection.beginTransaction();

            // Check if category exists
            const [existingRows] = await connection.execute(
                'SELECT id FROM expense_categories WHERE id = ?',
                [id]
            );

            if (existingRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Expense category not found' });
            }

            // Check if another category with same name and type already exists
            const [duplicateRows] = await connection.execute(
                'SELECT id FROM expense_categories WHERE name = ? AND expense_type = ? AND id != ?',
                [name.trim(), expense_type, id]
            );

            if (duplicateRows.length > 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Category "${name}" already exists for ${expense_type} expenses` 
                });
            }

            // Update category
            const updateQuery = `
                UPDATE expense_categories
                SET name = ?, expense_type = ?
                WHERE id = ?
            `;
            
            await connection.execute(updateQuery, [
                name.trim(),
                expense_type,
                id
            ]);

            await connection.commit();
            connection.release();

            res.json({
                message: 'Expense category updated successfully'
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error updating expense category:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Delete expense category
exports.deleteExpenseCategory = async (req, res) => {
    try {
        const id = req.query.id;

        if (!id) {
            return res.status(400).json({ message: 'Category ID is required' });
        }

        const connection = await db.getConnection();
        
        try {
            await connection.beginTransaction();

            // Check if category exists
            const [categoryRows] = await connection.execute(
                'SELECT id FROM expense_categories WHERE id = ?',
                [id]
            );

            if (categoryRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Expense category not found' });
            }

            // Check if category is used in expenses
            const [expenseRows] = await connection.execute(
                'SELECT COUNT(*) as count FROM expenses WHERE category_id = ?',
                [id]
            );

            const expenseCount = expenseRows[0]?.count || 0;

            if (expenseCount > 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Cannot delete this category. It is currently being used in ${expenseCount} expense${expenseCount > 1 ? 's' : ''}.` 
                });
            }

            // Delete category
            await connection.execute(
                'DELETE FROM expense_categories WHERE id = ?',
                [id]
            );

            await connection.commit();
            connection.release();

            res.json({
                message: 'Expense category deleted successfully'
            });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

    } catch (err) {
        console.error('Error deleting expense category:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

