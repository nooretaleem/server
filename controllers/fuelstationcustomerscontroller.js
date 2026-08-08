const db = require('../models/db');

// Get all fuel station customers
exports.getFuelStationCustomers = async (req, res) => {
    try {
        const query = `SELECT * FROM fuel_station_customer WHERE Active = 1 ORDER BY customer_name`;
        const [rows] = await db.execute(query);
        console.log('Fetched fuel station customers:', rows);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching fuel station customers:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

exports.getLocalCustomers = async (req, res) => {
    try {
        const query = `SELECT * FROM fuel_station_customer WHERE Active = 1 ORDER BY customer_name`;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching local customers:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single fuel station customer by ID
exports.getFuelStationCustomer = async (req, res) => {
    try {
        const customerId = req.query.customer_id;
        if (!customerId) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }

        const query = `
            SELECT 
                customer_id,
                customer_name,
                phone_number,
                customer_type,
                CB,
                CD,
                MB,
                MD,
                Active
            FROM fuel_station_customer
            WHERE customer_id = ? AND Active = 1
        `;
        const [rows] = await db.execute(query, [customerId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Fuel station customer not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching fuel station customer:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new fuel station customer
exports.addFuelStationCustomer = async (req, res) => {
    try {
        const {
            customer_name,
            phone_number,
            customer_type,
            Previous_Dues
        } = req.body;

        if (!customer_name || !customer_name.trim()) {
            return res.status(400).json({ message: 'Customer name is required' });
        }
        if (!phone_number || !phone_number.trim()) {
            return res.status(400).json({ message: 'Phone number is required' });
        }
        if (!customer_type || !customer_type.trim()) {
            return res.status(400).json({ message: 'Customer type is required' });
        }

        // Validate phone number (11 digits)
        const phoneDigits = phone_number.replace(/\D/g, '');
        if (phoneDigits.length !== 11) {
            return res.status(400).json({ message: 'Phone number must be exactly 11 digits' });
        }

        // Check for duplicate phone number
        const checkPhoneQuery = `
            SELECT customer_id FROM fuel_station_customer 
            WHERE phone_number = ? AND Active = 1
        `;
        const [existingPhone] = await db.execute(checkPhoneQuery, [phone_number.trim()]);

        if (existingPhone.length > 0) {
            return res.status(400).json({
                message: 'Customer with this phone number already exists'
            });
        }

        const CB = req.body.CB || 'System';
        if (!CB) {
            return res.status(400).json({ message: 'CB (Created By - username) is required' });
        }
        const MB = req.body.MB || CB;

        const query = `
            INSERT INTO fuel_station_customer (
                customer_name, phone_number, customer_type, Previous_Dues,
                Active, CB, CD, MB, MD
            ) 
            VALUES (?, ?, ?, ?, 1, ?, NOW(), ?, NOW())
        `;

        const [result] = await db.execute(query, [
            customer_name.trim(),
            phone_number.trim(),
            customer_type.trim(),
            Previous_Dues || 0,
            CB,
            MB
        ]);

        res.json({
            message: 'Fuel station customer added successfully',
            customer_id: result.insertId
        });
    } catch (err) {
        console.error('Error adding fuel station customer:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'fuel_station_customer table does not exist. Please create the table first.' });
        } else if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Duplicate entry. Customer with this phone number already exists.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update fuel station customer
exports.updateFuelStationCustomer = async (req, res) => {
    try {
        const {
            customer_id,
            customer_name,
            phone_number,
            customer_type,
            Previous_Dues,
            Active,
            active
        } = req.body;

        if (!customer_id) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }
        if (!customer_name || !customer_name.trim()) {
            return res.status(400).json({ message: 'Customer name is required' });
        }
        if (!phone_number || !phone_number.trim()) {
            return res.status(400).json({ message: 'Phone number is required' });
        }
        if (!customer_type || !customer_type.trim()) {
            return res.status(400).json({ message: 'Customer type is required' });
        }

        // Validate phone number (11 digits)
        const phoneDigits = phone_number.replace(/\D/g, '');
        if (phoneDigits.length !== 11) {
            return res.status(400).json({ message: 'Phone number must be exactly 11 digits' });
        }

        // Check for duplicate phone number (excluding current record)
        const checkPhoneQuery = `
            SELECT customer_id FROM fuel_station_customer 
            WHERE phone_number = ? AND customer_id != ? AND Active = 1
        `;
        const [existingPhone] = await db.execute(checkPhoneQuery, [phone_number.trim(), customer_id]);

        if (existingPhone.length > 0) {
            return res.status(400).json({
                message: 'Customer with this phone number already exists'
            });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const MB = req.body.MB || 'System';
        if (!MB) {
            return res.status(400).json({ message: 'MB (Modified By - username) is required' });
        }

        const query = `
            UPDATE fuel_station_customer SET
                customer_name = ?,
                phone_number = ?,
                customer_type = ?,
                Previous_Dues = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE customer_id = ?
        `;

        const [result] = await db.execute(query, [
            customer_name.trim(),
            phone_number.trim(),
            customer_type.trim(),
            Previous_Dues || 0,
            activeValue ? 1 : 0,
            MB,
            customer_id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Fuel station customer not found' });
        }

        res.json({ message: 'Fuel station customer updated successfully' });
    } catch (err) {
        console.error('Error updating fuel station customer:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Duplicate entry. Customer with this phone number already exists.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Delete fuel station customer (soft delete - set Active=0)
exports.deleteFuelStationCustomer = async (req, res) => {
    try {
        const customerId = req.body.customer_id || req.params.customer_id;

        if (!customerId) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }

        const query = 'UPDATE fuel_station_customer SET Active = 0, MD = NOW() WHERE customer_id = ?';
        const [result] = await db.execute(query, [customerId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Fuel station customer not found' });
        }

        res.json({ message: 'Fuel station customer deleted successfully' });
    } catch (err) {
        console.error('Error deleting fuel station customer:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get all petrol pumps for fuel station dropdown
exports.getPetrolPumps = async (req, res) => {

    try {


        const query = `
            SELECT 
                id,
                name,
                manager_id
            FROM petrol_pumps
            WHERE Active = 1
            ORDER BY name
        `;


        const [rows] = await db.execute(query);

        res.json(rows);
    } catch (err) {
        console.error('============================================');
        console.error('ERROR in getPetrolPumps:', err);
        console.error('============================================');
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

