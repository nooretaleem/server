const db = require('../models/db');
const jwt = require('jsonwebtoken');
const config = require('../config/config.json');

// Get all vehicle expense types
exports.getVehicleExpenseTypes = async (req, res) => {
    try {
        const query = `
            SELECT id, name, CD, MD, Active
            FROM vehicle_expense_type
            WHERE Active = 1
            ORDER BY name ASC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching vehicle expense types:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add vehicle expense type
exports.addVehicleExpenseType = async (req, res) => {
    try {
        const { name } = req.body;

        if (!name || name.trim() === '') {
            return res.status(400).json({ message: 'Name is required' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Check if name already exists
            const [existingRows] = await connection.execute(
                `SELECT id FROM vehicle_expense_type WHERE name = ? AND Active = 1`,
                [name.trim()]
            );

            if (existingRows.length > 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ message: 'Expense type with this name already exists' });
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

            // Insert new expense type
            const [result] = await connection.execute(
                `INSERT INTO vehicle_expense_type (name, CD, MD, CB, Active) 
                 VALUES (?, NOW(), NOW(), ?, 1)`,
                [name.trim(), CB]
            );

            await connection.commit();
            connection.release();

            res.json({
                message: 'Vehicle expense type added successfully',
                id: result.insertId
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error adding vehicle expense type:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Update vehicle expense type
exports.updateVehicleExpenseType = async (req, res) => {
    try {
        const { id, name } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'ID is required' });
        }

        if (!name || name.trim() === '') {
            return res.status(400).json({ message: 'Name is required' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Check if expense type exists
            const [existingRows] = await connection.execute(
                `SELECT id FROM vehicle_expense_type WHERE id = ? AND Active = 1`,
                [id]
            );

            if (existingRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Vehicle expense type not found' });
            }

            // Check if name already exists for another record
            const [duplicateRows] = await connection.execute(
                `SELECT id FROM vehicle_expense_type WHERE name = ? AND id != ? AND Active = 1`,
                [name.trim(), id]
            );

            if (duplicateRows.length > 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ message: 'Expense type with this name already exists' });
            }

            // Get current user from token
            const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
            let MB = 'admin@gmail.com'; // Default (Modified By)
            if (token) {
                try {
                    const decoded = jwt.verify(token, config.secret);
                    MB = decoded.email || decoded.username || 'admin@gmail.com';
                } catch (err) {
                    console.log('Token verification failed, using default MB');
                }
            }

            // Update expense type
            await connection.execute(
                `UPDATE vehicle_expense_type 
                 SET name = ?, MD = NOW(), MB = ?
                 WHERE id = ? AND Active = 1`,
                [name.trim(), MB, id]
            );

            await connection.commit();
            connection.release();

            res.json({
                message: 'Vehicle expense type updated successfully'
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error updating vehicle expense type:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete vehicle expense type (soft delete)
exports.deleteVehicleExpenseType = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'ID is required' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Check if expense type exists
            const [existingRows] = await connection.execute(
                `SELECT id FROM vehicle_expense_type WHERE id = ? AND Active = 1`,
                [id]
            );

            if (existingRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Vehicle expense type not found' });
            }

            // Check if expense type is being used in vehicle_expenses
            const [usageRows] = await connection.execute(
                `SELECT COUNT(*) as count FROM vehicle_expenses 
                 WHERE expense_type = (SELECT name FROM vehicle_expense_type WHERE id = ?) 
                 AND Active = 1`,
                [id]
            );

            if (parseInt(usageRows[0]?.count || 0) > 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: 'Cannot delete expense type. It is being used in vehicle expenses.' 
                });
            }

            // Get current user from token
            const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
            let MB = 'admin@gmail.com'; // Default (Modified By)
            if (token) {
                try {
                    const decoded = jwt.verify(token, config.secret);
                    MB = decoded.email || decoded.username || 'admin@gmail.com';
                } catch (err) {
                    console.log('Token verification failed, using default MB');
                }
            }

            // Soft delete expense type
            await connection.execute(
                `UPDATE vehicle_expense_type 
                 SET Active = 0, MD = NOW(), MB = ?
                 WHERE id = ?`,
                [MB, id]
            );

            await connection.commit();
            connection.release();

            res.json({
                message: 'Vehicle expense type deleted successfully'
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error deleting vehicle expense type:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

