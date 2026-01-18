const db = require('../models/db');

// Get all meter readings
exports.getMeterReadings = async (req, res) => {
    try {
        const stationId = req.query.station_id;
        const meterId = req.query.meter_id;
        const readingDate = req.query.reading_date;
        const shift = req.query.shift;
        
        let query = `
            SELECT 
                mr.id,
                mr.station_id,
                mr.meter_id,
                mr.reading_date,
                mr.shift,
                mr.old_a,
                mr.new_a,
                mr.sale_a,
                mr.old_b,
                mr.new_b,
                mr.sale_b,
                mr.CB,
                mr.CD,
                mr.MB,
                mr.MD,
                mr.Active,
                s.name as station_name,
                m.meter_no,
                ft.name as fuel_type_name
            FROM meter_readings mr
            LEFT JOIN stations s ON mr.station_id = s.id
            LEFT JOIN meters m ON mr.meter_id = m.id
            LEFT JOIN fuel_types ft ON m.fuel_type_id = ft.id
            WHERE mr.Active = 1
        `;
        const params = [];
        
        if (stationId) {
            query += ' AND mr.station_id = ?';
            params.push(stationId);
        }
        if (meterId) {
            query += ' AND mr.meter_id = ?';
            params.push(meterId);
        }
        if (readingDate) {
            query += ' AND mr.reading_date = ?';
            params.push(readingDate);
        }
        if (shift) {
            query += ' AND mr.shift = ?';
            params.push(shift);
        }
        
        query += ' ORDER BY mr.reading_date DESC, mr.shift, s.name, m.meter_no';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching meter readings:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single meter reading by ID
exports.getMeterReading = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Meter Reading ID is required' });
        }

        const query = `
            SELECT 
                mr.id,
                mr.station_id,
                mr.meter_id,
                mr.reading_date,
                mr.shift,
                mr.old_a,
                mr.new_a,
                mr.sale_a,
                mr.old_b,
                mr.new_b,
                mr.sale_b,
                mr.CB,
                mr.CD,
                mr.MB,
                mr.MD,
                mr.Active,
                s.name as station_name,
                m.meter_no,
                ft.name as fuel_type_name
            FROM meter_readings mr
            LEFT JOIN stations s ON mr.station_id = s.id
            LEFT JOIN meters m ON mr.meter_id = m.id
            LEFT JOIN fuel_types ft ON m.fuel_type_id = ft.id
            WHERE mr.id = ? AND mr.Active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching meter reading:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new meter reading
exports.addMeterReading = async (req, res) => {
    try {
        const {
            station_id,
            meter_id,
            reading_date,
            shift,
            old_a,
            new_a,
            sale_a,
            old_b,
            new_b,
            sale_b
        } = req.body;

        if (!station_id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }
        if (!meter_id) {
            return res.status(400).json({ message: 'Meter ID is required' });
        }
        if (!reading_date) {
            return res.status(400).json({ message: 'Reading date is required' });
        }
        if (!shift) {
            return res.status(400).json({ message: 'Shift is required' });
        }

        // Check for duplicate reading (same station, meter, date, and shift)
        const checkQuery = `
            SELECT id FROM meter_readings 
            WHERE station_id = ? AND meter_id = ? AND reading_date = ? AND shift = ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [station_id, meter_id, reading_date, shift]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Meter reading already exists for this station, meter, date, and shift' 
            });
        }

        const CB = req.body.CB || 'System';

        const query = `
            INSERT INTO meter_readings (
                station_id, meter_id, reading_date, shift,
                old_a, new_a, sale_a, old_b, new_b, sale_b,
                active, CB, CD, MD
            ) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [
            station_id,
            meter_id,
            reading_date,
            shift,
            old_a || null,
            new_a || null,
            sale_a || null,
            old_b || null,
            new_b || null,
            sale_b || null,
            CB
        ]);

        res.json({
            message: 'Meter reading added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding meter reading:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'meter_readings table does not exist. Please create the table first.' });
        } else if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Meter reading already exists for this station, meter, date, and shift' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update meter reading
exports.updateMeterReading = async (req, res) => {
    try {
        const {
            id,
            station_id,
            meter_id,
            reading_date,
            shift,
            old_a,
            new_a,
            sale_a,
            old_b,
            new_b,
            sale_b,
            Active,
            active
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Meter Reading ID is required' });
        }
        if (!station_id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }
        if (!meter_id) {
            return res.status(400).json({ message: 'Meter ID is required' });
        }
        if (!reading_date) {
            return res.status(400).json({ message: 'Reading date is required' });
        }
        if (!shift) {
            return res.status(400).json({ message: 'Shift is required' });
        }

        // Check for duplicate reading (excluding current record)
        const checkQuery = `
            SELECT id FROM meter_readings 
            WHERE station_id = ? AND meter_id = ? AND reading_date = ? AND shift = ? 
            AND id != ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [station_id, meter_id, reading_date, shift, id]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Meter reading already exists for this station, meter, date, and shift' 
            });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const MB = req.body.MB || 'System';

        const query = `
            UPDATE meter_readings SET 
                station_id = ?,
                meter_id = ?,
                reading_date = ?,
                shift = ?,
                old_a = ?,
                new_a = ?,
                sale_a = ?,
                old_b = ?,
                new_b = ?,
                sale_b = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            station_id,
            meter_id,
            reading_date,
            shift,
            old_a || null,
            new_a || null,
            sale_a || null,
            old_b || null,
            new_b || null,
            sale_b || null,
            activeValue ? 1 : 0,
            MB,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }

        res.json({ message: 'Meter reading updated successfully' });
    } catch (err) {
        console.error('Error updating meter reading:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Meter reading already exists for this station, meter, date, and shift' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Delete meter reading (soft delete - set Active=0)
exports.deleteMeterReading = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Meter Reading ID is required' });
        }

        const query = 'UPDATE meter_readings SET Active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }

        res.json({ message: 'Meter reading deleted successfully' });
    } catch (err) {
        console.error('Error deleting meter reading:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

