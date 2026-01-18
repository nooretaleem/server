const db = require('../models/db');

// Get all fuel rates
exports.getFuelRates = async (req, res) => {
    try {
        const fuelTypeId = req.query.fuel_type_id;
        const effectiveDate = req.query.effective_date;
        
        let query = `
            SELECT 
                fr.id,
                fr.fuel_type_id,
                fr.rate,
                fr.effective_date,
                fr.CB,
                fr.CD,
                fr.MB,
                fr.MD,
                fr.Active,
                ft.name as fuel_type_name
            FROM fuel_rates fr
            LEFT JOIN fuel_types ft ON fr.fuel_type_id = ft.id
            WHERE fr.Active = 1
        `;
        const params = [];
        
        if (fuelTypeId) {
            query += ' AND fr.fuel_type_id = ?';
            params.push(fuelTypeId);
        }
        if (effectiveDate) {
            query += ' AND fr.effective_date = ?';
            params.push(effectiveDate);
        }
        
        query += ' ORDER BY fr.effective_date DESC, ft.name';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching fuel rates:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get current fuel rate for a fuel type
exports.getCurrentFuelRate = async (req, res) => {
    try {
        const fuelTypeId = req.query.fuel_type_id;
        const date = req.query.date || new Date().toISOString().split('T')[0];
        
        if (!fuelTypeId) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }

        const query = `
            SELECT 
                fr.id,
                fr.fuel_type_id,
                fr.rate,
                fr.effective_date,
                ft.name as fuel_type_name
            FROM fuel_rates fr
            LEFT JOIN fuel_types ft ON fr.fuel_type_id = ft.id
            WHERE fr.fuel_type_id = ? 
            AND fr.effective_date <= ?
            AND fr.Active = 1
            ORDER BY fr.effective_date DESC
            LIMIT 1
        `;
        const [rows] = await db.execute(query, [fuelTypeId, date]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'No fuel rate found for this fuel type' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching current fuel rate:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get single fuel rate by ID
exports.getFuelRate = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Fuel Rate ID is required' });
        }

        const query = `
            SELECT 
                fr.id,
                fr.fuel_type_id,
                fr.rate,
                fr.effective_date,
                fr.CB,
                fr.CD,
                fr.MB,
                fr.MD,
                fr.Active,
                ft.name as fuel_type_name
            FROM fuel_rates fr
            LEFT JOIN fuel_types ft ON fr.fuel_type_id = ft.id
            WHERE fr.id = ? AND fr.Active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Fuel Rate not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching fuel rate:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new fuel rate
exports.addFuelRate = async (req, res) => {
    try {
        const { fuel_type_id, rate, effective_date } = req.body;

        if (!fuel_type_id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (rate === null || rate === undefined) {
            return res.status(400).json({ message: 'Rate is required' });
        }
        if (!effective_date) {
            return res.status(400).json({ message: 'Effective date is required' });
        }

        const CB = req.body.CB || 'System';

        const query = `
            INSERT INTO fuel_rates (fuel_type_id, rate, effective_date, active, CB, CD, MD) 
            VALUES (?, ?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [fuel_type_id, rate, effective_date, CB]);

        res.json({
            message: 'Fuel rate added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding fuel rate:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'fuel_rates table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update fuel rate
exports.updateFuelRate = async (req, res) => {
    try {
        const { id, fuel_type_id, rate, effective_date, Active, active } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Fuel Rate ID is required' });
        }
        if (!fuel_type_id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (rate === null || rate === undefined) {
            return res.status(400).json({ message: 'Rate is required' });
        }
        if (!effective_date) {
            return res.status(400).json({ message: 'Effective date is required' });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const MB = req.body.MB || 'System';

        const query = `
            UPDATE fuel_rates SET 
                fuel_type_id = ?,
                rate = ?,
                effective_date = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            fuel_type_id,
            rate,
            effective_date,
            activeValue ? 1 : 0,
            MB,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Fuel Rate not found' });
        }

        res.json({ message: 'Fuel rate updated successfully' });
    } catch (err) {
        console.error('Error updating fuel rate:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete fuel rate (soft delete - set Active=0)
exports.deleteFuelRate = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Fuel Rate ID is required' });
        }

        const query = 'UPDATE fuel_rates SET Active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Fuel Rate not found' });
        }

        res.json({ message: 'Fuel rate deleted successfully' });
    } catch (err) {
        console.error('Error deleting fuel rate:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

