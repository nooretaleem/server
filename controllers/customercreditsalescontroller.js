const db = require('../models/db');

function resolveAuditUser(req) {
    const b = req.body || {};
    return b.MB || b.CB || b.userName || b.username || b.UserName || b.createdBy || b.modifiedBy || 'System';
}

// Normalize sale_date to YYYY-MM-DD so it matches daily_sales_summary (e.g. accept dd-MM-yyyy from UI)
function normalizeSaleDate(input) {
    if (!input || typeof input !== 'string') return '';
    const s = input.split('T')[0].split(' ')[0].trim();
    if (!s) return '';
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // dd-MM-yyyy or dd-MM-yy → YYYY-MM-DD
    const parts = s.split('-');
    if (parts.length === 3 && parts[0].length <= 2 && parts[1].length <= 2) {
        const year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
        return `${year}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    return s;
}

let creditSaleVehicleColumn = null;
async function resolveCreditSaleVehicleColumn() {
    if (creditSaleVehicleColumn !== null) return creditSaleVehicleColumn;
    try {
        const [rows] = await db.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'customer_credit_sales'
             AND column_name IN ('vehicle_id', 'vehicle_number')`
        );
        const names = rows.map(r => r.column_name);
        creditSaleVehicleColumn = names.includes('vehicle_id') ? 'vehicle_id' : (names.includes('vehicle_number') ? 'vehicle_number' : null);
    } catch (err) {
        creditSaleVehicleColumn = null;
    }
    return creditSaleVehicleColumn;
}

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

async function ensureRecoverySchema(run) {
    const safeAlter = async (sql) => {
        try {
            await run(sql);
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME' && err.code !== 'ER_DUP_KEYNAME') {
                throw err;
            }
        }
    };

    // customer_ledger must store recovery metadata
    await safeAlter(`ALTER TABLE customer_ledger ADD COLUMN received_in VARCHAR(100) NULL`);
    await safeAlter(`ALTER TABLE customer_ledger ADD COLUMN purpose VARCHAR(500) NULL`);

    // cash-in-hand ledger table for station recoveries
    await run(
        `CREATE TABLE IF NOT EXISTS station_cash_in_hand (
            id INT AUTO_INCREMENT PRIMARY KEY,
            customer_id INT NOT NULL,
            ref_type VARCHAR(50) NULL,
            received_in VARCHAR(100) NULL,
            purpose VARCHAR(500) NULL,
            debit DECIMAL(12,2) DEFAULT 0,
            credit DECIMAL(12,2) DEFAULT 0,
            balance DECIMAL(12,2) DEFAULT 0,
            entry_date DATE NULL,
            CB VARCHAR(50) NULL,
            MB VARCHAR(50) NULL,
            CD DATETIME NULL,
            MD DATETIME NULL,
            active TINYINT(4) DEFAULT 1,
            INDEX idx_scih_customer (customer_id),
            INDEX idx_scih_entry_date (entry_date)
        )`
    );

    /* await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN ref_type VARCHAR(50) NULL`);
    await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN received_in VARCHAR(100) NULL`);
    await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN purpose VARCHAR(500) NULL`);
    await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN entry_date DATE NULL`);
    await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN active TINYINT(4) DEFAULT 1`);
    await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN CB VARCHAR(50) NULL`);
    await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN MB VARCHAR(50) NULL`);
    await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN CD DATETIME NULL`);
    await safeAlter(`ALTER TABLE station_cash_in_hand ADD COLUMN MD DATETIME NULL`); */




}

