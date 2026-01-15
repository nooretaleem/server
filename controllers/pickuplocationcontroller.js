const db = require('../models/db');

// Get all pick up locations
exports.getPickUpLocations = async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                name,
                CD,
                MD
            FROM pick_up_location
            ORDER BY name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching pick up locations:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single pick up location by ID
exports.getPickUpLocation = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Pick up location ID is required' });
        }

        const query = `
            SELECT *
            FROM pick_up_location
            WHERE id = ?
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Pick up location not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching pick up location:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new pick up location
exports.addPickUpLocation = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            name
        } = req.body;

        if (!name) {
            connection.release();
            return res.status(400).json({ message: 'Name is required' });
        }

        await connection.beginTransaction();

        // Insert into pick_up_location table
        const query = `
            INSERT INTO pick_up_location (name, CD, MD) 
            VALUES (?, NOW(), NOW())
        `;

        const [result] = await connection.execute(query, [
            name
        ]);

        await connection.commit();
        connection.release();

        res.json({
            message: 'Pick up location added successfully',
            id: result.insertId
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error adding pick up location:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'pick_up_location table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update pick up location
exports.updatePickUpLocation = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            id,
            name
        } = req.body;

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Pick up location ID is required' });
        }
        if (!name) {
            connection.release();
            return res.status(400).json({ message: 'Name is required' });
        }

        await connection.beginTransaction();

        const query = `
            UPDATE pick_up_location 
            SET name = ?, MD = NOW() 
            WHERE id = ?
        `;

        const [result] = await connection.execute(query, [
            name,
            id
        ]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Pick up location not found' });
        }

        await connection.commit();
        connection.release();

        res.json({ message: 'Pick up location updated successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error updating pick up location:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete pick up location (hard delete)
exports.deletePickUpLocation = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { id } = req.body;

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Pick up location ID is required' });
        }

        await connection.beginTransaction();

        // Check if pick up location exists
        const [locationRows] = await connection.execute('SELECT id FROM pick_up_location WHERE id = ?', [id]);
        if (locationRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Pick up location not found' });
        }

        // Hard delete
        const [result] = await connection.execute(
            'DELETE FROM pick_up_location WHERE id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Pick up location not found' });
        }

        await connection.commit();
        connection.release();

        res.json({ message: 'Pick up location deleted successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error deleting pick up location:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

