const db = require('../models/db');

// Get all fuel types
exports.getFuelTypes = async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                name,
                CB,
                CD,
                MB,
                MD,
                Active
            FROM fuel_types
            WHERE Active = 1
            ORDER BY name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching fuel types:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single fuel type by ID
exports.getFuelType = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }

        const query = 'SELECT id, name, CB, CD, MB, MD, Active FROM fuel_types WHERE id = ? AND Active = 1';
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Fuel Type not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching fuel type:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new fuel type
exports.addFuelType = async (req, res) => {
    try {
        const { name } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Fuel type name is required' });
        }

        // Check for duplicate name (case-insensitive)
        const checkQuery = 'SELECT id FROM fuel_types WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND Active = 1';
        const [existing] = await db.execute(checkQuery, [name]);
        
        if (existing.length > 0) {
            return res.status(400).json({ message: 'Fuel type with this name already exists' });
        }

        const CB = req.body.CB || 'System';

        const query = `
            INSERT INTO fuel_types (name, active, CB, CD, MD) 
            VALUES (?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [name, CB]);

        res.json({
            message: 'Fuel type added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding fuel type:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'fuel_types table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update fuel type
exports.updateFuelType = async (req, res) => {
    try {
        const { id, name, Active, active } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (!name) {
            return res.status(400).json({ message: 'Fuel type name is required' });
        }

        // Check for duplicate name (case-insensitive, excluding current record)
        const checkQuery = 'SELECT id FROM fuel_types WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND id != ? AND Active = 1';
        const [existing] = await db.execute(checkQuery, [name, id]);
        
        if (existing.length > 0) {
            return res.status(400).json({ message: 'Fuel type with this name already exists' });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const MB = req.body.MB || 'System';

        const query = `
            UPDATE fuel_types SET 
                name = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [name, activeValue ? 1 : 0, MB, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Fuel Type not found' });
        }

        res.json({ message: 'Fuel type updated successfully' });
    } catch (err) {
        console.error('Error updating fuel type:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete fuel type (soft delete - set Active=0)
exports.deleteFuelType = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }

        // Check if fuel type has associated meters
        const checkQuery = 'SELECT COUNT(*) as count FROM meters WHERE fuel_type_id = ? AND Active = 1';
        const [checkResult] = await db.execute(checkQuery, [id]);
        
        if (checkResult[0].count > 0) {
            return res.status(400).json({ 
                message: 'Cannot delete fuel type. It has associated meters. Please delete or deactivate meters first.' 
            });
        }

        const query = 'UPDATE fuel_types SET Active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Fuel Type not found' });
        }

        res.json({ message: 'Fuel type deleted successfully' });
    } catch (err) {
        console.error('Error deleting fuel type:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