// Get total fuel sold and max allowed credit quantity for a station/fuel type/date (for Add Credit Sale form)
exports.getCreditSaleLimit = async (req, res) => {
    try {
        const station_id = req.query.station_id;
        const fuel_type_id = req.query.fuel_type_id;
        const sale_date = normalizeSaleDate(req.query.sale_date || '');
        if (!station_id || !fuel_type_id || !sale_date) {
            return res.status(400).json({ message: 'Station ID, fuel type ID and sale date are required' });
        }
        // Use DATE(sale_date) so we match both DATE and DATETIME columns
        const [summaryRows] = await db.execute(
            `SELECT id, total_liters, credit_sale FROM daily_sales_summary 
             WHERE station_id = ? AND fuel_type_id = ? AND DATE(sale_date) = ? AND (Active = 1 OR Active IS NULL) LIMIT 1`,
            [station_id, fuel_type_id, sale_date]
        );
        if (summaryRows.length === 0) {
            //console.log('getCreditSaleLimit: no row for', { station_id, fuel_type_id, sale_date });
            // Return 200 so the browser doesn't report 404; frontend checks for null total_liters/message
            return res.status(200).json({
                message: 'No daily sales summary for this station and fuel type on this date. Record meter readings or daily sales first.',
                total_liters: null,
                existing_credit_qty: null,
                max_allowed: null
            });
        }
        const totalLiters = parseFloat(summaryRows[0].total_liters) || 0;
        const [creditSumRows] = await db.execute(
            `SELECT COALESCE(SUM(quantity), 0) as total FROM customer_credit_sales 
             WHERE station_id = ? AND fuel_type = ? AND sale_date = ? AND Active = 1`,
            [station_id, fuel_type_id, sale_date]
        );
        const existingCreditQty = parseFloat(creditSumRows[0].total) || 0;
        const maxAllowed = Math.max(0, totalLiters - existingCreditQty);
        res.json({
            total_liters: totalLiters,
            existing_credit_qty: existingCreditQty,
            max_allowed: maxAllowed
        });
    } catch (err) {
        console.error('Error fetching credit sale limit:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get credit sales for a customer
exports.getCustomerCreditSales = async (req, res) => {
    try {
        const customerId = req.query.customer_id;
        if (!customerId) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }
        const query = `
            SELECT 
                cs.id,
                cs.daily_entry_id,
                cs.fuel_station_customer_id as customer_id,
                cs.fuel_type,
                cs.quantity_liters as quantity,
                cs.rate_per_liter as rate,
                cs.total_amount as amount,
                cs.payment_status,
                cs.paid_amount,
                cs.remaining_amount,
                cs.price_type,
                cs.specific_price,
                cs.notes,
                cs.CB,
                cs.cd as CD,
                dse.pump_id,
                pp.name as station_name
            FROM credit_sales cs
            LEFT JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id
            LEFT JOIN petrol_pumps pp ON dse.pump_id = pp.id
            WHERE cs.fuel_station_customer_id = ? AND cs.Active = 1
            ORDER BY cs.cd DESC, cs.id DESC
        `;
        const [rows] = await db.execute(query, [customerId]);

        res.json(rows);
    } catch (err) {
        console.error('Error fetching customer credit sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

exports.getLocalCustomersRecoveryHistory = async (req, res) => {
    try {
        const customerId = req.query.customer_id;
        if (!customerId) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }
        const [rows] = await db.execute(
            `SELECT amount,recovery_date,payment_mode,CD
             FROM fuel_station_customer_recoveries
             WHERE customer_id = ? AND Active = 1`,
            [customerId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error fetching local customer recovery history:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get total paid recovery for a customer from fuel_station_customer_recoveries
exports.getCustomerRecoveryTotal = async (req, res) => {
    try {
        const customerId = req.query.customer_id;
        if (!customerId) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }

        const [rows] = await db.execute(
            `SELECT COALESCE(SUM(amount), 0) AS total_paid
             FROM fuel_station_customer_recoveries
             WHERE customer_id = ? AND Active = 1`,
            [customerId]
        );

        const totalPaid = rows && rows[0] ? Number(rows[0].total_paid) || 0 : 0;
        res.json({ total_paid: totalPaid });
    } catch (err) {
        console.error('Error fetching customer recovery total:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({ total_paid: 0 });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get total due for a customer.
// fuel_station_customer_id: due from latest customer_ledger balance so ledger-only debits are included
// ws_customer_id: due from POL trip sales + credit_sales.remaining_amount
exports.getCustomerCreditDue = async (req, res) => {
    try {
        const { fuel_station_customer_id, ws_customer_id } = req.query;
        if (!fuel_station_customer_id && !ws_customer_id) {
            return res.status(400).json({ message: 'fuel_station_customer_id or ws_customer_id is required' });
        }

        if (fuel_station_customer_id) {
            // 1. Previous dues
            const [fs_previousDuesRows] = await db.execute(
                `SELECT COALESCE(previous_dues, 0) AS previous_dues
         FROM fuel_station_customer
         WHERE customer_id = ? AND Active = 1`,
                [fuel_station_customer_id]
            );

            const previousDues = parseFloat(fs_previousDuesRows?.[0]?.previous_dues || 0);

            // 2. Credit sales total
            const [creditRows] = await db.execute(
                `SELECT COALESCE(SUM(total_amount), 0) AS credit_total
         FROM credit_sales
         WHERE fuel_station_customer_id = ? AND Active = 1`,
                [fuel_station_customer_id]
            );
            const creditTotal = parseFloat(creditRows?.[0]?.credit_total || 0);

            // 3. Payments / recoveries
            const [paymentRows] = await db.execute(
                `SELECT COALESCE(SUM(Amount), 0) AS paid_total
         FROM recoveries
         WHERE ClientID = ? AND Active = 1`,
                [fuel_station_customer_id]
            );

            const paidTotal = parseFloat(paymentRows?.[0]?.paid_total || 0);


            // 4. Final calculation
            const fuelStationDue =
                previousDues + creditTotal - paidTotal;

            return res.json({
                total_due: Math.max(0, fuelStationDue),
                fuel_station_due: Math.max(0, fuelStationDue),
                trip_due: 0
            });
            /*  const [ledgerRows] = await db.execute(
                 `SELECT balance
                  FROM customer_ledger
                  WHERE customer_id = ? AND Active = 1
                  ORDER BY id DESC
                  LIMIT 1`,
                 [fuel_station_customer_id]
             );
             const fuelStationDue = ledgerRows && ledgerRows[0]
                 ? Math.max(0, parseFloat(ledgerRows[0].balance) || 0)
                 : 0;
 
             return res.json({ total_due: fuelStationDue, fuel_station_due: fuelStationDue, trip_due: 0 }); */
        } else {
            // 1) Trip due from POL sales formula used in customers list
            //    trip_due = Previous_Dues + max(0, total_sales - max(0, total_recoveries - Previous_Dues))
            const [tripRows] = await db.execute(
                `SELECT
                    (
                        COALESCE(c.Previous_Dues, 0) +
                        GREATEST(0,
                            COALESCE(sales.total_amount, 0) -
                            GREATEST(0, COALESCE(recoveries.total_paid, 0) - COALESCE(c.Previous_Dues, 0))
                        )
                    ) AS trip_due
                 FROM customers c
                 LEFT JOIN (
                    SELECT client_id, SUM(total_amount) AS total_amount
                    FROM pol_sale
                    WHERE Active = 1
                    GROUP BY client_id
                 ) sales ON sales.client_id = c.id
                 LEFT JOIN (
                    SELECT ClientID, SUM(Amount) AS total_paid
                    FROM recoveries
                    WHERE Active = 1
                    GROUP BY ClientID
                 ) recoveries ON recoveries.ClientID = c.id
                 WHERE c.id = ? AND c.active = 1`,
                [ws_customer_id]
            );

            // 2) Fuel-station due from supplier credit sales
            /*   const [creditRows] = await db.execute(
                  `SELECT COALESCE(SUM(remaining_amount), 0) AS fuel_station_due
                   FROM credit_sales
                   WHERE ws_customer_id = ? AND Active = 1 AND remaining_amount > 0`,
                  [ws_customer_id]
              ); */

            // 2. Credit sales total
            const [creditRows] = await db.execute(
                `SELECT COALESCE(SUM(total_amount), 0) AS fuel_station_due
         FROM credit_sales
         WHERE ws_customer_id = ? AND Active = 1`,
                [ws_customer_id]
            );
            const creditTotal = parseFloat(creditRows?.[0]?.credit_total || 0);


            // 3. Recoveries total
            const [recoveriesRows] = await db.execute(
                `SELECT COALESCE(SUM(amount), 0) AS fuel_station_recveries
         FROM fuel_station_customer_recoveries
         WHERE station_id = ? AND Active = 1`,
                [ws_customer_id]
            );
            const tripDue = tripRows && tripRows[0] ? parseFloat(tripRows[0].trip_due) || 0 : 0;
            const fuelStationDue = creditRows && creditRows[0] ? parseFloat(creditRows[0].fuel_station_due) || 0 : 0;
            const fuelStationRecoveries = recoveriesRows && recoveriesRows[0] ? parseFloat(recoveriesRows[0].fuel_station_recveries) || 0 : 0;

            const totalDue = tripDue + fuelStationDue - fuelStationRecoveries;
            return res.json({ total_due: totalDue, trip_due: tripDue, fuel_station_due: fuelStationDue });
        }
    } catch (err) {
        console.error('Error fetching customer credit due:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({ total_due: 0, trip_due: 0, fuel_station_due: 0 });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Add credit sale: insert customer_credit_sales, post to customer_ledger (debit), update daily_sales_summary
exports.addCustomerCreditSale = async (req, res) => {
    const connection = await db.getConnection ? await db.getConnection() : null;
    const useTransaction = !!connection;

    try {
        if (useTransaction) await connection.beginTransaction();

        const run = connection ? connection.execute.bind(connection) : db.execute.bind(db);

        const {
            customer_id,
            station_id,
            fuel_type_id,
            sale_date,
            quantity,
            rate,
            amount,
            vehicle_id,
            vehicle_number
        } = req.body;

        if (!customer_id || !station_id || !fuel_type_id || !sale_date) {
            if (useTransaction && connection) { try { await connection.rollback(); } catch (_) { } connection.release(); }
            return res.status(400).json({ message: 'Customer ID, station ID, fuel type ID and sale date are required' });
        }

        const dateOnly = (sale_date + '').split('T')[0].split(' ')[0];
        const CB = resolveAuditUser(req);

        // Load current rate from fuel_rates for this fuel type and date
        const [rateRows] = await run(
            `SELECT rate FROM fuel_rates 
             WHERE fuel_type_id = ? AND effective_date <= ? AND Active = 1 
             ORDER BY effective_date DESC LIMIT 1`,
            [fuel_type_id, dateOnly]
        );
        const effectiveRate = rateRows.length > 0 ? parseFloat(rateRows[0].rate) : (parseFloat(rate) || 0);
        if (rateRows.length === 0 && !rate) {
            if (useTransaction && connection) { try { await connection.rollback(); } catch (_) { } connection.release(); }
            return res.status(400).json({ message: 'No fuel rate found for this fuel type and date. Please add a rate in Fuel Rates first.' });
        }

        const qty = parseFloat(quantity) || 0;
        const amt = qty * effectiveRate;

        // Validate: fuel sold on credit must not exceed total fuel sale for station/fuel type/date (from daily_sales_summary)
        const [summaryRows] = await run(
            `SELECT id, total_liters, credit_sale, cash_sale FROM daily_sales_summary 
             WHERE station_id = ? AND fuel_type_id = ? AND sale_date = ? AND Active = 1 LIMIT 1`,
            [station_id, fuel_type_id, dateOnly]
        );
        if (summaryRows.length === 0) {
            if (useTransaction && connection) { try { await connection.rollback(); } catch (_) { } connection.release(); }
            return res.status(400).json({ message: 'No daily sales summary for this station and fuel type on this date. Record meter readings or daily sales first.' });
        }
        const totalLiters = parseFloat(summaryRows[0].total_liters) || 0;
        const [creditSumRows] = await run(
            `SELECT COALESCE(SUM(quantity), 0) as total FROM customer_credit_sales 
             WHERE station_id = ? AND fuel_type = ? AND sale_date = ? AND Active = 1`,
            [station_id, fuel_type_id, dateOnly]
        );
        const existingCreditQty = parseFloat(creditSumRows[0].total) || 0;
        const maxAllowed = Math.max(0, totalLiters - existingCreditQty);
        if (qty > maxAllowed) {
            if (useTransaction && connection) { try { await connection.rollback(); } catch (_) { } connection.release(); }
            return res.status(400).json({ message: `Credit sale quantity exceeds total fuel sale. Max allowed for this date: ${maxAllowed.toFixed(2)} liters.` });
        }

        // 1) Insert customer_credit_sales (table column is fuel_type, stores fuel type id)
        const vehicleColumn = await resolveCreditSaleVehicleColumn();
        let vehicleValue = null;
        if (vehicleColumn === 'vehicle_id') {
            vehicleValue = vehicle_id != null ? Number(vehicle_id) : null;
        } else if (vehicleColumn === 'vehicle_number') {
            if (vehicle_number) {
                vehicleValue = vehicle_number;
            } else if (vehicle_id != null) {
                const vehicleTable = await resolveVehicleTable();
                const [vehRows] = await run(
                    `SELECT vehicle_number FROM ${vehicleTable} WHERE vehicle_id = ? AND Active = 1 LIMIT 1`,
                    [vehicle_id]
                );
                vehicleValue = vehRows.length > 0 ? vehRows[0].vehicle_number : null;
            }
        }

        let insertSaleQuery = `
            INSERT INTO customer_credit_sales (
                customer_id, station_id, fuel_type, sale_date, quantity, rate, amount, is_settled,
                CB, MB, CD, MD, Active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NOW(), NOW(), 1)
        `;
        let insertParams = [customer_id, station_id, fuel_type_id, sale_date, qty, effectiveRate, amt, CB, CB];
        if (vehicleColumn) {
            insertSaleQuery = `
                INSERT INTO customer_credit_sales (
                    customer_id, station_id, fuel_type, sale_date, quantity, rate, amount, is_settled,
                    ${vehicleColumn}, CB, MB, CD, MD, Active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NOW(), NOW(), 1)
            `;
            insertParams = [customer_id, station_id, fuel_type_id, sale_date, qty, effectiveRate, amt, vehicleValue, CB, CB];
        }
        const [saleResult] = await run(insertSaleQuery, insertParams);
        const creditSaleId = saleResult.insertId;

        // 2) Get last balance for customer_ledger
        const [lastLedger] = await run(
            `SELECT balance FROM customer_ledger 
             WHERE customer_id = ? AND Active = 1 
             ORDER BY id DESC LIMIT 1`,
            [customer_id]
        );
        const prevBalance = lastLedger.length > 0 ? parseFloat(lastLedger[0].balance) || 0 : 0;
        const newBalance = prevBalance + amt;

        // 3) Insert customer_ledger (debit)
        const ledgerInsert = `
            INSERT INTO customer_ledger (customer_id, ref_type, debit, credit, balance, CB, MB, CD, MD, Active)
            VALUES (?, 'credit_sale', ?, 0, ?, ?, ?, NOW(), NOW(), 1)
        `;
        await run(ledgerInsert, [customer_id, amt, newBalance, CB, CB]);

        // 4) Update daily_sales_summary: add to credit_sale, subtract from cash_sale for this date/station/fuel
        const summaryId = summaryRows[0].id;
        const currentCreditSale = parseFloat(summaryRows[0].credit_sale) || 0;
        const currentCashSale = parseFloat(summaryRows[0].cash_sale) || 0;
        const newCashSale = Math.max(0, currentCashSale - amt);
        await run(
            `UPDATE daily_sales_summary SET credit_sale = ?, cash_sale = ?, MB = ?, MD = NOW() WHERE id = ?`,
            [currentCreditSale + amt, newCashSale, CB, summaryId]
        );

        if (useTransaction) await connection.commit();
        if (connection) connection.release();

        res.json({
            message: 'Credit sale added successfully',
            id: creditSaleId
        });
    } catch (err) {
        if (useTransaction && connection) {
            try { await connection.rollback(); } catch (_) { }
            connection.release();
        }
        console.error('Error adding customer credit sale:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get ledger for a customer
exports.getCustomerLedger = async (req, res) => {
    try {
        const customerId = req.query.customer_id;
        if (!customerId) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }
        const query = `
            SELECT 
                id, customer_id, ref_type, debit, credit, balance, CD, CB
            FROM customer_ledger
            WHERE customer_id = ? AND Active = 1
            ORDER BY id ASC
        `;
        const [rows] = await db.execute(query, [customerId]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching customer ledger:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Add recovery: customer_ledger (credit); station_cash_in_hand or bank account; transactions; fuel_station_customer_recoveries.
// Body: customer_id, amount, recovery_date, received_in ('cash_in_hand'|'bank_account'), purpose, station_id (required for cash), account_id (required for bank).
exports.addCustomerRecovery = async (req, res) => {
    const connection = await (db.getConnection ? db.getConnection() : null);
    const useTransaction = !!connection;
    try {
        const { customer_id, amount, recovery_date, received_in, purpose, station_id, account_id } = req.body;
        if (!customer_id || amount == null || amount === '') {
            return res.status(400).json({ message: 'Customer ID and amount are required' });
        }
        const amt = Math.abs(parseFloat(amount));
        const CB = resolveAuditUser(req);
        const receivedInNorm = (received_in || '').toLowerCase();
        const isCash = receivedInNorm === 'cash_in_hand';
        const isBank = receivedInNorm === 'bank_account';
        const paymentMode = isCash ? 'Cash' : isBank ? 'Bank' : (received_in || null);

        if (isCash && !station_id) {
            return res.status(400).json({ message: 'Station ID is required when receiving in Cash in Hand' });
        }
        if (isBank && !account_id) {
            return res.status(400).json({ message: 'Account is required when receiving in Bank Account' });
        }

        const run = connection ? connection.execute.bind(connection) : db.execute.bind(db);

        // Auto-heal schema before inserts to avoid production failures.
        await ensureRecoverySchema(run);

        if (useTransaction) await connection.beginTransaction();

        // 1) Customer ledger
        const [lastLedger] = await run(
            `SELECT balance FROM customer_ledger WHERE customer_id = ? AND Active = 1 ORDER BY id DESC LIMIT 1`,
            [customer_id]
        );
        const prevBalance = lastLedger.length > 0 ? parseFloat(lastLedger[0].balance) || 0 : 0;
        const newBalance = prevBalance + amt;
        await run(
            `INSERT INTO customer_ledger (customer_id, ref_type, debit, credit, balance, received_in, purpose, CB, MB, CD, MD, Active)
             VALUES (?, 'recovery', 0, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
            [customer_id, amt, newBalance, received_in || null, purpose || null, CB, CB]
        );

        let transactionId = null;
        const recDate = recovery_date ? (recovery_date.split('T')[0] || recovery_date) : new Date().toISOString().split('T')[0];
        const purposeText = (purpose || 'Fuel station customer recovery').substring(0, 500);

        if (isCash) {
            // 2a) station_cash_in_hand: customer_id must reference fuel_station_customer.customer_id
            const [lastCash] = await run(
                `SELECT balance FROM station_cash_in_hand WHERE customer_id = ? AND (active = 1 OR active IS NULL) ORDER BY id DESC LIMIT 1`,
                [customer_id]
            );
            const prevCashBalance = lastCash.length > 0 ? parseFloat(lastCash[0].balance) || 0 : 0;
            const newCashBalance = prevCashBalance + amt;
            await run(
                `INSERT INTO station_cash_in_hand (customer_id, ref_type, received_in, debit, credit, balance, purpose, entry_date, CB, CD, MD, MB, active)
                 VALUES (?, 'RECOVERY', ?, 0, ?, ?, ?, ?, ?, NOW(), NOW(), ?, 1)`,
                [customer_id, received_in || null, amt, newCashBalance, purposeText, recDate, CB, CB]
            );
            // 3a) transactions (audit; AccountID may be NULL for station cash)
            const [txResult] = await run(
                `INSERT INTO transactions (AccountID, Purpose, Debit, Credit, Date, active) VALUES (NULL, ?, 0, ?, ?, 1)`,
                [purposeText, amt, recDate]
            );
            transactionId = (txResult && txResult.insertId != null) ? txResult.insertId : null;
        }

        if (isBank) {
            // 2b) Update account balance and insert transaction
            const [accRows] = await run(`SELECT ID, Balance FROM accounts WHERE ID = ? AND active = 1`, [account_id]);
            if (!accRows || accRows.length === 0) {
                if (useTransaction) await connection.rollback();
                if (connection) connection.release();
                return res.status(400).json({ message: 'Invalid or inactive account' });
            }
            const newAccBalance = (parseFloat(accRows[0].Balance) || 0) + amt;
            await run(`UPDATE accounts SET Balance = ?, MD = NOW(), MB = ? WHERE ID = ?`, [newAccBalance, CB, account_id]);
            const [txResult] = await run(
                `INSERT INTO transactions (AccountID, Purpose, Debit, Credit, Date, active) VALUES (?, ?, 0, ?, ?, 1)`,
                [account_id, purposeText, amt, recDate]
            );
            transactionId = (txResult && txResult.insertId != null) ? txResult.insertId : null;
        }

        // 4) fuel_station_customer_recoveries (columns: customer_id, station_id, transactionID, fuel_type, recovery_date, amount, payment_mode, reference, CB, MB, CD, MD, Active)
        await run(
            `INSERT INTO fuel_station_customer_recoveries (customer_id, station_id, transactionID, recovery_date, amount, payment_mode, reference, CB, MB, CD, MD, Active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
            [customer_id, station_id || null, transactionId, recDate, amt, paymentMode, purposeText || null, CB, CB]
        );

        // 5) FIFO Payment Allocation: Apply recovery amount to oldest credit sales
        let remainingPayment = amt;
        const [creditSales] = await run(
            `SELECT id, daily_entry_id, total_amount, paid_amount, remaining_amount 
             FROM credit_sales 
             WHERE fuel_station_customer_id = ? AND Active = 1 AND remaining_amount > 0
             ORDER BY cd ASC, id ASC`,
            [customer_id]
        );

        // Track recovery amounts per daily_entry_id
        const recoveryByDailyEntry = {};

        for (const sale of creditSales) {
            if (remainingPayment <= 0) break;

            const currentRemaining = parseFloat(sale.remaining_amount) || 0;
            const currentPaid = parseFloat(sale.paid_amount) || 0;

            // Apply payment to this sale
            const paymentToApply = Math.min(remainingPayment, currentRemaining);
            const newPaidAmount = currentPaid + paymentToApply;
            const newRemainingAmount = currentRemaining - paymentToApply;

            await run(
                `UPDATE credit_sales 
                 SET paid_amount = ?, 
                     remaining_amount = ?,
                     payment_status = CASE WHEN ? = 0 THEN 'paid' ELSE payment_status END,
                     MD = NOW(),
                     MB = ?
                 WHERE id = ?`,
                [newPaidAmount, newRemainingAmount, newRemainingAmount, CB, sale.id]
            );

            // Track recovery amount for this daily_entry_id
            if (sale.daily_entry_id) {
                recoveryByDailyEntry[sale.daily_entry_id] = (recoveryByDailyEntry[sale.daily_entry_id] || 0) + paymentToApply;
            }

            remainingPayment -= paymentToApply;
        }

        // 5a) Update cash_management.cash_from_recovery for affected daily entries
        for (const dailyEntryId in recoveryByDailyEntry) {
            const recoveryAmount = recoveryByDailyEntry[dailyEntryId];
            await run(
                `UPDATE cash_management 
                 SET cash_from_recovery = COALESCE(cash_from_recovery, 0) + ?,
                     MD = NOW(),
                     MB = ?
                 WHERE daily_entry_id = ?`,
                [recoveryAmount, CB, dailyEntryId]
            );
        }

        if (useTransaction) await connection.commit();
        if (connection) connection.release();
        res.json({ message: 'Recovery recorded successfully', transaction_id: transactionId });
    } catch (err) {
        if (useTransaction && connection) {
            try { await connection.rollback(); } catch (_) { }
            connection.release();
        }
        console.error('Error adding customer recovery:', err);
        if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({
                message: 'Database schema issue. Ensure customer_ledger has received_in, purpose; tables station_cash_in_hand and fuel_station_customer_recoveries exist.',
                error: err.message
            });
        }
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};
