const db = require('../models/db');

// Get all customers
exports.getCustomers = async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id,
                c.name,
                c.phone,
                c.address,
                c.Previous_Dues,
                c.customer_type_id,
                ct.type_name as customer_type_name,
                c.active,
                c.CD,
                c.CB,
                c.MD,
                COALESCE(sales.total_purchased_fuel_ltrs, 0) as total_purchased_fuel_ltrs,
                COALESCE(sales.total_amount, 0) as total_sales,
                COALESCE(recoveries.total_paid, 0) as total_paid,
                -- Calculate customer dues correctly:
                -- Since recoveries are applied to Previous_Dues FIRST, then to POL Sale:
                -- The correct formula is: Current Previous_Dues + (POL Sale Amount - Recoveries Applied to POL Sale)
                -- To calculate "Recoveries Applied to POL Sale", we need to know how much went to Previous_Dues.
                -- Since we don't track original Previous_Dues, we use this logic:
                -- If Current Previous_Dues >= Total Recoveries: All recoveries went to Previous_Dues, so POL Sale Dues = Sales
                -- If Current Previous_Dues < Total Recoveries: (Total Recoveries - Current Previous_Dues) went to POL Sale
                -- But this assumes Current Previous_Dues represents what's left after recoveries, which is correct.
                -- So: Recoveries Applied to POL Sale = GREATEST(0, Total Recoveries - Current Previous_Dues)
                -- POL Sale Dues = Sales - Recoveries Applied to POL Sale
                -- Total Dues = Current Previous_Dues + POL Sale Dues
                (
                    COALESCE(c.Previous_Dues, 0) + 
                    GREATEST(0, 
                        COALESCE(sales.total_amount, 0) - 
                        GREATEST(0, COALESCE(recoveries.total_paid, 0) - COALESCE(c.Previous_Dues, 0))
                    )
                ) as customer_dues
            FROM customers c
            LEFT JOIN customer_types ct ON c.customer_type_id = ct.id
            LEFT JOIN (
                SELECT 
                    client_id,
                    SUM(fuel) AS total_purchased_fuel_ltrs,
                    SUM(total_amount) AS total_amount
                FROM pol_sale
                WHERE Active = 1
                GROUP BY client_id
            ) sales ON c.id = sales.client_id
            LEFT JOIN (
                SELECT 
                    ClientID,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1
                GROUP BY ClientID
            ) recoveries ON c.id = recoveries.ClientID
            WHERE c.active = 1
            ORDER BY c.name
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

        const query = 'SELECT id, name, phone, address, Previous_Dues, customer_type_id, active, CD, CB, MD FROM customers WHERE id = ? AND active = 1';
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
            address,
            Previous_Dues,
            customer_type_id
        } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Customer name is required' });
        }

        // Get CB (Created By) from request body, default to 'System' if not provided
        const CB = req.body.CB || 'System';
        // Get Previous_Dues, default to 0 if not provided
        const previousDues = parseFloat(Previous_Dues || 0) || 0;
        // Get customer_type_id, can be null
        const customerTypeId = customer_type_id ? parseInt(customer_type_id) : null;

        const query = `
            INSERT INTO customers (name, phone, address, Previous_Dues, customer_type_id, active, CB, CD, MD) 
            VALUES (?, ?, ?, ?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [
            name,
            phone || null,
            address || null,
            previousDues,
            customerTypeId,
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
            Previous_Dues,
            customer_type_id,
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
        // Get Previous_Dues, default to 0 if not provided
        const previousDues = parseFloat(Previous_Dues || 0) || 0;
        // Get customer_type_id, can be null
        const customerTypeId = customer_type_id ? parseInt(customer_type_id) : null;

        const query = `
            UPDATE customers SET 
                name = ?,
                phone = ?,
                address = ?,
                Previous_Dues = ?,
                customer_type_id = ?,
                active = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            name,
            phone || null,
            address || null,
            previousDues,
            customerTypeId,
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

