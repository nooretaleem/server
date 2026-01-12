const db = require('../models/db');

// Get all customers
exports.getCustomers = async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                name,
                phone,
                address,
                active,
                CD,
                CB,
                MD
            FROM customers
            WHERE active = 1
            ORDER BY name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching customers:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single customer by ID
exports.getCustomer = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }

        const query = 'SELECT id, name, phone, address, active, CD, CB, MD FROM customers WHERE id = ? AND active = 1';
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching customer:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new customer
exports.addCustomer = async (req, res) => {
    try {
        const {
            name,
            phone,
            address
        } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Customer name is required' });
        }

        // Get CB (Created By) from request body, default to 'System' if not provided
        const CB = req.body.CB || 'System';

        const query = `
            INSERT INTO customers (name, phone, address, active, CB, CD, MD) 
            VALUES (?, ?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [
            name,
            phone || null,
            address || null,
            CB
        ]);

        res.json({
            message: 'Customer added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding customer:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'customers table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update customer
exports.updateCustomer = async (req, res) => {
    try {
        const {
            id,
            name,
            phone,
            address,
            is_active,
            active
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }
        if (!name) {
            return res.status(400).json({ message: 'Customer name is required' });
        }

        // Handle both 'is_active' (from frontend) and 'active' (direct)
        const activeValue = is_active !== undefined ? is_active : (active !== undefined ? active : 1);

        const query = `
            UPDATE customers SET 
                name = ?,
                phone = ?,
                address = ?,
                active = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            name,
            phone || null,
            address || null,
            activeValue ? 1 : 0,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        res.json({ message: 'Customer updated successfully' });
    } catch (err) {
        console.error('Error updating customer:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete customer (soft delete - set active=0)
exports.deleteCustomer = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }

        // Check if customer exists and is active
        const [customerRows] = await db.execute('SELECT id, active FROM customers WHERE id = ?', [id]);
        if (customerRows.length === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        if (customerRows[0].active === 0) {
            return res.status(400).json({ message: 'Customer is already deleted' });
        }

        // Soft delete: set active=0 and update MD
        const [result] = await db.execute(
            'UPDATE customers SET active = 0, MD = NOW() WHERE id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        res.json({ message: 'Customer deleted successfully' });
    } catch (err) {
        console.error('Error deleting customer:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get customer sales history from pol_sale table
exports.getCustomerSales = async (req, res) => {
    try {
        const client_id = req.query.client_id;
        
        if (!client_id) {
            return res.status(400).json({ message: 'Client ID is required' });
        }

        const query = `
            SELECT 
                ps.id,
                ps.date,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.container_type,
                t.trip_no,
                tp.product_type
            FROM pol_sale ps
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            WHERE ps.client_id = ? AND ps.Active = 1
            ORDER BY ps.date DESC, ps.id DESC
        `;
        
        const [rows] = await db.execute(query, [client_id]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching customer sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get customer payments from recoveries table
exports.getCustomerPayments = async (req, res) => {
    try {
        const ClientID = req.query.ClientID;
        
        if (!ClientID) {
            return res.status(400).json({ message: 'Client ID is required' });
        }

        const query = `
            SELECT 
                r.ID,
                r.transactionID,
                r.ClientID,
                r.Amount,
                r.Payment_Head,
                r.Date,
                r.CD,
                r.MD,
                r.Active,
                t.AccountID,
                t.cash_in_hand_id
            FROM recoveries r
            LEFT JOIN transactions t ON r.transactionID = t.ID
            WHERE r.ClientID = ? AND r.Active = 1
            ORDER BY r.Date DESC, r.ID DESC
        `;
        
        const [rows] = await db.execute(query, [ClientID]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching customer payments:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get all customers with their due amounts
exports.getCustomersDueAmounts = async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id,
                c.name as client_name,
                c.phone as mobile_no,
                COALESCE(sales.purchased_fuel, 0) as purchased_fuel,
                COALESCE(sales.amount, 0) as amount,
                COALESCE(payments.paid, 0) as paid,
                (COALESCE(sales.amount, 0) - COALESCE(payments.paid, 0)) as due
            FROM customers c
            LEFT JOIN (
                SELECT 
                    client_id,
                    SUM(fuel) as purchased_fuel,
                    SUM(total_amount) as amount
                FROM pol_sale
                WHERE Active = 1
                GROUP BY client_id
            ) sales ON c.id = sales.client_id
            LEFT JOIN (
                SELECT 
                    ClientID,
                    SUM(Amount) as paid
                FROM recoveries
                WHERE Active = 1
                GROUP BY ClientID
            ) payments ON CAST(c.id AS UNSIGNED) = CAST(payments.ClientID AS UNSIGNED)
            WHERE c.active = 1
            HAVING (COALESCE(amount, 0) - COALESCE(paid, 0)) > 0 OR COALESCE(amount, 0) > 0
            ORDER BY due DESC, c.name ASC
        `;
        
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching customers due amounts:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

