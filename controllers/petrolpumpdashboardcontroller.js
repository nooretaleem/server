const db = require('../models/db');

const LOW_STOCK_THRESHOLD_L = 5000;

/** Get local date as YYYY-MM-DD (matches daily_sales_entries.entry_date format). */
function getLocalDateStr(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

exports.getPetrolPumpDashboard = async (req, res) => {
    try {
        const today = getLocalDateStr();
        const y = new Date().getFullYear();
        const m = String(new Date().getMonth() + 1).padStart(2, '0');
        const monthStart = `${y}-${m}-01`;

        // Tables aligned with dailysalesentrycontroller: petrol_pumps, daily_sales_entries, nozzle_readings, etc.
        const [pumpRows] = await db.execute(
            `SELECT COUNT(*) as cnt FROM petrol_pumps WHERE Active = 1`
        );
        const totalPumps = (pumpRows && pumpRows[0] && pumpRows[0].cnt) || 0;

        // Month/today sales from nozzle_readings + daily_sales_entries (same as getPumpDashboardData)
        const [[monthRows], [todayRows]] = await Promise.all([
            db.execute(
                `SELECT COALESCE(SUM(nr.sales_amount), 0) as total
                 FROM nozzle_readings nr
                 INNER JOIN daily_sales_entries dse ON nr.daily_entry_id = dse.id
                 WHERE dse.Active = 1 AND DATE(dse.entry_date) >= ? AND DATE(dse.entry_date) <= LAST_DAY(?) AND nr.Active = 1`,
                [monthStart, monthStart]
            ),
            db.execute(
                `SELECT COALESCE(SUM(nr.sales_amount), 0) as total
                 FROM nozzle_readings nr
                 INNER JOIN daily_sales_entries dse ON nr.daily_entry_id = dse.id
                 WHERE dse.Active = 1 AND DATE(dse.entry_date) = ? AND nr.Active = 1`,
                [today]
            )
        ]);
        const totalFuelSalesMonth = (monthRows && monthRows[0] && parseFloat(monthRows[0].total)) || 0;
        const todayFuelSales = (todayRows && todayRows[0] && parseFloat(todayRows[0].total)) || 0;

        // Inventory from fuel_tanks (per-pump tanks; same schema as getPumpDashboardData / pumps)
        const [tankRows] = await db.execute(
            `SELECT fuel_type, SUM(current_level) as current_level, SUM(capacity) as capacity
             FROM fuel_tanks
             WHERE Active = 1
             GROUP BY fuel_type`
        );
        const inventory = [];
        let lowStockCount = 0;
        for (const row of tankRows || []) {
            const fuel_type_name = row.fuel_type || 'N/A';
            const stock_liters = Math.round(parseFloat(row.current_level) || 0);
            const capacity = parseFloat(row.capacity) || 0;
            const pct = capacity > 0 ? Math.round((stock_liters / capacity) * 100) : null;
            inventory.push({ fuel_type_name, stock_liters, pct });
            if (stock_liters < LOW_STOCK_THRESHOLD_L) lowStockCount++;
        }

        res.json({
            totalPumps,
            totalFuelSalesMonth,
            todayFuelSales,
            lowStockCount,
            inventory
        });
    } catch (err) {
        console.error('Error getPetrolPumpDashboard:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({ totalPumps: 0, totalFuelSalesMonth: 0, todayFuelSales: 0, lowStockCount: 0, inventory: [] });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

/** Get date range [dateFrom, dateTo] for period (daily, weekly, monthly, yearly). */
function getDateRangeForPeriod(period, todayStr = getLocalDateStr()) {
    const now = new Date();
    const today = todayStr || getLocalDateStr(now);
    const p = (period || 'daily').toLowerCase();
    if (p === 'daily') return { dateFrom: today, dateTo: today };
    if (p === 'weekly') {
        const d = new Date(now);
        d.setDate(d.getDate() - 6);
        return { dateFrom: getLocalDateStr(d), dateTo: today };
    }
    if (p === 'monthly') {
        const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
        return { dateFrom: `${y}-${m}-01`, dateTo: today };
    }
    if (p === 'yearly') {
        const y = now.getFullYear();
        return { dateFrom: `${y}-01-01`, dateTo: today };
    }
    return { dateFrom: today, dateTo: today };
}

exports.getPumpDashboardData = async (req, res) => {
    try {
        const pumpId = req.query.pump_id;
        const minimal = req.query.minimal === '1' || req.query.minimal === 'true';
        const period = (req.query.period || 'daily').toLowerCase();
        if (!pumpId) {
            return res.status(400).json({ message: 'pump_id is required' });
        }

        const today = getLocalDateStr();
        const { dateFrom, dateTo } = getDateRangeForPeriod(period, today);

        // Get today's entry first (DATE() so DATETIME column compares correctly)
        let [todayEntry] = await db.execute(
            `SELECT id, entry_date FROM daily_sales_entries WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 LIMIT 1`,
            [pumpId, today]
        );

        let todayEntryId = todayEntry && todayEntry[0] ? todayEntry[0].id : null;
        let entryDateUsed = today;

        // Fallback: if no entry for today, use the latest entry for this pump
        if (!todayEntryId) {
            const [latestEntry] = await db.execute(
                `SELECT id, entry_date FROM daily_sales_entries WHERE pump_id = ? AND Active = 1 ORDER BY entry_date DESC LIMIT 1`,
                [pumpId]
            );
            if (latestEntry && latestEntry[0]) {
                todayEntryId = latestEntry[0].id;
                const d = latestEntry[0].entry_date;
                entryDateUsed = d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10)) : today;
            }
        }

        // Minimal mode: only Today's Sales + Cash Sales (2 cards) - 3 queries in parallel
        if (minimal) {
            const [salesAndLitersResult, creditSalesResult, mobileOilResult] = await Promise.all([
                todayEntryId ? db.execute(
                    `SELECT 
                        SUM(nr.sales_amount) as total_sales,
                        SUM(CASE WHEN LOWER(n.nozzle_type) LIKE '%petrol%' THEN nr.sales_amount ELSE 0 END) as petrol_sales,
                        SUM(CASE WHEN LOWER(n.nozzle_type) LIKE '%diesel%' THEN nr.sales_amount ELSE 0 END) as diesel_sales,
                        SUM(CASE WHEN LOWER(n.nozzle_type) LIKE '%petrol%' THEN nr.total_sold ELSE 0 END) as petrol_liters,
                        SUM(CASE WHEN LOWER(n.nozzle_type) LIKE '%diesel%' THEN nr.total_sold ELSE 0 END) as diesel_liters
                    FROM nozzle_readings nr
                    JOIN nozzles n ON nr.nozzle_id = n.id
                    JOIN machines m ON n.machine_id = m.id
                    WHERE nr.daily_entry_id = ? AND nr.Active = 1`,
                    [todayEntryId]
                ) : Promise.resolve([[]]),
                todayEntryId ? db.execute(
                    `SELECT COALESCE(SUM(total_amount), 0) as total FROM credit_sales 
                    WHERE daily_entry_id = ? AND Active = 1`,
                    [todayEntryId]
                ) : Promise.resolve([[{ total: 0 }]]),
                todayEntryId ? db.execute(
                    `SELECT COALESCE(SUM(total_amount), 0) as total_amount, COALESCE(SUM(liters_sold), 0) as liters_sold
                    FROM mobile_oil_cash_sales WHERE daily_entry_id = ? AND Active = 1`,
                    [todayEntryId]
                ) : Promise.resolve([[{ total_amount: 0, liters_sold: 0 }]])
            ]);
            const salesData = salesAndLitersResult[0] && salesAndLitersResult[0][0] ? salesAndLitersResult[0][0] : {};
            const fuelTotal = parseFloat(salesData.total_sales) || 0;
            const mobileOilRow = mobileOilResult[0] && mobileOilResult[0][0] ? mobileOilResult[0][0] : {};
            const mobileOilSales = parseFloat(mobileOilRow.total_amount) || 0;
            const mobileOilLiters = parseFloat(mobileOilRow.liters_sold) || 0;
            const todayTotalSales = fuelTotal + mobileOilSales;
            const petrolLiters = parseFloat(salesData.petrol_liters) || 0;
            const dieselLiters = parseFloat(salesData.diesel_liters) || 0;
            const creditSales = (creditSalesResult[0] && creditSalesResult[0][0] && parseFloat(creditSalesResult[0][0].total)) || 0;
            const cashSales = todayTotalSales - creditSales;
            const nrMinimal = todayEntryId ? (await db.execute(
                `SELECT nozzle_id, opening_digital_reading, closing_digital_reading, opening_mechanical_reading, closing_mechanical_reading FROM nozzle_readings WHERE daily_entry_id = ? AND Active = 1`,
                [todayEntryId]
            ))[0] || [] : [];
            const parseNum = (v) => (v != null ? parseFloat(v) : null);
            const nozzleReadingsMinimal = (nrMinimal || []).map(row => {
                const od = parseNum(row.opening_digital_reading);
                const cd = parseNum(row.closing_digital_reading);
                const om = parseNum(row.opening_mechanical_reading);
                const cm = parseNum(row.closing_mechanical_reading);
                return {
                    nozzle_id: row.nozzle_id,
                    opening_reading: od ?? om ?? 0,
                    closing_reading: cd ?? cm ?? 0,
                    opening_digital_reading: od,
                    closing_digital_reading: cd,
                    opening_mechanical_reading: om,
                    closing_mechanical_reading: cm
                };
            });
            return res.json({
                entryDateUsed,
                nozzleReadings: nozzleReadingsMinimal,
                todayTotalSales: Math.round(todayTotalSales * 100) / 100,
                petrolSales: 0,
                dieselSales: 0,
                petrolLiters: Math.round(petrolLiters * 100) / 100,
                dieselLiters: Math.round(dieselLiters * 100) / 100,
                mobileOilSales: Math.round(mobileOilSales * 100) / 100,
                mobileOilLiters: Math.round(mobileOilLiters * 100) / 100,
                cashSales: Math.round(cashSales * 100) / 100,
                creditSales: Math.round(creditSales * 100) / 100,
                bankTransfers: 0,
                cashOutflowNet: 0,
                cashOutflowOwner: 0,
                totalExpenses: 0,
                previousDayCash: 0,
                cashInHand: 0,
                outstandingDues: 0,
                staffSalary: 0,
                fuelStock: [],
                salesByFuelType: [],
                weeklyTrend: []
            });
        }

        // Full mode: use date range for period (daily = single day; weekly/monthly/yearly = aggregate)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = getLocalDateStr(sevenDaysAgo);

        // Execute all independent queries in parallel for better performance
        const [
            salesAndLitersResult,
            mobileOilResult,
            creditSalesResult,
            bankTransfersResult,
            cashOutflowNetResult,
            cashOutflowOwnerResult,
            expensesResult,
            cashInHandResult,
            outstandingDuesResult,
            outstandingDuesCountResult,
            outstandingDuesListResult,
            dailyExpensesBreakdownResult,
            dailyExpensesDetailResult,
            fuelStockResult,
            salesByFuelTypeResult,
            weeklyTrendResult,
            nozzleReadingsResult,
            staffSalaryResult
        ] = await Promise.all([
            // Combined sales and liters over date range (dse in range)
            db.execute(
                `SELECT 
                    COALESCE(SUM(nr.sales_amount), 0) as total_sales,
                    COALESCE(SUM(CASE WHEN LOWER(n.nozzle_type) LIKE '%petrol%' THEN nr.sales_amount ELSE 0 END), 0) as petrol_sales,
                    COALESCE(SUM(CASE WHEN LOWER(n.nozzle_type) LIKE '%diesel%' THEN nr.sales_amount ELSE 0 END), 0) as diesel_sales,
                    COALESCE(SUM(CASE WHEN LOWER(n.nozzle_type) LIKE '%petrol%' THEN nr.total_sold ELSE 0 END), 0) as petrol_liters,
                    COALESCE(SUM(CASE WHEN LOWER(n.nozzle_type) LIKE '%diesel%' THEN nr.total_sold ELSE 0 END), 0) as diesel_liters
                FROM nozzle_readings nr
                JOIN nozzles n ON nr.nozzle_id = n.id
                JOIN machines m ON n.machine_id = m.id
                INNER JOIN daily_sales_entries dse ON nr.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND nr.Active = 1`,
                [pumpId, dateFrom, dateTo]
            ),

            // Mobile oil sales over date range
            db.execute(
                `SELECT COALESCE(SUM(mo.total_amount), 0) as total_amount, COALESCE(SUM(mo.liters_sold), 0) as liters_sold
                FROM mobile_oil_cash_sales mo
                INNER JOIN daily_sales_entries dse ON mo.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND mo.Active = 1`,
                [pumpId, dateFrom, dateTo]
            ),

            // Credit sales over date range
            db.execute(
                `SELECT COALESCE(SUM(cs.total_amount), 0) as total FROM credit_sales cs
                INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND cs.Active = 1`,
                [pumpId, dateFrom, dateTo]
            ),

            // Bank transfers over date range (from cash_outflow_bank table)
            db.execute(
                `SELECT COALESCE(SUM(cob.amount), 0) as total FROM cash_outflow_bank cob
                INNER JOIN cash_management cm ON cob.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),
            // Cash outflow Net over date range (from cash_outflow_net table)
            db.execute(
                `SELECT COALESCE(SUM(con.amount), 0) as total FROM cash_outflow_net con
                INNER JOIN cash_management cm ON con.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),
            // Cash outflow Owner over date range (from cash_outflow_owner table)
            db.execute(
                `SELECT COALESCE(SUM(coo.amount), 0) as total FROM cash_outflow_owner coo
                INNER JOIN cash_management cm ON coo.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),

            // Expenses over date range
            db.execute(
                `SELECT COALESCE(SUM(de.amount), 0) as total FROM daily_expenses de
                INNER JOIN daily_sales_entries dse ON de.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),

            // Cash in hand and previous day cash: latest entry in range (most recent day)
            db.execute(
                `SELECT cm.final_cash_in_hand, cm.cash_from_previous_day FROM cash_management cm
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?
                ORDER BY dse.entry_date DESC LIMIT 1`,
                [pumpId, dateFrom, dateTo]
            ),

            // Outstanding dues - optimized query
            db.execute(
                `SELECT COALESCE(SUM(cs.remaining_amount), 0) as total 
                FROM credit_sales cs
                INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id
                WHERE dse.pump_id = ? AND cs.payment_status != 'paid' AND cs.Active = 1 AND dse.Active = 1 AND cs.remaining_amount > 0`,
                [pumpId]
            ),
            // Outstanding dues count (customers pending)
            db.execute(
                `SELECT COUNT(DISTINCT cs.fuel_station_customer_id) as cnt FROM credit_sales cs
                INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id
                WHERE dse.pump_id = ? AND cs.payment_status != 'paid' AND cs.Active = 1 AND dse.Active = 1 AND cs.remaining_amount > 0`,
                [pumpId]
            ),
            // Outstanding dues list (per customer)
            db.execute(
                `SELECT cs.fuel_station_customer_id as customerId,
                 COALESCE(MAX(fsc.customer_name), CONCAT('Customer #', COALESCE(cs.fuel_station_customer_id, 0))) as customer_name,
                 SUM(cs.remaining_amount) as remaining_amount,
                 MIN(DATE(cs.cd)) as due_since,
                 MAX(cs.paid_amount) as last_payment,
                 COALESCE(cl.last_credit, 0) as recovery_last_amount,
                 cl.last_credit_date as recovery_date
                FROM credit_sales cs
                LEFT JOIN fuel_station_customer fsc ON cs.fuel_station_customer_id = fsc.customer_id AND fsc.Active = 1
                INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                LEFT JOIN (
                  SELECT cl1.customer_id, cl1.credit as last_credit, DATE(cl1.CD) as last_credit_date
                  FROM customer_ledger cl1
                  INNER JOIN (
                    SELECT customer_id, MAX(id) as max_id
                    FROM customer_ledger
                    WHERE Active = 1 AND credit > 0
                    GROUP BY customer_id
                  ) cl2 ON cl1.customer_id = cl2.customer_id AND cl1.id = cl2.max_id
                  WHERE cl1.Active = 1
                ) cl ON cs.fuel_station_customer_id = cl.customer_id
                WHERE dse.pump_id = ? AND cs.payment_status != 'paid' AND cs.Active = 1 AND cs.remaining_amount > 0
                GROUP BY cs.fuel_station_customer_id
                ORDER BY remaining_amount DESC
                LIMIT 15`,
                [pumpId]
            ),
            // Daily expenses breakdown by category (with category name from expense_categories)
            db.execute(
                `SELECT COALESCE(ec.name, 'Other') as expense_category_name, SUM(de.amount) as amount
                FROM daily_expenses de
                INNER JOIN daily_sales_entries dse ON de.daily_entry_id = dse.id AND dse.Active = 1
                LEFT JOIN expense_categories ec ON de.expense_category = ec.id
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?
                GROUP BY de.expense_category, ec.name
                ORDER BY amount DESC`,
                [pumpId, dateFrom, dateTo]
            ),
            // Daily expenses detail (each row with category name from expense_categories)
            db.execute(
                `SELECT COALESCE(ec.name, 'Other') as expense_category_name, de.amount, de.description, DATE(dse.entry_date) as entry_date
                FROM daily_expenses de
                INNER JOIN daily_sales_entries dse ON de.daily_entry_id = dse.id AND dse.Active = 1
                LEFT JOIN expense_categories ec ON de.expense_category = ec.id
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?
                ORDER BY dse.entry_date DESC, de.id DESC`,
                [pumpId, dateFrom, dateTo]
            ),

            // Fuel stock
            db.execute(
                `SELECT 
                    fuel_type,
                    SUM(current_level) as current_level,
                    SUM(capacity) as capacity
                FROM fuel_tanks
                WHERE pump_id = ? AND Active = 1
                GROUP BY fuel_type`,
                [pumpId]
            ),

            // Sales by fuel type (last 7 days)
            db.execute(
                `SELECT 
                    n.nozzle_type as fuel_type,
                    SUM(nr.sales_amount) as total_sales
                FROM nozzle_readings nr
                INNER JOIN nozzles n ON nr.nozzle_id = n.id
                INNER JOIN machines m ON n.machine_id = m.id
                INNER JOIN daily_sales_entries dse ON nr.daily_entry_id = dse.id
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) >= ? AND DATE(dse.entry_date) <= ? 
                AND nr.Active = 1 AND dse.Active = 1
                GROUP BY n.nozzle_type`,
                [pumpId, sevenDaysAgoStr, today]
            ),

            // Weekly trend (last 7 days) - optimized
            db.execute(
                `SELECT 
                    DATE(dse.entry_date) as entry_date,
                    COALESCE(SUM(nr.sales_amount), 0) as daily_sales
                FROM daily_sales_entries dse
                LEFT JOIN nozzle_readings nr ON dse.id = nr.daily_entry_id AND nr.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) >= ? AND DATE(dse.entry_date) <= ? 
                AND dse.Active = 1
                GROUP BY DATE(dse.entry_date)
                ORDER BY DATE(dse.entry_date) ASC`,
                [pumpId, sevenDaysAgoStr, today]
            ),
            // Nozzle readings from resolved entry (today if exists, otherwise latest entry for pump)
            todayEntryId
                ? db.execute(
                    `SELECT nozzle_id, opening_digital_reading, closing_digital_reading, opening_mechanical_reading, closing_mechanical_reading
                     FROM nozzle_readings nr
                     WHERE nr.daily_entry_id = ? AND nr.Active = 1`,
                    [todayEntryId]
                )
                : Promise.resolve([[]]),

            // Staff salary paid (sum of credit from staff_advance_salary) over date range
            db.execute(
                `SELECT COALESCE(SUM(sas.credit), 0) as total
                 FROM staff_advance_salary sas
                 INNER JOIN staff s ON sas.staff_id = s.id
                 WHERE s.pump_id = ? AND DATE(sas.cd) BETWEEN ? AND ? AND sas.Active = 1 AND s.Active = 1`,
                [pumpId, dateFrom, dateTo]
            )
        ]);

        // Process results
        const salesData = salesAndLitersResult[0] && salesAndLitersResult[0][0] ? salesAndLitersResult[0][0] : {};
        const fuelTotal = parseFloat(salesData.total_sales) || 0;
        const mobileOilRow = mobileOilResult[0] && mobileOilResult[0][0] ? mobileOilResult[0][0] : {};
        const mobileOilSales = parseFloat(mobileOilRow.total_amount) || 0;
        const mobileOilLiters = parseFloat(mobileOilRow.liters_sold) || 0;
        const todayTotalSales = fuelTotal + mobileOilSales;
        const petrolSales = parseFloat(salesData.petrol_sales) || 0;
        const dieselSales = parseFloat(salesData.diesel_sales) || 0;
        const petrolLiters = parseFloat(salesData.petrol_liters) || 0;
        const dieselLiters = parseFloat(salesData.diesel_liters) || 0;

        const creditSales = (creditSalesResult[0] && creditSalesResult[0][0] && parseFloat(creditSalesResult[0][0].total)) || 0;
        const bankTransfers = (bankTransfersResult[0] && bankTransfersResult[0][0] && parseFloat(bankTransfersResult[0][0].total)) || 0;
        const cashOutflowNet = (cashOutflowNetResult[0] && cashOutflowNetResult[0][0] && parseFloat(cashOutflowNetResult[0][0].total)) || 0;
        const cashOutflowOwner = (cashOutflowOwnerResult[0] && cashOutflowOwnerResult[0][0] && parseFloat(cashOutflowOwnerResult[0][0].total)) || 0;
        const cashSales = todayTotalSales - creditSales;
        const totalExpenses = (expensesResult[0] && expensesResult[0][0] && parseFloat(expensesResult[0][0].total)) || 0;
        const cashInHandRow = cashInHandResult[0] && cashInHandResult[0][0] ? cashInHandResult[0][0] : {};
        const cashInHand = parseFloat(cashInHandRow.final_cash_in_hand) || 0;
        const previousDayCash = parseFloat(cashInHandRow.cash_from_previous_day) || 0;
        const outstandingDues = (outstandingDuesResult[0] && outstandingDuesResult[0][0] && parseFloat(outstandingDuesResult[0][0].total)) || 0;
        const outstandingDuesCount = (outstandingDuesCountResult[0] && outstandingDuesCountResult[0][0] && parseInt(outstandingDuesCountResult[0][0].cnt, 10)) || 0;
        const outstandingDuesList = (outstandingDuesListResult[0] || []).map(row => ({
            customerId: row.customerId,
            customer_name: row.customer_name || 'Unknown',
            remaining_amount: parseFloat(row.remaining_amount) || 0,
            due_since: row.due_since,
            last_payment: parseFloat(row.last_payment) || 0,
            recovery_last_amount: parseFloat(row.recovery_last_amount) || 0,
            recovery_date: row.recovery_date
        }));
        const dailyExpensesBreakdown = (dailyExpensesBreakdownResult[0] || []).map(row => ({
            expense_category: row.expense_category_name || 'Other',
            amount: parseFloat(row.amount) || 0
        }));
        const dailyExpensesDetail = (dailyExpensesDetailResult[0] || []).map(row => ({
            expense_category: row.expense_category_name != null ? String(row.expense_category_name) : 'Other',
            amount: parseFloat(row.amount) || 0,
            description: row.description != null && String(row.description).trim() !== '' ? String(row.description).trim() : null,
            entry_date: row.entry_date
        }));
        const staffSalary = (staffSalaryResult[0] && staffSalaryResult[0][0] && parseFloat(staffSalaryResult[0][0].total)) || 0;

        const fuelStock = (fuelStockResult[0] || []).map(row => ({
            fuel_type: row.fuel_type || 'N/A',
            current_level: parseFloat(row.current_level) || 0,
            capacity: parseFloat(row.capacity) || 0
        }));

        const salesByFuelType = (salesByFuelTypeResult[0] || []).map(row => ({
            fuel_type: row.fuel_type || 'N/A',
            total_sales: parseFloat(row.total_sales) || 0
        }));

        const weeklyTrend = (weeklyTrendResult[0] || []).map(row => ({
            date: row.entry_date,
            sales: parseFloat(row.daily_sales) || 0
        }));

        const parseNr = (v) => (v != null ? parseFloat(v) : null);
        const nozzleReadings = (nozzleReadingsResult[0] || []).map(row => {
            const od = parseNr(row.opening_digital_reading);
            const cd = parseNr(row.closing_digital_reading);
            const om = parseNr(row.opening_mechanical_reading);
            const cm = parseNr(row.closing_mechanical_reading);
            return {
                nozzle_id: row.nozzle_id,
                opening_reading: od ?? om ?? 0,
                closing_reading: cd ?? cm ?? 0,
                opening_digital_reading: od,
                closing_digital_reading: cd,
                opening_mechanical_reading: om,
                closing_mechanical_reading: cm
            };
        });

        res.json({
            period: period,
            dateFrom,
            dateTo,
            entryDateUsed,
            nozzleReadings,
            todayTotalSales: Math.round(todayTotalSales * 100) / 100,
            petrolSales: Math.round(petrolSales * 100) / 100,
            dieselSales: Math.round(dieselSales * 100) / 100,
            petrolLiters: Math.round(petrolLiters * 100) / 100,
            dieselLiters: Math.round(dieselLiters * 100) / 100,
            mobileOilSales: Math.round(mobileOilSales * 100) / 100,
            mobileOilLiters: Math.round(mobileOilLiters * 100) / 100,
            cashSales: Math.round(cashSales * 100) / 100,
            creditSales: Math.round(creditSales * 100) / 100,
            bankTransfers: Math.round(bankTransfers * 100) / 100,
            cashOutflowNet: Math.round(cashOutflowNet * 100) / 100,
            cashOutflowOwner: Math.round(cashOutflowOwner * 100) / 100,
            totalExpenses: Math.round(totalExpenses * 100) / 100,
            previousDayCash: Math.round(previousDayCash * 100) / 100,
            cashInHand: Math.round(cashInHand * 100) / 100,
            outstandingDues: Math.round(outstandingDues * 100) / 100,
            outstandingDuesCount,
            outstandingDuesList,
            dailyExpensesBreakdown,
            dailyExpensesDetail,
            staffSalary: Math.round(staffSalary * 100) / 100,
            fuelStock,
            salesByFuelType,
            weeklyTrend
        });
    } catch (err) {
        console.error('Error getPumpDashboardData:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json({
                nozzleReadings: [],
                todayTotalSales: 0,
                petrolSales: 0,
                dieselSales: 0,
                petrolLiters: 0,
                dieselLiters: 0,
                mobileOilSales: 0,
                mobileOilLiters: 0,
                cashSales: 0,
                creditSales: 0,
                bankTransfers: 0,
                cashOutflowNet: 0,
                cashOutflowOwner: 0,
                totalExpenses: 0,
                previousDayCash: 0,
                cashInHand: 0,
                outstandingDues: 0,
                outstandingDuesCount: 0,
                outstandingDuesList: [],
                dailyExpensesBreakdown: [],
                dailyExpensesDetail: [],
                staffSalary: 0,
                fuelStock: [],
                salesByFuelType: [],
                weeklyTrend: []
            });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};