// Get customer sales history from pol_sale table with paid amounts from recoveries
exports.getCustomerSales = async (req, res) => {
    try {
        const client_id = req.query.client_id;
        
        if (!client_id) {
            return res.status(400).json({ message: 'Client ID is required' });
        }

        // First, get total paid amount from recoveries for this customer
        const totalPaidQuery = `
            SELECT COALESCE(SUM(Amount), 0) AS total_paid
            FROM recoveries
            WHERE ClientID = ? AND Active = 1
        `;
        const [paidRows] = await db.execute(totalPaidQuery, [client_id]);
        const totalPaid = parseFloat(paidRows[0]?.total_paid || 0);

        // Get all sales for this customer with depo information
        // Match each sale to its specific depo based on trip_id AND product_id (like Trip Distribution)
        const salesQuery = `
            SELECT DISTINCT
                ps.id,
                ps.date,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.container_type,
                ps.trip_id,
                ps.trip_product_id,
                t.trip_no,
                tp.product_type,
                td.depo_id,
                d.name as depo_name
            FROM pol_sale ps
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            LEFT JOIN trip_depos td ON ps.trip_id = td.trip_id 
                AND ps.trip_product_id = td.product_id 
                AND td.Active = 1
            LEFT JOIN depo d ON td.depo_id = d.id AND d.active = 1
            WHERE ps.client_id = ? AND ps.Active = 1
            ORDER BY ps.date ASC, ps.id ASC
        `;
        
        const [salesRows] = await db.execute(salesQuery, [client_id]);
        
        // Process sales rows - depo_id is already correctly matched
        const processedSales = salesRows.map(sale => {
            return {
                ...sale,
                depo_id: sale.depo_id ? parseInt(sale.depo_id, 10) : null,
                depo_name: sale.depo_name || null
            };
        });
        
        // Calculate total sales amount (using unique pol_sale records)
        const totalSales = processedSales.reduce((sum, sale) => sum + parseFloat(sale.total_amount || 0), 0);
        
        // Calculate paid amount per sale proportionally
        // Using FIFO approach: distribute payments to oldest sales first
        let remainingPaid = totalPaid;
        const salesWithPaid = processedSales.map((sale) => {
            const saleAmount = parseFloat(sale.total_amount || 0);
            let paidAmount = 0;
            
            if (remainingPaid > 0 && saleAmount > 0) {
                if (remainingPaid >= saleAmount) {
                    // Full payment for this sale
                    paidAmount = saleAmount;
                    remainingPaid -= saleAmount;
                } else {
                    // Partial payment
                    paidAmount = remainingPaid;
                    remainingPaid = 0;
                }
            }
            
            return {
                ...sale,
                paid: paidAmount
            };
        });
        
        // Sort back to DESC order for display
        salesWithPaid.sort((a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            if (dateA.getTime() !== dateB.getTime()) {
                return dateB.getTime() - dateA.getTime();
            }
            return (b.id || 0) - (a.id || 0);
        });
        
        res.json(salesWithPaid);
    } catch (err) {
        console.error('Error fetching customer sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get customer payments from recoveries table with depo information
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
                t.cash_in_hand_id,
                s.depo_id,
                d.name as depo_name
            FROM recoveries r
            LEFT JOIN transactions t ON r.transactionID = t.ID
            LEFT JOIN settlements s ON r.ID = s.recovery_id AND s.Active = 1
            LEFT JOIN depo d ON s.depo_id = d.id AND d.active = 1
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

// Get all customers with their due amounts from pol_sale and recoveries tables
exports.getCustomersDueAmounts = async (req, res) => {
    try {
        const query = `
            SELECT 
  c.id,
  c.id AS client_id,
  c.name AS client_name,
  c.phone AS mobile_no,

  COALESCE(sales.purchased_fuel, 0) AS purchased_fuel,
  COALESCE(sales.total_amount, 0) AS amount,
  COALESCE(recoveries.total_paid, 0) AS paid,

  -- Calculate dues correctly: Current Previous_Dues + (POL Sale - Recoveries Applied to POL Sale)
  -- Recoveries Applied to POL Sale = MAX(0, Total Recoveries - Current Previous_Dues)
  (
    COALESCE(c.Previous_Dues, 0) + 
    GREATEST(0, 
      COALESCE(sales.total_amount, 0) - 
      GREATEST(0, COALESCE(recoveries.total_paid, 0) - COALESCE(c.Previous_Dues, 0))
    )
  ) AS due

FROM customers c

LEFT JOIN (
  SELECT 
    client_id,
    SUM(fuel) AS purchased_fuel,
    SUM(total_amount) AS total_amount
  FROM pol_sale
  WHERE Active = 1
    AND Date >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)
  GROUP BY client_id
) sales ON c.id = sales.client_id

LEFT JOIN (
  SELECT 
    ClientID,
    SUM(Amount) AS total_paid
  FROM recoveries
  WHERE Active = 1
    AND Date >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)
  GROUP BY ClientID
) recoveries ON c.id = recoveries.ClientID

WHERE c.Active = 1
  AND (
    COALESCE(sales.total_amount, 0) > 0
    OR COALESCE(recoveries.total_paid, 0) > 0
  )

ORDER BY due DESC, c.name ASC`;
        
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

// Get all customer types
exports.getCustomerTypes = async (req, res) => {
    try {
        const query = `
            SELECT id, type_name, active 
            FROM customer_types 
            WHERE active = 1 
            ORDER BY type_name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching customer types:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

