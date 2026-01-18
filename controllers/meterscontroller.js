const db = require('../models/db');

// Get all meters
exports.getMeters = async (req, res) => {
    try {
        const stationId = req.query.station_id;
        let query = `
            SELECT 
                m.id,
                m.station_id,
                m.fuel_type_id,
                m.meter_no,
                m.CB,
                m.CD,
                m.MB,
                m.MD,
                m.Active,
                s.name as station_name,
                ft.name as fuel_type_name
            FROM meters m
            LEFT JOIN stations s ON m.station_id = s.id
            LEFT JOIN fuel_types ft ON m.fuel_type_id = ft.id
            WHERE m.Active = 1
        `;
        const params = [];
        
        if (stationId) {
            query += ' AND m.station_id = ?';
            params.push(stationId);
        }
        
        query += ' ORDER BY s.name, ft.name, m.meter_no';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching meters:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single meter by ID
exports.getMeter = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Meter ID is required' });
        }

        const query = `
            SELECT 
                m.id,
                m.station_id,
                m.fuel_type_id,
                m.meter_no,
                m.CB,
                m.CD,
                m.MB,
                m.MD,
                m.Active,
                s.name as station_name,
                ft.name as fuel_type_name
            FROM meters m
            LEFT JOIN stations s ON m.station_id = s.id
            LEFT JOIN fuel_types ft ON m.fuel_type_id = ft.id
            WHERE m.id = ? AND m.Active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Meter not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching meter:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new meter
exports.addMeter = async (req, res) => {
    try {
        const { station_id, fuel_type_id, meter_no } = req.body;

        if (!station_id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }
        if (!fuel_type_id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (!meter_no || meter_no < 1) {
            return res.status(400).json({ message: 'Valid meter number is required' });
        }

        // Check for duplicate meter number at the same station and fuel type
        const checkQuery = `
            SELECT id FROM meters 
            WHERE station_id = ? AND fuel_type_id = ? AND meter_no = ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [station_id, fuel_type_id, meter_no]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Meter with this number already exists for this station and fuel type' 
            });
        }

        const CB = req.body.CB || 'System';

        const query = `
            INSERT INTO meters (station_id, fuel_type_id, meter_no, active, CB, CD, MD) 
            VALUES (?, ?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [station_id, fuel_type_id, meter_no, CB]);

        res.json({
            message: 'Meter added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding meter:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'meters table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update meter
exports.updateMeter = async (req, res) => {
    try {
        const { id, station_id, fuel_type_id, meter_no, Active, active } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Meter ID is required' });
        }
        if (!station_id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }
        if (!fuel_type_id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (!meter_no || meter_no < 1) {
            return res.status(400).json({ message: 'Valid meter number is required' });
        }

        // Check for duplicate meter number (excluding current record)
        const checkQuery = `
            SELECT id FROM meters 
            WHERE station_id = ? AND fuel_type_id = ? AND meter_no = ? AND id != ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [station_id, fuel_type_id, meter_no, id]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Meter with this number already exists for this station and fuel type' 
            });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const MB = req.body.MB || 'System';

        const query = `
            UPDATE meters SET 
                station_id = ?,
                fuel_type_id = ?,
                meter_no = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            station_id,
            fuel_type_id,
            meter_no,
            activeValue ? 1 : 0,
            MB,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Meter not found' });
        }

        res.json({ message: 'Meter updated successfully' });
    } catch (err) {
        console.error('Error updating meter:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete meter (soft delete - set Active=0)
exports.deleteMeter = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Meter ID is required' });
        }

        // Check if meter has associated readings
        const checkQuery = 'SELECT COUNT(*) as count FROM meter_readings WHERE meter_id = ? AND Active = 1';
        const [checkResult] = await db.execute(checkQuery, [id]);
        
        if (checkResult[0].count > 0) {
            return res.status(400).json({ 
                message: 'Cannot delete meter. It has associated meter readings. Please delete or deactivate readings first.' 
            });
        }

        const query = 'UPDATE meters SET Active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Meter not found' });
        }

        res.json({ message: 'Meter deleted successfully' });
    } catch (err) {
        console.error('Error deleting meter:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

