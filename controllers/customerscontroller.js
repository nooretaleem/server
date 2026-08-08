const db = require('../models/db');

function resolveAuditUser(req) {
    const b = req.body || {};
    return b.MB || b.CB || b.userName || b.username || b.UserName || b.createdBy || b.modifiedBy || 'System';
}

exports.getCustomerDues = async (req, res) => {
    try {
        const fuel_station_customer_id = req.query.client_id;
        if (!fuel_station_customer_id) {
            return res.status(400).json({ message: 'Client ID is required' });
        }
        else {
            const [rows] = await db.execute(
                `SELECT COALESCE(SUM(total_amount), 0) AS total_due
                            FROM credit_sales
                            WHERE fuel_station_customer_id = ? AND Active = 1`,
                [fuel_station_customer_id]
            );

            console.log('Credit Sales Dues ' + parseFloat(rows[0].total_due));

            const [prev_dues] = await db.execute(
                `SELECT COALESCE(SUM(previous_dues), 0) AS total_due
                            FROM fuel_station_customer
                            WHERE customer_id = ? AND Active = 1`,
                [fuel_station_customer_id]
            );

            console.log('Previous Dues ' + parseFloat(prev_dues[0].total_due));

            const totalDue = (rows && rows[0] ? parseFloat(rows[0].total_due) || 0 : 0) + (prev_dues && prev_dues[0] ? parseFloat(prev_dues[0].total_due) || 0 : 0);

            console.log('Total Dues ' + totalDue);

            const [recovery_rows] = await db.execute(
                `SELECT COALESCE(SUM(amount), 0) AS total_paid
                            FROM fuel_station_customer_recoveries
                            WHERE customer_id = ? AND Active = 1 `,
                [fuel_station_customer_id]
            );

            console.log('Total Recoveries ' + recovery_rows[0].total_paid);

            const totalPaid = recovery_rows && recovery_rows[0] ? parseFloat(recovery_rows[0].total_paid) || 0 : 0;


            const fuelStationDue = totalDue - totalPaid;
            console.log('Local Customer Rem ' + fuelStationDue);

            //console.log(totalDue, totalPaid, fuelStationDue);
            return res.json({ total_due: totalDue, total_paid: totalPaid, total_rem: fuelStationDue });
        }
    } catch (err) {
        console.error('Error fetching customer dues:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({ customer_dues: 0 });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

exports.getSupplierCustomerDues = async (req, res) => {
    try {
        const ws_customer_id = req.query.client_id;
        if (!ws_customer_id) {
            return res.status(400).json({ message: 'Client ID is required' });
        }
        else {


            const [prev_payables_rows] = await db.execute(
                `SELECT previous_dues 
                            FROM customers
                            WHERE id = ? AND Active = 1`,
                [ws_customer_id]
            );

            const [rows] = await db.execute(
                `SELECT COALESCE(SUM(total_amount), 0) AS total_due
                            FROM credit_sales
                            WHERE ws_customer_id = ? AND Active = 1`,
                [ws_customer_id]
            );
            const [creditsales_recovery_rows] = await db.execute(
                `SELECT COALESCE(SUM(amount), 0) AS total_paid
                            FROM fuel_station_customer_recoveries
                            WHERE ws_customer_id = ? AND Active = 1 `,
                [ws_customer_id]
            );
            console.log('Previous Dues: ' + (parseFloat(prev_payables_rows?.[0]?.previous_dues) || 0));


            const [pol_sale_rows] = await db.execute(
                `SELECT COALESCE(SUM(total_amount), 0) AS total_due
                            FROM pol_sale
                            WHERE client_id = ? AND Active = 1`,
                [ws_customer_id]
            );
            const [trip_recovery_rows] = await db.execute(
                `SELECT COALESCE(SUM(amount), 0) AS total_paid
                            FROM recoveries
                            WHERE clientid = ? AND Active = 1  and trip_id is not null`,
                [ws_customer_id]
            );
            console.log('Total Trips Sale: ' + (parseFloat(pol_sale_rows?.[0]?.total_due) || 0));
            console.log('Total Trips Recoveries: ' + (parseFloat(trip_recovery_rows?.[0]?.total_paid)));
            console.log('Petrol Pump Credit Sales: ' + (parseFloat(rows?.[0]?.total_due) || 0));
            console.log('Petrol Pump Credit Sales Recoveries: ' + (parseFloat(creditsales_recovery_rows?.[0]?.total_due) || 0));

            const _prevuduesforfrontend = (parseFloat(prev_payables_rows?.[0]?.previous_dues) || 0);
            const _tripduesforfrontend = ((parseFloat(pol_sale_rows?.[0]?.total_due) || 0) - (parseFloat(trip_recovery_rows?.[0]?.total_paid)));
            const _pumpduesforfrontend = ((parseFloat(rows?.[0]?.total_due) || 0) - (parseFloat(creditsales_recovery_rows?.[0]?.total_paid) || 0));

            //total dues= (credit sales - credit sales recoveries) + (prev payables) + (trip sale - trip recoveries)
            const totalDue =
                ((parseFloat(rows?.[0]?.total_due) || 0) - (parseFloat(creditsales_recovery_rows?.[0]?.total_due) || 0)) + (parseFloat(prev_payables_rows?.[0]?.previous_dues)) +
                ((parseFloat(pol_sale_rows?.[0]?.total_due) || 0) - (parseFloat(trip_recovery_rows?.[0]?.total_paid)));
            console.log('Total Dues: ' + totalDue);




            const [prev_dues_recovery_rows] = await db.execute(
                `SELECT COALESCE(SUM(amount), 0) AS total_paid
                            FROM recoveries
                            WHERE clientid = ? AND Active = 1  and trip_id is null`,
                [ws_customer_id]
            );




            const totalPaid =
                (parseFloat(trip_recovery_rows?.[0]?.total_paid) || 0) + (parseFloat(prev_dues_recovery_rows?.[0]?.total_paid) || 0) +
                (parseFloat(creditsales_recovery_rows?.[0]?.total_paid) || 0);

            const fuelStationDue = (totalDue + totalPaid) - totalPaid;

            console.log('Total Dues: ' + totalDue);
            console.log('Prev Dues Recoveries: ' + (parseFloat(prev_dues_recovery_rows?.[0]?.total_paid)));
            console.log('Recovery of Trips: ' + (parseFloat(trip_recovery_rows?.[0]?.total_paid)));
            console.log('Fuel Station Recoveries: ' + (parseFloat(creditsales_recovery_rows?.[0]?.total_due) || 0));
            console.log('Total Recoveries: ' + totalPaid);
            console.log('Remaining Dues: ' + fuelStationDue);
            //let pol_sales_recoveries = pol_sale_recovery_rows && pol_sale_recovery_rows[0] ? parseFloat(pol_sale_recovery_rows[0].total_paid) || 0 : 0;
            //const totalPaid = recovery_rows && recovery_rows[0] ? parseFloat(recovery_rows[0].total_paid) + pol_sales_recoveries || 0 : 0;







            return res.json({
                total_due: totalDue, total_paid: totalPaid, total_rem: fuelStationDue, _prevuduesforfrontend: _prevuduesforfrontend,
                _tripduesforfrontend: _tripduesforfrontend, _pumpduesforfrontend: _pumpduesforfrontend
            });
        }
    } catch (err) {
        console.error('Error fetching customer dues:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({ customer_dues: 0 });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};



// Get all customers
/* --Calculate customer dues correctly:
--Since recoveries are applied to Previous_Dues FIRST, then to POL Sale:
--The correct formula is: Current Previous_Dues + (POL Sale Amount - Recoveries Applied to POL Sale)
--To calculate "Recoveries Applied to POL Sale", we need to know how much went to Previous_Dues.
                --Since we don't track original Previous_Dues, we use this logic:
--If Current Previous_Dues >= Total Recoveries: All recoveries went to Previous_Dues, so POL Sale Dues = Sales
--If Current Previous_Dues < Total Recoveries: (Total Recoveries - Current Previous_Dues) went to POL Sale
--But this assumes Current Previous_Dues represents what's left after recoveries, which is correct.
--So: Recoveries Applied to POL Sale = GREATEST(0, Total Recoveries - Current Previous_Dues)
--POL Sale Dues = Sales - Recoveries Applied to POL Sale
--Total Dues = Current Previous_Dues + POL Sale Dues */
exports._getCustomers = async (req, res) => {
    try {
        const query1 = `
            SELECT 
                c.id,
                c.name,
                c.phone,
                c.address,
                c.Previous_Dues,
                c.active,
                c.CD,
                c.CB,
                c.MD,
                NULL as customer_type_id,
                'External' as customer_type_name,
                COALESCE(sales.total_purchased_fuel_ltrs, 0) as total_purchased_fuel_ltrs,
                COALESCE(sales.total_amount, 0) as total_sales,
                COALESCE(recoveries.total_paid, 0) as total_paid,
               
                (
                    COALESCE(c.Previous_Dues, 0) + 
                    GREATEST(0, 
                        COALESCE(sales.total_amount, 0) - 
                        GREATEST(0, COALESCE(recoveries.total_paid, 0) - COALESCE(c.Previous_Dues, 0))
                    )
                ) as customer_dues,
                'customer' as source_type
                   COALESCE((
                    SELECT SUM(balance)
                    FROM recoveries_advance
                    WHERE ws_customer_id = c.id
                      AND Active = 1
                      AND (pump_id IS NULL OR pump_id = 0)
                      AND (fs_customer_id IS NULL OR fs_customer_id = 0)
                ), 0) as customer_advance,
                'customer' as source_type
            FROM customers c
            LEFT JOIN (
                SELECT 
                    client_id,
                    SUM(fuel) AS total_purchased_fuel_ltrs,
                    SUM(total_amount) AS total_amount
                FROM pol_sale
                WHERE Active = 1 AND (pump_id IS NULL OR pump_id = 0)
                GROUP BY client_id
            ) sales ON c.id = sales.client_id
            LEFT JOIN (
                SELECT 
                    ClientID,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1 AND (pump_id IS NULL OR pump_id = 0)
                GROUP BY ClientID
            ) recoveries ON c.id = recoveries.ClientID
             
            WHERE c.active = 1
            
            UNION ALL
            
            SELECT 
                pp.id,
                pp.name,
                NULL as phone,
                pp.location as address,
                COALESCE(pp.Previous_Dues, 0) as Previous_Dues,
                pp.Active as active,
                pp.CD,
                pp.CB,
                pp.MD,
                NULL as customer_type_id,
                'Self' as customer_type_name,
                COALESCE(sales.total_purchased_fuel_ltrs, 0) as total_purchased_fuel_ltrs,
                COALESCE(sales.total_amount, 0) as total_sales,
                COALESCE(recoveries.total_paid, 0) as total_paid,
                -- Calculate customer dues correctly for petrol pumps:
                -- Same formula as customers: Current Previous_Dues + (POL Sale Amount - Recoveries Applied to POL Sale)
                (
                    COALESCE(pp.Previous_Dues, 0) + 
                    GREATEST(0, 
                        COALESCE(sales.total_amount, 0) - 
                        GREATEST(0, COALESCE(recoveries.total_paid, 0) - COALESCE(pp.Previous_Dues, 0))
                    )
                ) as customer_dues,
                  COALESCE((
                    SELECT SUM(balance)
                    FROM recoveries_advance
                    WHERE pump_id = pp.id
                      AND Active = 1
                      AND (ws_customer_id IS NULL OR ws_customer_id = 0)
                      AND (fs_customer_id IS NULL OR fs_customer_id = 0)
                ), 0) as customer_advance,
                'petrol_pump' as source_type
            FROM petrol_pumps pp
            LEFT JOIN (
                SELECT 
                    pump_id,
                    SUM(fuel) AS total_purchased_fuel_ltrs,
                    SUM(total_amount) AS total_amount
                FROM pol_sale
                WHERE Active = 1 AND pump_id IS NOT NULL
                GROUP BY pump_id
            ) sales ON pp.id = sales.pump_id
            LEFT JOIN (
                SELECT 
                    pump_id,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1 AND pump_id IS NOT NULL
                GROUP BY pump_id
            ) recoveries ON pp.id = recoveries.pump_id

            WHERE pp.Active = 1
            
            ORDER BY name
        `;

        const query = `
            SELECT 
                c.id,
                c.name,
                c.phone,
                c.address,
                c.Previous_Dues,
                c.active,
                c.CD,
                c.CB,
                c.MD,
                NULL as customer_type_id,
                'External' as customer_type_name,
                COALESCE(sales.total_purchased_fuel_ltrs, 0) as total_purchased_fuel_ltrs,
                COALESCE(sales.total_amount, 0) as total_sales,
                COALESCE(recoveries.total_paid, 0) as total_paid,
                (
                    COALESCE(c.Previous_Dues, 0) + 
                    GREATEST(0, 
                        COALESCE(sales.total_amount, 0) - 
                        GREATEST(0, COALESCE(recoveries.total_paid, 0) - COALESCE(c.Previous_Dues, 0))
                    )
                ) as customer_dues,
                -- ✅ Simplified advance subquery
                COALESCE((
                    SELECT SUM(balance) 
                    FROM recoveries_advance 
                    WHERE ws_customer_id = c.id 
                      AND Active = 1 
                      AND (pump_id IS NULL OR pump_id = 0) 
                      AND (fs_customer_id IS NULL OR fs_customer_id = 0)
                ), 0) as customer_advance,
                'customer' as source_type
            FROM customers c
            LEFT JOIN (
                SELECT 
                    client_id,
                    SUM(fuel) AS total_purchased_fuel_ltrs,
                    SUM(total_amount) AS total_amount
                FROM pol_sale
                WHERE Active = 1 AND (pump_id IS NULL OR pump_id = 0)
                GROUP BY client_id
            ) sales ON c.id = sales.client_id
            LEFT JOIN (
                SELECT 
                    ClientID,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1 AND (pump_id IS NULL OR pump_id = 0)
                GROUP BY ClientID
            ) recoveries ON c.id = recoveries.ClientID
            WHERE c.active = 1
            
            UNION ALL
            
            SELECT 
                pp.id,
                pp.name,
                NULL as phone,
                pp.location as address,
                COALESCE(pp.Previous_Dues, 0) as Previous_Dues,
                pp.Active as active,
                pp.CD,
                pp.CB,
                pp.MD,
                NULL as customer_type_id,
                'Self' as customer_type_name,
                COALESCE(sales.total_purchased_fuel_ltrs, 0) as total_purchased_fuel_ltrs,
                COALESCE(sales.total_amount, 0) as total_sales,
                COALESCE(recoveries.total_paid, 0) as total_paid,
                (
                    COALESCE(pp.Previous_Dues, 0) + 
                    GREATEST(0, 
                        COALESCE(sales.total_amount, 0) - 
                        GREATEST(0, COALESCE(recoveries.total_paid, 0) - COALESCE(pp.Previous_Dues, 0))
                    )
                ) as customer_dues,
                -- ✅ Simplified advance subquery for petrol pumps
                COALESCE((
                    SELECT SUM(balance) 
                    FROM recoveries_advance 
                    WHERE pump_id = pp.id 
                      AND Active = 1 
                      AND (ws_customer_id IS NULL OR ws_customer_id = 0) 
                      AND (fs_customer_id IS NULL OR fs_customer_id = 0)
                ), 0) as customer_advance,
                'petrol_pump' as source_type
            FROM petrol_pumps pp
            LEFT JOIN (
                SELECT 
                    pump_id,
                    SUM(fuel) AS total_purchased_fuel_ltrs,
                    SUM(total_amount) AS total_amount
                FROM pol_sale
                WHERE Active = 1 AND pump_id IS NOT NULL
                GROUP BY pump_id
            ) sales ON pp.id = sales.pump_id
            LEFT JOIN (
                SELECT 
                    pump_id,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1 AND pump_id IS NOT NULL
                GROUP BY pump_id
            ) recoveries ON pp.id = recoveries.pump_id
            WHERE pp.Active = 1
            
            ORDER BY name
        `;

        const [rows] = await db.execute(query);
        /*  
          console.log('=== Customers with Advance Data ===');
          rows.forEach(row => {
              console.log(`ID: ${row.id}, Name: ${row.name}, Advance: ${row.customer_advance}`);
          }); */
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

exports.getCustomers = async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id,
                c.name,
                c.phone,
                c.address,
                c.Previous_Dues,
                c.active,
                c.CD,
                c.CB,
                c.MD,
                NULL as customer_type_id,
                'External' as customer_type_name,
                COALESCE(sales.total_purchased_fuel_ltrs, 0) as total_purchased_fuel_ltrs,
                COALESCE(sales.total_amount, 0) as total_sales,
                COALESCE(recoveries.total_paid, 0) as total_paid,
                
                -- Separate columns for breakdown
                COALESCE(c.Previous_Dues, 0) as prev_dues,
                
                -- Trip Dues = POL Sale Total - Trip Recoveries
                GREATEST(0, 
                    COALESCE(sales.total_amount, 0) - 
                    COALESCE(trip_recoveries.total_paid, 0)
                ) as trip_dues,
                
                -- Petrol Pump Dues = Credit Sales Total - Credit Sales Recoveries
                GREATEST(0,
                    COALESCE(credit_sales.total_amount, 0) - 
                    COALESCE(credit_recoveries.total_paid, 0)
                ) as petrol_pump_dues,
                
                -- Total Dues = Previous Dues + Trip Dues + Petrol Pump Dues
                (
                    COALESCE(c.Previous_Dues, 0) + 
                    GREATEST(0, COALESCE(sales.total_amount, 0) - COALESCE(trip_recoveries.total_paid, 0)) +
                    GREATEST(0, COALESCE(credit_sales.total_amount, 0) - COALESCE(credit_recoveries.total_paid, 0))
                ) as customer_dues,
                
                -- ✅ FIXED: Get advance balance from recoveries_advance
                COALESCE((
                    SELECT SUM(COALESCE(credit, 0) - COALESCE(debit, 0))
                    FROM recoveries_advance 
                    WHERE ws_customer_id = c.id 
                      AND Active = 1 
                      AND (pump_id IS NULL OR pump_id = 0) 
                      AND (fs_customer_id IS NULL OR fs_customer_id = 0)
                ), 0) as customer_advance,
                
                'customer' as source_type
                
            FROM customers c
            
            -- POL Sales (Trip Sales)
            LEFT JOIN (
                SELECT 
                    client_id,
                    SUM(fuel) AS total_purchased_fuel_ltrs,
                    SUM(total_amount) AS total_amount
                FROM pol_sale
                WHERE Active = 1 AND (pump_id IS NULL OR pump_id = 0)
                GROUP BY client_id
            ) sales ON c.id = sales.client_id
            
            -- Trip Recoveries (from recoveries table with trip_id)
            LEFT JOIN (
                SELECT 
                    ClientID,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1 AND trip_id IS NOT NULL AND (pump_id IS NULL OR pump_id = 0)
                GROUP BY ClientID
            ) trip_recoveries ON c.id = trip_recoveries.ClientID
            
            -- Credit Sales (Petrol Pump Sales)
            LEFT JOIN (
                SELECT 
                    ws_customer_id,
                    SUM(total_amount) AS total_amount
                FROM credit_sales
                WHERE Active = 1
                GROUP BY ws_customer_id
            ) credit_sales ON c.id = credit_sales.ws_customer_id
            
            -- Credit Sales Recoveries (from fuel_station_customer_recoveries)
            LEFT JOIN (
                SELECT 
                    ws_customer_id,
                    SUM(amount) AS total_paid
                FROM fuel_station_customer_recoveries
                WHERE Active = 1
                GROUP BY ws_customer_id
            ) credit_recoveries ON c.id = credit_recoveries.ws_customer_id
            
            -- Total Recoveries (all types - for backward compatibility)
            LEFT JOIN (
                SELECT 
                    ClientID,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1 AND (pump_id IS NULL OR pump_id = 0)
                GROUP BY ClientID
            ) recoveries ON c.id = recoveries.ClientID
            
            WHERE c.active = 1
            
            UNION ALL
            
            SELECT 
                pp.id,
                pp.name,
                NULL as phone,
                pp.location as address,
                COALESCE(pp.Previous_Dues, 0) as Previous_Dues,
                pp.Active as active,
                pp.CD,
                pp.CB,
                pp.MD,
                NULL as customer_type_id,
                'Self' as customer_type_name,
                COALESCE(sales.total_purchased_fuel_ltrs, 0) as total_purchased_fuel_ltrs,
                COALESCE(sales.total_amount, 0) as total_sales,
                COALESCE(recoveries.total_paid, 0) as total_paid,
                
                -- Separate columns for breakdown
                COALESCE(pp.Previous_Dues, 0) as prev_dues,
                
                -- Trip Dues for Petrol Pumps
                GREATEST(0, 
                    COALESCE(sales.total_amount, 0) - 
                    COALESCE(trip_recoveries.total_paid, 0)
                ) as trip_dues,
                
                -- Petrol Pump Dues for Petrol Pumps
                GREATEST(0,
                    COALESCE(credit_sales.total_amount, 0) - 
                    COALESCE(credit_recoveries.total_paid, 0)
                ) as petrol_pump_dues,
                
                -- Total Dues
                (
                    COALESCE(pp.Previous_Dues, 0) + 
                    GREATEST(0, COALESCE(sales.total_amount, 0) - COALESCE(trip_recoveries.total_paid, 0)) +
                    GREATEST(0, COALESCE(credit_sales.total_amount, 0) - COALESCE(credit_recoveries.total_paid, 0))
                ) as customer_dues,
                
                -- ✅ FIXED: Get advance balance for petrol pumps
                COALESCE((
                    SELECT SUM(balance) 
                    FROM recoveries_advance 
                    WHERE pump_id = pp.id 
                      AND Active = 1 
                      AND (ws_customer_id IS NULL OR ws_customer_id = 0) 
                      AND (fs_customer_id IS NULL OR fs_customer_id = 0)
                ), 0) as customer_advance,
                
                'petrol_pump' as source_type
                
            FROM petrol_pumps pp
            
            LEFT JOIN (
                SELECT 
                    pump_id,
                    SUM(fuel) AS total_purchased_fuel_ltrs,
                    SUM(total_amount) AS total_amount
                FROM pol_sale
                WHERE Active = 1 AND pump_id IS NOT NULL
                GROUP BY pump_id
            ) sales ON pp.id = sales.pump_id
            
            LEFT JOIN (
                SELECT 
                    pump_id,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1 AND trip_id IS NOT NULL AND pump_id IS NOT NULL
                GROUP BY pump_id
            ) trip_recoveries ON pp.id = trip_recoveries.pump_id
            
            LEFT JOIN (
                SELECT 
                    pump_id,
                    SUM(Amount) AS total_paid
                FROM recoveries
                WHERE Active = 1 AND (pump_id IS NOT NULL)
                GROUP BY pump_id
            ) recoveries ON pp.id = recoveries.pump_id
            
            LEFT JOIN (
                SELECT 
                    ws_customer_id,
                    SUM(total_amount) AS total_amount
                FROM credit_sales
                WHERE Active = 1
                GROUP BY ws_customer_id
            ) credit_sales ON pp.id = credit_sales.ws_customer_id
            
            LEFT JOIN (
                SELECT 
                    ws_customer_id,
                    SUM(amount) AS total_paid
                FROM fuel_station_customer_recoveries
                WHERE Active = 1
                GROUP BY ws_customer_id
            ) credit_recoveries ON pp.id = credit_recoveries.ws_customer_id
            
            WHERE pp.Active = 1
            
            ORDER BY name
        `;

        const [rows] = await db.execute(query);

        // Log to verify advance data
        /* console.log('Customers with advance:', rows.map(r => ({
            id: r.id,
            name: r.name,
            advance: r.customer_advance
        }))); */

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

        const query = 'SELECT id, name, phone, address, Previous_Dues, active, CD, CB, MD FROM customers WHERE id = ? AND active = 1';
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
            Previous_Dues
        } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Customer name is required' });
        }

        // Get CB (Created By) from request body, default to 'System' if not provided
        const CB = resolveAuditUser(req);
        // Get Previous_Dues, default to 0 if not provided
        const previousDues = parseFloat(Previous_Dues || 0) || 0;

        const query = `
            INSERT INTO customers (name, phone, address, Previous_Dues, active, CB, MB, CD, MD) 
            VALUES (?, ?, ?, ?, 1, ?, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [
            name,
            phone || null,
            address || null,
            previousDues,
            CB,
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
        const MB = resolveAuditUser(req);

        const query = `
            UPDATE customers SET 
                name = ?,
                phone = ?,
                address = ?,
                Previous_Dues = ?,
                active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            name,
            phone || null,
            address || null,
            previousDues,
            activeValue ? 1 : 0,
            MB,
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
        const MB = resolveAuditUser(req);
        const [result] = await db.execute(
            'UPDATE customers SET active = 0, MB = ?, MD = NOW() WHERE id = ?',
            [MB, id]
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
exports.__getCustomerSales = async (req, res) => {
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
                td.paid_amount as paid,
                d.name as depo_name
            FROM pol_sale ps
            LEFT JOIN trips t ON ps.trip_id = t.id  -- Removed AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id  -- Removed AND tp.Active = 1
            LEFT JOIN trip_depos td ON ps.trip_id = td.trip_id
                AND ps.trip_product_id = td.product_id
                -- Removed AND td.Active = 1
            LEFT JOIN depo d ON td.depo_id = d.id  -- Removed AND d.active = 1
            WHERE ps.client_id = ? AND ps.Active = 1
            ORDER BY ps.date ASC, ps.id ASC;
        `;

        const [salesRows] = await db.execute(salesQuery, [client_id]);
        //console.log(JSON.stringify(salesRows, null, 2));
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
            console.log('Total Paid: ' + totalPaid);
            console.log(`Sale Amount: ${saleAmount}, Paid Amount: ${paidAmount}, Remaining Paid: ${remainingPaid}`);
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

// Get customer sales history from pol_sale table with paid amounts from recoveries
exports._getSelfCustomerSales = async (req, res) => {
    try {
        const client_id = req.query.client_id;

        if (!client_id) {
            return res.status(400).json({ message: 'Client ID is required' });
        }

        // First, get total paid amount from recoveries for this customer
        const totalPaidQuery = `
            SELECT COALESCE(SUM(Amount), 0) AS total_paid
            FROM recoveries
            WHERE pump_id = ? AND Active = 1
        `;
        const [paidRows] = await db.execute(totalPaidQuery, [client_id]);
        const totalPaid = parseFloat(paidRows[0]?.total_paid || 0);
        console.log('Total Paid: ' + totalPaid);
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
            WHERE ps.pump_id = ? AND ps.Active = 1
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
        console.log('Total Sales: ' + totalSales);
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
        console.error('Error fetching self customer sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};
exports.getCustomerSales = async (req, res) => {
    try {
        const client_id = req.query.client_id;

        if (!client_id) {
            return res.status(400).json({ message: 'Client ID is required' });
        }

        // ✅ FIX 1: ONLY get recoveries that are specifically for Trips (trip_id IS NOT NULL)
        const tripPaidQuery = `
            SELECT COALESCE(SUM(Amount), 0) AS total_paid
            FROM recoveries
            WHERE ClientID = ? AND Active = 1 AND trip_id IS NOT NULL
        `;
        const [paidRows] = await db.execute(tripPaidQuery, [client_id]);
        const totalTripPaid = parseFloat(paidRows[0]?.total_paid || 0);

        // Get all sales for this customer with depo information
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
                td.paid_amount as paid,
                d.name as depo_name
            FROM pol_sale ps
            LEFT JOIN trips t ON ps.trip_id = t.id
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id
            LEFT JOIN trip_depos td ON ps.trip_id = td.trip_id
                AND ps.trip_product_id = td.product_id
            LEFT JOIN depo d ON td.depo_id = d.id
            WHERE ps.client_id = ? AND ps.Active = 1
            ORDER BY ps.date ASC, ps.id ASC;
        `;

        const [salesRows] = await db.execute(salesQuery, [client_id]);

        // Process sales rows
        const processedSales = salesRows.map(sale => {
            return {
                ...sale,
                depo_id: sale.depo_id ? parseInt(sale.depo_id, 10) : null,
                depo_name: sale.depo_name || null
            };
        });

        // ✅ FIX 2: Distribute ONLY Trip Payments across Trip Sales using FIFO
        let remainingTripPaid = totalTripPaid;
        const salesWithPaid = processedSales.map((sale) => {
            const saleAmount = parseFloat(sale.total_amount || 0);
            let paidAmount = 0;

            // Only apply Trip Payments to this sale
            if (remainingTripPaid > 0 && saleAmount > 0) {
                if (remainingTripPaid >= saleAmount) {
                    paidAmount = saleAmount;
                    remainingTripPaid -= saleAmount;
                } else {
                    paidAmount = remainingTripPaid;
                    remainingTripPaid = 0;
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
exports.getSelfCustomerSales = async (req, res) => {
    try {
        const client_id = req.query.client_id;

        if (!client_id) {
            return res.status(400).json({ message: 'Client ID is required' });
        }

        // Get total sales amount
        const salesQuery = `
            SELECT COALESCE(SUM(total_amount), 0) AS total_due
            FROM pol_sale
            WHERE pump_id = ? AND Active = 1
        `;
        const [salesRows] = await db.execute(salesQuery, [client_id]);
        const totalDue = parseFloat(salesRows[0]?.total_due || 0);
        console.log('Total Due (Sales):', totalDue);

        // Get total paid from recoveries
        const paidQuery = `
            SELECT COALESCE(SUM(Amount), 0) AS total_paid
            FROM recoveries
            WHERE pump_id = ? AND Active = 1
        `;
        const [paidRows] = await db.execute(paidQuery, [client_id]);
        const totalPaid = parseFloat(paidRows[0]?.total_paid || 0);
        console.log('Total Paid:', totalPaid);

        // Get detailed sales with depo information
        const detailedSalesQuery = `
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
            WHERE ps.pump_id = ? AND ps.Active = 1
            ORDER BY ps.date DESC, ps.id DESC
        `;

        const [salesRowsDetailed] = await db.execute(detailedSalesQuery, [client_id]);

        // Process sales - add depo info
        const processedSales = salesRowsDetailed.map(sale => {
            return {
                ...sale,
                depo_id: sale.depo_id ? parseInt(sale.depo_id, 10) : null,
                depo_name: sale.depo_name || null
            };
        });

        // Calculate remaining balance and advance
        const remainingDue = totalDue - totalPaid;
        const advanceBalance = remainingDue < 0 ? Math.abs(remainingDue) : 0;
        const netDue = remainingDue > 0 ? remainingDue : 0;

        console.log('Summary:', {
            totalDue,
            totalPaid,
            remainingDue,
            advanceBalance,
            netDue
        });

        // Return data in the format expected by frontend
        res.json({
            sales: processedSales,
            summary: {
                total_due: totalDue,
                total_paid: totalPaid,
                remaining_due: netDue,
                advance_balance: advanceBalance
            }
        });

    } catch (err) {
        console.error('Error fetching self customer sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({
                sales: [],
                summary: {
                    total_due: 0,
                    total_paid: 0,
                    remaining_due: 0,
                    advance_balance: 0
                }
            });
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

exports.getSelfCustomerPayments = async (req, res) => {
    try {
        const ClientID = req.query.ClientID;

        if (!ClientID) {
            return res.status(400).json({ message: 'Client ID is required' });
        }

        const query = `
            SELECT 
                r.ID,
                r.transactionID,
                r.pump_id,
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
            WHERE r.pump_ID = ? AND r.Active = 1
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
    let connection;

    try {
        connection = await db.getConnection();

        const query = `
      SELECT *
      FROM (
        SELECT
          c.id AS id,
          c.id AS client_id,
          c.id AS ws_customer_id,
          c.name AS client_name,
          c.phone AS mobile_no,
          'customer' AS customer_type,
          COALESCE(c.Previous_Dues, 0) AS previous_dues,
          COALESCE(sales.total_fuel, 0) AS purchased_fuel,
          COALESCE(sales.total_amount, 0) AS total_purchased,
          COALESCE(sales.total_amount, 0) AS amount,
          COALESCE(recoveries.total_paid, 0) AS total_paid,
          COALESCE(recoveries.total_paid, 0) AS paid,
          (
            COALESCE(c.Previous_Dues, 0) +
            GREATEST(
              0,
              COALESCE(sales.total_amount, 0) -
              GREATEST(0, COALESCE(recoveries.total_paid, 0) - COALESCE(c.Previous_Dues, 0))
            )
          ) AS due
        FROM customers c
        LEFT JOIN (
          SELECT
            client_id,
            SUM(fuel) AS total_fuel,
            SUM(total_amount) AS total_amount
          FROM pol_sale
          WHERE Active = 1 AND (pump_id IS NULL OR pump_id = 0)
          GROUP BY client_id
        ) sales ON sales.client_id = c.id
        LEFT JOIN (
          SELECT
            ClientID,
            SUM(Amount) AS total_paid
          FROM recoveries
          WHERE Active = 1 AND (pump_id IS NULL OR pump_id = 0)
          GROUP BY ClientID
        ) recoveries ON recoveries.ClientID = c.id
        WHERE c.Active = 1
          AND (
            COALESCE(c.Previous_Dues, 0) > 0
            OR COALESCE(sales.total_amount, 0) > 0
            OR COALESCE(recoveries.total_paid, 0) > 0
          )

        UNION ALL

        SELECT
          pp.id AS id,
          pp.id AS client_id,
          NULL AS ws_customer_id,
          pp.name AS client_name,
          NULL AS mobile_no,
          'petrol_pump' AS customer_type,
          NULL AS previous_dues,
          COALESCE(pump_sales.total_fuel, 0) AS purchased_fuel,
          COALESCE(pump_sales.total_amount, 0) AS total_purchased,
          COALESCE(pump_sales.total_amount, 0) AS amount,
          COALESCE(pump_recoveries.total_paid, 0) AS total_paid,
          COALESCE(pump_recoveries.total_paid, 0) AS paid,
          GREATEST(0, COALESCE(pump_sales.total_amount, 0) - COALESCE(pump_recoveries.total_paid, 0)) AS due
        FROM petrol_pumps pp
        LEFT JOIN (
          SELECT
            pump_id,
            SUM(fuel) AS total_fuel,
            SUM(total_amount) AS total_amount
          FROM pol_sale
          WHERE Active = 1 AND pump_id IS NOT NULL AND pump_id > 0
          GROUP BY pump_id
        ) pump_sales ON pump_sales.pump_id = pp.id
        LEFT JOIN (
          SELECT
            pump_id,
            SUM(Amount) AS total_paid
          FROM recoveries
          WHERE Active = 1 AND pump_id IS NOT NULL AND pump_id > 0
          GROUP BY pump_id
        ) pump_recoveries ON pump_recoveries.pump_id = pp.id
        WHERE pp.Active = 1
          AND (
            COALESCE(pump_sales.total_amount, 0) > 0
            OR COALESCE(pump_recoveries.total_paid, 0) > 0
          )
      ) dues
      WHERE COALESCE(dues.due, 0) > 0
      ORDER BY dues.due DESC, dues.client_name ASC
    `;

        const [rows] = await connection.execute(query);
        return res.status(200).json(rows);

    } catch (err) {
        console.error('Error fetching customers due amounts:', err);

        if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.status(200).json([]);
        }

        return res.status(500).json({
            success: false,
            message: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};
// Get supplier customer due amounts from credit sales and supplier recoveries
exports.getSupplierCustomerDueAmounts = async (req, res) => {
    try {
        const query = `
                        SELECT
                c.id,
                c.id AS ws_customer_id,
                c.name AS client_name,
                c.phone AS mobile_no,
                cs.total_amount AS amount,
                COALESCE(fscr.total_paid, 0) AS paid,
                GREATEST(0, cs.total_amount - COALESCE(fscr.total_paid, 0)) AS due,
                'supplier' AS customer_type
            FROM customers c
            -- 1. Total up all credit sales per customer
            INNER JOIN (
                SELECT ws_customer_id, SUM(total_amount) AS total_amount
                FROM credit_sales
                WHERE Active = 1
                GROUP BY ws_customer_id
            ) cs ON cs.ws_customer_id = c.id
            -- 2. Total up all recoveries per customer
            LEFT JOIN (
                SELECT ws_customer_id, SUM(amount) AS total_paid
                FROM fuel_station_customer_recoveries
                WHERE Active = 1
                GROUP BY ws_customer_id
            ) fscr ON fscr.ws_customer_id = c.id
            WHERE c.Active = 1
            ORDER BY due DESC, client_name ASC;
        `;

        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching supplier customer due amounts:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get local fuel-station customer due amounts from credit sales and recoveries
exports.getPumpLocalCustomerDueAmounts = async (req, res) => {


    try {


        const query = `
           SELECT
    fsc.customer_id AS id,
    fsc.customer_id AS fuel_station_customer_id,
    fsc.customer_name AS client_name,
    fsc.phone_number AS mobile_no,
    fsc.previous_dues AS previous_dues,
    COALESCE(cs.total_amount, 0) AS amount,
    COALESCE(fscr.total_paid, 0) AS paid,
    GREATEST(
        0,
        (COALESCE(cs.total_amount, 0) + fsc.previous_dues)
        - COALESCE(fscr.total_paid, 0)
    ) AS due,
    'local' AS customer_type
FROM fuel_station_customer fsc

LEFT JOIN (
    SELECT
        fuel_station_customer_id,
        SUM(total_amount) AS total_amount
    FROM credit_sales
    WHERE Active = 1
      AND fuel_station_customer_id IS NOT NULL
    GROUP BY fuel_station_customer_id
) cs ON cs.fuel_station_customer_id = fsc.customer_id

LEFT JOIN (
    SELECT
        customer_id AS fuel_station_customer_id,
        SUM(Amount) AS total_paid
    FROM fuel_station_customer_recoveries
    WHERE Active = 1
    GROUP BY customer_id
) fscr ON fscr.fuel_station_customer_id = fsc.customer_id

WHERE fsc.Active = 1
ORDER BY due DESC, client_name ASC
        `;

        const [rows] = await db.query(query);
        res.json(rows);

    } catch (err) {
        console.error('Error fetching pump local customer due amounts:', err);
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

// Get customer fuel quantities by type (for stations)
exports.getCustomerFuelByType = async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id,
                c.name,
                c.address,
                COALESCE(SUM(CASE WHEN tp.product_type = 'PMG' THEN ps.fuel ELSE 0 END), 0) as pmg_quantity,
                COALESCE(SUM(CASE WHEN tp.product_type = 'HSD' THEN ps.fuel ELSE 0 END), 0) as hsd_quantity,
                COALESCE(SUM(CASE WHEN tp.product_type = 'Mobile/Lube Oil' THEN ps.fuel ELSE 0 END), 0) as mobile_oil_quantity
            FROM customers c
            LEFT JOIN pol_sale ps ON c.id = ps.client_id AND ps.Active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            WHERE c.active = 1
            GROUP BY c.id, c.name, c.address
            ORDER BY c.name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching customer fuel by type:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

exports.getFuelStationCustomers = async (req, res) => {
    try {
        const query = `
            SELECT 
                fscc.customer_id,
                fscc.customer_name
            from fuel_station_customer fscc
            WHERE fscc.Active = 1
            
            ORDER BY fscc.customer_name
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
exports.getSuppliers = async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id,
                c.name
            from customers c   
            WHERE Active = 1
            
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

exports.getPumps = async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id,
                p.name
            from petrol_pumps p    
            WHERE Active = 1
            
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

