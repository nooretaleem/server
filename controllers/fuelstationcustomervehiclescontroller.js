const db = require('../models/db');

let resolvedVehicleTable = null;

async function resolveVehicleTable() {
    if (resolvedVehicleTable) return resolvedVehicleTable;
    const preferred = 'fuel_station_customer_vehicles';
    const fallback = 'fuele_station_customer_vehicles';
    try {
        const [rows] = await db.execute(
            `SELECT table_name FROM information_schema.tables 
             WHERE table_schema = DATABASE() AND table_name IN (?, ?)`,
            [preferred, fallback]
        );
        const names = rows.map(r => r.table_name);
        resolvedVehicleTable = names.includes(preferred) ? preferred : (names.includes(fallback) ? fallback : preferred);
    } catch (err) {
        resolvedVehicleTable = preferred;
    }
    return resolvedVehicleTable;
}

// Get vehicles for a fuel station customer (or all if not filtered)
exports.getFuelStationCustomerVehicles = async (req, res) => {
    try {
        const table = await resolveVehicleTable();
        const customerId = req.query.customer_id;
        let query = `
            SELECT 
                vehicle_id,
                customer_id,
                vehicle_number,
                Active,
                CB,
                MB,
                CD,
                MD
            FROM ${table}
            WHERE Active = 1
        `;
        const params = [];
        if (customerId) {
            query += ' AND customer_id = ?';
            params.push(customerId);
        }
        query += ' ORDER BY vehicle_number';
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching fuel station customer vehicles:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Add new vehicle for a fuel station customer
exports.addFuelStationCustomerVehicle = async (req, res) => {
    try {
        const table = await resolveVehicleTable();
        const { customer_id, vehicle_number } = req.body;
        if (!customer_id) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }
        if (!vehicle_number || !vehicle_number.trim()) {
            return res.status(400).json({ message: 'Vehicle number is required' });
        }
        const CB = req.body.CB || 'System';
        if (!CB) {
            return res.status(400).json({ message: 'CB (Created By - username) is required' });
        }

        const [dup] = await db.execute(
            `SELECT vehicle_id FROM ${table} WHERE customer_id = ? AND vehicle_number = ? AND Active = 1`,
            [customer_id, vehicle_number.trim()]
        );
        if (dup.length > 0) {
            return res.status(400).json({ message: 'Vehicle already exists for this customer' });
        }

        const [result] = await db.execute(
            `INSERT INTO ${table} (customer_id, vehicle_number, Active, CB, CD, MD)
             VALUES (?, ?, 1, ?, NOW(), NOW())`,
            [customer_id, vehicle_number.trim(), CB]
        );
        res.json({ message: 'Vehicle added successfully', vehicle_id: result.insertId });
    } catch (err) {
        console.error('Error adding fuel station customer vehicle:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'fuel_station_customer_vehicles table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update vehicle for a fuel station customer
exports.updateFuelStationCustomerVehicle = async (req, res) => {
    try {
        const table = await resolveVehicleTable();
        const { vehicle_id, customer_id, vehicle_number, Active, active } = req.body;
        if (!vehicle_id) {
            return res.status(400).json({ message: 'Vehicle ID is required' });
        }
        if (!customer_id) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }
        if (!vehicle_number || !vehicle_number.trim()) {
            return res.status(400).json({ message: 'Vehicle number is required' });
        }
        const MB = req.body.MB || req.body.CB;
        if (!MB) {
            return res.status(400).json({ message: 'MB (Modified By - username) is required' });
        }

        const [dup] = await db.execute(
            `SELECT vehicle_id FROM ${table} WHERE customer_id = ? AND vehicle_number = ? AND vehicle_id != ? AND Active = 1`,
            [customer_id, vehicle_number.trim(), vehicle_id]
        );
        if (dup.length > 0) {
            return res.status(400).json({ message: 'Vehicle already exists for this customer' });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const [result] = await db.execute(
            `UPDATE ${table} SET customer_id = ?, vehicle_number = ?, Active = ?, MB = ?, MD = NOW() WHERE vehicle_id = ?`,
            [customer_id, vehicle_number.trim(), activeValue ? 1 : 0, MB, vehicle_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.json({ message: 'Vehicle updated successfully' });
    } catch (err) {
        console.error('Error updating fuel station customer vehicle:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete vehicle (soft delete)
exports.deleteFuelStationCustomerVehicle = async (req, res) => {
    try {
        const table = await resolveVehicleTable();
        const vehicleId = req.body.vehicle_id || req.body.id || req.params.id;
        if (!vehicleId) {
            return res.status(400).json({ message: 'Vehicle ID is required' });
        }
        const [result] = await db.execute(
            `UPDATE ${table} SET Active = 0, MD = NOW() WHERE vehicle_id = ?`,
            [vehicleId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }
        res.json({ message: 'Vehicle deleted successfully' });
    } catch (err) {
        console.error('Error deleting fuel station customer vehicle:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};
