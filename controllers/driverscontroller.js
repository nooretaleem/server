const db = require('../models/db');

function resolveAuditUser(req) {
    const b = req.body || {};
    return (
        b.MB ||
        b.CB ||
        b.userName ||
        b.username ||
        b.UserName ||
        b.createdBy ||
        b.modifiedBy ||
        'System'
    ).toString().trim() || 'System';
}

// Get all drivers
exports.getDrivers = async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                name,
                phone,
                license_number,
                address,
                is_active,
                CB,
                MB,
                created_at,
                updated_at
            FROM drivers
            WHERE is_active = 1
            ORDER BY name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching drivers:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single driver by ID
exports.getDriver = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Driver ID is required' });
        }

        const query = 'SELECT * FROM drivers WHERE id = ? AND is_active = 1';
        const [rows] = await db.execute(query, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching driver:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new driver
exports.addDriver = async (req, res) => {
    try {
        const {
            name,
            phone,
            license_number,
            address,
            is_active
        } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Driver name is required' });
        }

        const auditUser = resolveAuditUser(req);

        const query = `
            INSERT INTO drivers (name, phone, license_number, address, is_active, CB, MB) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

        const [result] = await db.execute(query, [
            name,
            phone || null,
            license_number || null,
            address || null,
            typeof is_active === 'number' ? is_active : (is_active ? 1 : 0),
            auditUser,
            auditUser
        ]);

        res.json({
            message: 'Driver added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding driver:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'drivers table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update driver
exports.updateDriver = async (req, res) => {
    try {
        const {
            id,
            name,
            phone,
            license_number,
            address,
            is_active
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Driver ID is required' });
        }
        if (!name) {
            return res.status(400).json({ message: 'Driver name is required' });
        }

        const auditUser = resolveAuditUser(req);

        const query = `
            UPDATE drivers SET 
                name = ?,
                phone = ?,
                license_number = ?,
                address = ?,
                is_active = ?,
                MB = ?,
                updated_at = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            name,
            phone || null,
            license_number || null,
            address || null,
            typeof is_active === 'number' ? is_active : (is_active ? 1 : 0),
            auditUser,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        res.json({ message: 'Driver updated successfully' });
    } catch (err) {
        console.error('Error updating driver:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete driver (soft delete)
exports.deleteDriver = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Driver ID is required' });
        }

        const auditUser = resolveAuditUser(req);
        const [result] = await db.execute(
            'UPDATE drivers SET is_active = 0, MB = ?, updated_at = NOW() WHERE id = ? AND is_active = 1',
            [auditUser, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        res.json({ message: 'Driver deleted successfully' });
    } catch (err) {
        console.error('Error deleting driver:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

