const db = require('../models/db');

// Get all stations
exports.getStations = async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                name,
                location,
                CB,
                CD,
                MB,
                MD,
                Active
            FROM stations
            WHERE Active = 1
            ORDER BY name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching stations:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single station by ID
exports.getStation = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }

        const query = 'SELECT id, name, location, CB, CD, MB, MD, Active FROM stations WHERE id = ? AND Active = 1';
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Station not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching station:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new station
exports.addStation = async (req, res) => {
    try {
        const { name, location } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Station name is required' });
        }

        const CB = req.body.CB || 'System';

        const query = `
            INSERT INTO stations (name, location, active, CB, CD, MD) 
            VALUES (?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [
            name,
            location || null,
            CB
        ]);

        res.json({
            message: 'Station added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding station:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'stations table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update station
exports.updateStation = async (req, res) => {
    try {
        const { id, name, location, Active, active } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }
        if (!name) {
            return res.status(400).json({ message: 'Station name is required' });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const MB = req.body.MB || 'System';

        const query = `
            UPDATE stations SET 
                name = ?,
                location = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            name,
            location || null,
            activeValue ? 1 : 0,
            MB,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Station not found' });
        }

        res.json({ message: 'Station updated successfully' });
    } catch (err) {
        console.error('Error updating station:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete station (soft delete - set Active=0)
exports.deleteStation = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }

        // Check if station has associated meters
        const checkQuery = 'SELECT COUNT(*) as count FROM meters WHERE station_id = ? AND Active = 1';
        const [checkResult] = await db.execute(checkQuery, [id]);
        
        if (checkResult[0].count > 0) {
            return res.status(400).json({ 
                message: 'Cannot delete station. It has associated meters. Please delete or deactivate meters first.' 
            });
        }

        const query = 'UPDATE stations SET Active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Station not found' });
        }

        res.json({ message: 'Station deleted successfully' });
    } catch (err) {
        console.error('Error deleting station:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

