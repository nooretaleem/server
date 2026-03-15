const db = require('../models/db');

// Get all station tanks
exports.getStationTanks = async (req, res) => {
    try {
        const customerId = req.query.customer_id || req.query.station_id;
        let query = `
            SELECT 
                st.id,
                st.customer_id,
                st.fuel_type_id,
                st.tank_label,
                st.CB,
                st.CD,
                st.MB,
                st.MD,
                st.active,
                c.name as station_name,
                ft.name as fuel_type_name
            FROM station_tanks st
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN fuel_types ft ON st.fuel_type_id = ft.id
            WHERE st.active = 1
        `;
        const params = [];
        
        if (customerId) {
            query += ' AND st.customer_id = ?';
            params.push(customerId);
        }
        
        query += ' ORDER BY c.name, ft.name, st.tank_label';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching station tanks:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single station tank by ID
exports.getStationTank = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Station Tank ID is required' });
        }

        const query = `
            SELECT 
                st.id,
                st.customer_id,
                st.customer_id as station_id,
                st.fuel_type_id,
                st.tank_label,
                st.CB,
                st.CD,
                st.MB,
                st.MD,
                st.active,
                c.name as station_name,
                ft.name as fuel_type_name
            FROM station_tanks st
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN fuel_types ft ON st.fuel_type_id = ft.id
            WHERE st.id = ? AND st.active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Station Tank not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching station tank:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new station tank
exports.addStationTank = async (req, res) => {
    try {
        const { customer_id, station_id, fuel_type_id, tank_label } = req.body;

        const resolvedCustomerId = customer_id ?? station_id;

        if (!resolvedCustomerId) {
            return res.status(400).json({ message: 'Customer (station) ID is required' });
        }
        if (!fuel_type_id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (!tank_label || !tank_label.trim()) {
            return res.status(400).json({ message: 'Tank label is required' });
        }

        // Check for duplicate tank label at the same station and fuel type
        const checkQuery = `
            SELECT id FROM station_tanks 
            WHERE customer_id = ? AND fuel_type_id = ? AND tank_label = ? AND active = 1
        `;
        const [existing] = await db.execute(checkQuery, [resolvedCustomerId, fuel_type_id, tank_label.trim()]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Tank with this label already exists for this station and fuel type' 
            });
        }

        const CB = req.body.CB || 'System';

        const query = `
            INSERT INTO station_tanks (customer_id, fuel_type_id, tank_label, active, CB, CD, MD) 
            VALUES (?, ?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [resolvedCustomerId, fuel_type_id, tank_label.trim(), CB]);

        res.json({
            message: 'Station tank added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding station tank:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'station_tanks table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update station tank
exports.updateStationTank = async (req, res) => {
    try {
        const { id, customer_id, station_id, fuel_type_id, tank_label, Active, active } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Station Tank ID is required' });
        }
        const resolvedCustomerId = customer_id ?? station_id;

        if (!resolvedCustomerId) {
            return res.status(400).json({ message: 'Customer (station) ID is required' });
        }
        if (!fuel_type_id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (!tank_label || !tank_label.trim()) {
            return res.status(400).json({ message: 'Tank label is required' });
        }

        // Check for duplicate tank label (excluding current record)
        const checkQuery = `
            SELECT id FROM station_tanks 
            WHERE customer_id = ? AND fuel_type_id = ? AND tank_label = ? AND id != ? AND active = 1
        `;
        const [existing] = await db.execute(checkQuery, [resolvedCustomerId, fuel_type_id, tank_label.trim(), id]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Tank with this label already exists for this station and fuel type' 
            });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const MB = req.body.MB || 'System';

        const query = `
            UPDATE station_tanks SET 
                customer_id = ?,
                fuel_type_id = ?,
                tank_label = ?,
                active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            resolvedCustomerId,
            fuel_type_id,
            tank_label.trim(),
            activeValue ? 1 : 0,
            MB,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Station Tank not found' });
        }

        res.json({ message: 'Station tank updated successfully' });
    } catch (err) {
        console.error('Error updating station tank:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete station tank (soft delete - set active=0)
exports.deleteStationTank = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Station Tank ID is required' });
        }

        const query = 'UPDATE station_tanks SET active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Station Tank not found' });
        }

        res.json({ message: 'Station tank deleted successfully' });
    } catch (err) {
        console.error('Error deleting station tank:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

