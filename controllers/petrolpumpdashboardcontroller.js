const db = require('../models/db');

const LOW_STOCK_THRESHOLD_L = 5000;

/** Get local date as YYYY-MM-DD (matches daily_sales_entries.entry_date format). */
function getLocalDateStr(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}



exports.getPetrolPumpDashboard_old = async (req, res) => {
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


exports.getPetrolPumpDashboard = async (req, res) => {
    try {
        // Use a single connection for all queries to improve performance
        const connection = await db.getConnection();

        try {
            // Start transaction for data consistency
            await connection.beginTransaction();

            const today = getLocalDateStr();
            const monthStart = getMonthStartStr();

            // Use prepared statements with parameterized queries
            const [results] = await connection.query(`
                SELECT 
                    -- Total active pumps
                    (SELECT COUNT(*) FROM petrol_pumps WHERE Active = 1) as totalPumps,
                    
                    -- Monthly fuel sales
                    (SELECT COALESCE(SUM(nr.sales_amount), 0) 
                     FROM nozzle_readings nr
                     INNER JOIN daily_sales_entries dse ON nr.daily_entry_id = dse.id
                     WHERE dse.Active = 1 
                       AND dse.entry_date >= ? 
                       AND dse.entry_date < DATE_ADD(LAST_DAY(?), INTERVAL 1 DAY)
                       AND nr.Active = 1) as totalFuelSalesMonth,
                    
                    -- Today's fuel sales
                    (SELECT COALESCE(SUM(nr.sales_amount), 0)
                     FROM nozzle_readings nr
                     INNER JOIN daily_sales_entries dse ON nr.daily_entry_id = dse.id
                     WHERE dse.Active = 1 
                       AND dse.entry_date >= ? 
                       AND dse.entry_date < DATE_ADD(?, INTERVAL 1 DAY)
                       AND nr.Active = 1) as todayFuelSales
            `, [monthStart, monthStart, today, today]);

            // Get inventory data with better handling
            const [inventoryRows] = await connection.query(`
                SELECT 
                    fuel_type, 
                    SUM(current_level) as current_level, 
                    SUM(capacity) as capacity,
                    COUNT(*) as tank_count
                FROM fuel_tanks
                WHERE Active = 1
                GROUP BY fuel_type
                ORDER BY fuel_type
            `);

            // Process inventory with better type safety
            const inventory = [];
            let lowStockCount = 0;

            for (const row of inventoryRows || []) {
                const stockLiters = Math.max(0, Math.round(parseFloat(row.current_level) || 0));
                const capacity = Math.max(0, parseFloat(row.capacity) || 0);

                // Calculate percentage with safer division
                const percentage = capacity > 0
                    ? Math.min(100, Math.round((stockLiters / capacity) * 100))
                    : null;

                // Determine stock status
                let status = 'good';
                if (stockLiters < LOW_STOCK_THRESHOLD_L) {
                    status = 'low';
                    lowStockCount++;
                } else if (stockLiters < LOW_STOCK_THRESHOLD_L * 2) {
                    status = 'medium';
                }

                inventory.push({
                    fuelType: row.fuel_type || 'Unknown',
                    stockLiters,
                    capacity,
                    percentage,
                    status,
                    tankCount: row.tank_count || 1,
                    threshold: LOW_STOCK_THRESHOLD_L
                });
            }

            // Calculate additional metrics
            const totalCapacity = inventory.reduce((sum, item) => sum + (item.capacity || 0), 0);
            const totalStock = inventory.reduce((sum, item) => sum + (item.stockLiters || 0), 0);
            const overallUtilization = totalCapacity > 0
                ? Math.round((totalStock / totalCapacity) * 100)
                : 0;

            // Prepare response with additional useful data
            const responseData = {
                success: true,
                timestamp: new Date().toISOString(),
                data: {
                    totalPumps: parseInt(results[0]?.totalPumps) || 0,
                    totalFuelSalesMonth: parseFloat(results[0]?.totalFuelSalesMonth) || 0,
                    todayFuelSales: parseFloat(results[0]?.todayFuelSales) || 0,
                    lowStockCount,
                    inventory,
                    summary: {
                        totalCapacity,
                        totalStock,
                        overallUtilization,
                        fuelTypes: inventory.length,
                        totalTanks: inventory.reduce((sum, item) => sum + (item.tankCount || 0), 0)
                    }
                }
            };

            // Commit transaction
            await connection.commit();

            // Log successful request (optional)
            logger.info('Dashboard data fetched successfully', {
                totalPumps: responseData.data.totalPumps,
                fuelTypes: inventory.length,
                lowStockCount
            });

            res.json(responseData);

        } catch (error) {
            // Rollback transaction on error
            await connection.rollback();
            throw error;
        } finally {
            // Always release connection back to pool
            connection.release();
        }

    } catch (err) {
        console.error('Error in getPetrolPumpDashboard:', err);

        // Handle specific MySQL errors
        if (err.code === 'ER_NO_SUCH_TABLE') {
            // Return safe default for missing tables
            return res.json({
                success: true,
                timestamp: new Date().toISOString(),
                data: {
                    totalPumps: 0,
                    totalFuelSalesMonth: 0,
                    todayFuelSales: 0,
                    lowStockCount: 0,
                    inventory: [],
                    summary: {
                        totalCapacity: 0,
                        totalStock: 0,
                        overallUtilization: 0,
                        fuelTypes: 0,
                        totalTanks: 0
                    }
                },
                warnings: ['Database tables are not fully configured']
            });
        }

        // Handle connection errors
        if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
            return res.status(503).json({
                success: false,
                message: 'Database service temporarily unavailable',
                error: 'DB_CONNECTION_FAILED'
            });
        }

        // Generic error response
        res.status(500).json({
            success: false,
            message: 'Failed to fetch dashboard data',
            error: process.env.NODE_ENV === 'development' ? err.message : 'INTERNAL_SERVER_ERROR',
            code: err.code || 'UNKNOWN_ERROR'
        });
    }
};

/** Get date range [dateFrom, dateTo] for period (daily, weekly, monthly, yearly), anchored to a selected date. */
function getDateRangeForPeriod(period, anchorDateStr = getLocalDateStr()) {
    const anchorDate = new Date(`${anchorDateStr}T00:00:00`);
    const base = isNaN(anchorDate.getTime()) ? new Date() : anchorDate;
    const today = getLocalDateStr(base);
    const p = (period || 'daily').toLowerCase();
    if (p === 'daily') return { dateFrom: today, dateTo: today };
    if (p === 'weekly') {
        const d = new Date(base);
        d.setDate(d.getDate() - 6);
        return { dateFrom: getLocalDateStr(d), dateTo: today };
    }
    if (p === 'monthly') {
        const y = base.getFullYear(), m = String(base.getMonth() + 1).padStart(2, '0');
        return { dateFrom: `${y}-${m}-01`, dateTo: today };
    }
    if (p === 'yearly') {
        const y = base.getFullYear();
        return { dateFrom: `${y}-01-01`, dateTo: today };
    }
    return { dateFrom: today, dateTo: today };
}

exports.getPumpDashboardData_old = async (req, res) => {

    let connection;
    try {

        connection = await db.getConnection();
        const pumpId = req.query.pump_id;
        const minimal = req.query.minimal === '1' || req.query.minimal === 'true';
        const period = (req.query.period || 'daily').toLowerCase();
        const requestedEntryDate = String(req.query.entry_date || '').trim();
        const hasExplicitDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedEntryDate);

        if (!pumpId) {
            return res.status(400).json({ message: 'pump_id is required' });
        }

        const today = getLocalDateStr();
        const targetDate = hasExplicitDate ? requestedEntryDate : today;
        const { dateFrom, dateTo } = getDateRangeForPeriod(period, targetDate);
        //console.log('Date From ' + dateFrom + 'Date To ' + dateTo)
        //console.log(`getPumpDashboardData: pump_id=${pumpId}, minimal=${minimal}, period=${period}, entry_date=${requestedEntryDate}, hasExplicitDate=${hasExplicitDate}`);
        // Get selected date entry first (DATE() so DATETIME column compares correctly)
        let [todayEntry] = await connection.execute(
            `SELECT id, entry_date FROM daily_sales_entries WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 LIMIT 1`,
            [pumpId, targetDate]
        );

        let todayEntryId = todayEntry && todayEntry[0] ? todayEntry[0].id : null;
        let entryDateUsed = targetDate;

        // Fallback to latest only when no explicit date was requested.
        /* if (!todayEntryId && !hasExplicitDate) {
            const [latestEntry] = await db.execute(
                `SELECT id, entry_date FROM daily_sales_entries WHERE pump_id = ? AND Active = 1 ORDER BY entry_date DESC LIMIT 1`,
                [pumpId]
            );
            if (latestEntry && latestEntry[0]) {
                todayEntryId = latestEntry[0].id;
                const d = latestEntry[0].entry_date;
                entryDateUsed = d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10)) : today;
            }
        } */

        // Minimal mode: only Today's Sales + Cash Sales (2 cards) - 3 queries in parallel
        if (minimal) {
            const [salesAndLitersResult, creditSalesResult, mobileOilResult, unloadNotificationsResult] = await Promise.all([
                todayEntryId ? connection.execute(
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
                todayEntryId ? connection.execute(
                    `SELECT COALESCE(SUM(total_amount), 0) as total FROM credit_sales 
                    WHERE daily_entry_id = ? AND Active = 1`,
                    [todayEntryId]
                ) : Promise.resolve([[{ total: 0 }]]),
                connection.execute(
                    `SELECT
                        COALESCE(SUM(mo.total_amount), 0) as total_amount,
                        COALESCE(SUM(mo.liters_sold), 0) as liters_sold
                     FROM mobile_oil_cash_sales mo
                     WHERE mo.Active = 1
                       AND mo.daily_entry_id IN (
                            SELECT dse.id
                            FROM daily_sales_entries dse
                            WHERE dse.pump_id = ?
                              AND DATE(dse.entry_date) = ?
                              AND dse.Active = 1
                       )`,
                    [pumpId, targetDate]
                ),
                connection.execute(
                    `SELECT
                                                fp.id,
                                                COALESCE(fp.fuel_type, 'Fuel') as fuel_type,
                                                fp.purchase_reference as trip_ref,
                                                GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) as liters_remaining
                                         FROM fuel_purchased fp
                                         LEFT JOIN (
                                                SELECT fuel_purchase_id, COALESCE(SUM(liters_unloaded), 0) as total_unloaded
                                                FROM fuel_unload
                                                WHERE Active = 1
                                                GROUP BY fuel_purchase_id
                                         ) fu ON fu.fuel_purchase_id = fp.id
                                         WHERE fp.Active = 1
                                             AND EXISTS (
                                                        SELECT 1
                                                        FROM trips t
                                                        INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.Active = 1
                                                   WHERE CONCAT('Trip#', t.trip_no) COLLATE utf8mb4_unicode_ci = fp.purchase_reference COLLATE utf8mb4_unicode_ci
                                                            AND ps.client_id = ?
                                                            AND DATE(ps.date) = ?
                                             )
                                             AND GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) > 0
                                         ORDER BY fp.id DESC
                                         LIMIT 25`,
                    [pumpId, targetDate]
                )
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
            const nrMinimal = (await connection.execute(
                `SELECT
                    nr.nozzle_id,
                    nr.opening_digital_reading,
                    nr.closing_digital_reading,
                    nr.opening_mechanical_reading,
                    nr.closing_mechanical_reading
                 FROM nozzle_readings nr
                 INNER JOIN nozzles n ON n.id = nr.nozzle_id
                 INNER JOIN machines m ON m.id = n.machine_id
                 INNER JOIN (
                    SELECT
                        nr2.nozzle_id,
                        MAX(nr2.daily_entry_id) AS latest_daily_entry_id
                    FROM nozzle_readings nr2
                    INNER JOIN nozzles n2 ON n2.id = nr2.nozzle_id
                    INNER JOIN machines m2 ON m2.id = n2.machine_id
                    INNER JOIN daily_sales_entries dse2 ON dse2.id = nr2.daily_entry_id AND dse2.Active = 1
                    WHERE nr2.Active = 1
                      AND m2.pump_id = ?
                    GROUP BY nr2.nozzle_id
                 ) latest ON latest.nozzle_id = nr.nozzle_id
                        AND latest.latest_daily_entry_id = nr.daily_entry_id
                 WHERE nr.Active = 1
                   AND m.pump_id = ?`,
                [pumpId, pumpId]
            ))[0] || [];
            const unloadNotifications = (unloadNotificationsResult[0] || []).map((row) => ({
                title: `Unload ${row.fuel_type || 'Fuel'} to tank`,
                detail: `${Math.round((parseFloat(row.liters_remaining) || 0) * 100) / 100}L pending for ${row.trip_ref || 'reference'}`
            }));
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
                weeklyTrend: [],
                unloadNotifications
            });
        }

        // Full mode: use date range for period (daily = single day; weekly/monthly/yearly = aggregate)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = getLocalDateStr(sevenDaysAgo);

        // Execute all independent queries in parallel for better performance
        const [
            salesAndLitersResult, //1   
            mobileOilResult,    //2
            creditSalesResult,  //3
            bankTransfersResult,  //4
            cashOutflowNetResult, //5
            cashOutflowOwnerResult,  //6
            expensesResult,     //7
            cashInHandResult,   //8
            outstandingDuesResult,  //9
            outstandingDuesCountResult,   //10
            outstandingDuesListResult,   //11
            customerRecoveriesListResult,   //12
            dailyExpensesBreakdownResult,   //13
            dailyExpensesDetailResult,     //14
            fuelStockResult,     //15
            salesByFuelTypeResult,   //16
            tankSalesBreakdownResult,   //17
            weeklyTrendResult,   //18
            nozzleReadingsResult,   //19
            staffSalaryResult,  //20
            unloadNotificationsResult   //21
        ] = await Promise.all([
            // 1. Combined sales and liters over date range (dse in range)
            connection.execute(
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

            // 2. Mobile oil sales over date range
            connection.execute(
                `SELECT
                    COALESCE(SUM(mo.total_amount), 0) as total_amount,
                    COALESCE(SUM(mo.liters_sold), 0) as liters_sold
                 FROM mobile_oil_cash_sales mo
                                 INNER JOIN daily_sales_entries dse
                                        ON mo.daily_entry_id = dse.id
                                     AND dse.Active = 1
                                 WHERE mo.Active = 1
                                     AND dse.pump_id = ?
                                     AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),

            // 3. Credit sales over date range
            connection.execute(
                `SELECT COALESCE(SUM(cs.total_amount), 0) as total FROM credit_sales cs
                INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND cs.Active = 1`,
                [pumpId, dateFrom, dateTo]
            ),

            // 4. Bank transfers over date range (from cash_outflow_bank table)
            connection.execute(
                `SELECT COALESCE(SUM(cob.amount), 0) as total FROM cash_outflow_bank cob
                INNER JOIN cash_management cm ON cob.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),
            // 5. Cash outflow Net over date range (from cash_outflow_net table)
            connection.execute(
                `SELECT COALESCE(SUM(con.amount), 0) as total FROM cash_outflow_net con
                INNER JOIN cash_management cm ON con.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),
            // 6. Cash outflow Owner over date range (from cash_outflow_owner table)
            connection.execute(
                `SELECT COALESCE(SUM(coo.amount), 0) as total FROM cash_outflow_owner coo
                INNER JOIN cash_management cm ON coo.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),

            // 7. Expenses over date range
            connection.execute(
                `SELECT COALESCE(SUM(de.amount), 0) as total FROM daily_expenses de
                INNER JOIN cash_management cm ON de.cash_management_id = cm.id AND cm.Active = 1
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND de.Active = 1`,
                [pumpId, dateFrom, dateTo]
            ),

            // 8. Cash in hand and previous day cash: latest entry in range (most recent day)
            connection.execute(
                `SELECT cm.final_cash_in_hand, cm.cash_from_previous_day FROM cash_management cm
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?
                ORDER BY dse.entry_date DESC LIMIT 1`,
                [pumpId, dateFrom, dateTo]
            ),

            // 9. Outstanding dues total: local dues + ws customer dues from customers/pol_sale/recoveries + ws credit sales

            connection.execute(
                `
    WITH customer_list AS (
        SELECT DISTINCT 
            'local' AS customer_type,
            cs.fuel_station_customer_id AS customer_id
        FROM credit_sales cs
        JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id 
            AND dse.Active = 1
            AND dse.pump_id = ?
        WHERE cs.Active = 1 
            AND cs.fuel_station_customer_id IS NOT NULL
            AND dse.entry_date BETWEEN ? AND ?
        
        UNION
        
        SELECT DISTINCT 
            'ws' AS customer_type,
            cs.ws_customer_id AS customer_id
        FROM credit_sales cs
        JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id 
            AND dse.Active = 1
            AND dse.pump_id = ?
        WHERE cs.Active = 1 
            AND cs.ws_customer_id IS NOT NULL
            AND dse.entry_date BETWEEN ? AND ?
    ),

    credit_sales_totals AS (
        SELECT 
            'local' AS customer_type,
            cs.fuel_station_customer_id AS customer_id,
            SUM(cs.total_amount) AS total_sales
        FROM credit_sales cs
        JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id 
            AND dse.Active = 1
            AND dse.pump_id = ?
        WHERE cs.Active = 1 
            AND cs.fuel_station_customer_id IS NOT NULL
            AND dse.entry_date BETWEEN ? AND ?
        GROUP BY cs.fuel_station_customer_id
        
        UNION ALL
        
        SELECT 
            'ws' AS customer_type,
            cs.ws_customer_id AS customer_id,
            SUM(cs.total_amount) AS total_sales
        FROM credit_sales cs
        JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id 
            AND dse.Active = 1
            AND dse.pump_id = ?
        WHERE cs.Active = 1 
            AND cs.ws_customer_id IS NOT NULL
            AND dse.entry_date BETWEEN ? AND ?
        GROUP BY cs.ws_customer_id
    ),

    local_ledger AS (
        SELECT 
            customer_id,
            SUM(debit) AS total_debit,
            SUM(credit) AS total_credit
        FROM customer_ledger
        WHERE Active = 1
        GROUP BY customer_id
    ),

    ws_previous_dues AS (
        SELECT 
            id AS customer_id,
            Previous_Dues AS previous_dues
        FROM customers
        WHERE active = 1
    ),

    ws_sales AS (
        SELECT 
            client_id AS customer_id,
            SUM(total_amount) AS total_sales
        FROM pol_sale
        WHERE Active = 1
        GROUP BY client_id
    ),

    ws_recoveries AS (
        SELECT 
            ws_customer_id AS customer_id,
            SUM(amount) AS total_recovered
        FROM fuel_station_customer_recoveries
        WHERE Active = 1 
            AND station_id = ?
            AND ws_customer_id IS NOT NULL
        GROUP BY ws_customer_id
    ),

    customer_dues AS (
        SELECT 
            cl.customer_type,
            cl.customer_id,
            
            CASE 
                WHEN cl.customer_type = 'local' THEN
                    COALESCE(cs.total_sales, 0) + COALESCE(ll.total_debit, 0) - COALESCE(ll.total_credit, 0)
                
                ELSE
                    COALESCE(wpd.previous_dues, 0)
                    + GREATEST(0, 
                        COALESCE(ws.total_sales, 0) - 
                        GREATEST(0, COALESCE(wr.total_recovered, 0) - COALESCE(wpd.previous_dues, 0))
                    )
                    + COALESCE(cs.total_sales, 0)
            END AS customer_due
            
        FROM customer_list cl
        
        LEFT JOIN credit_sales_totals cs 
            ON cl.customer_id = cs.customer_id 
            AND cl.customer_type = cs.customer_type
        
        LEFT JOIN local_ledger ll 
            ON cl.customer_id = ll.customer_id 
            AND cl.customer_type = 'local'
        
        LEFT JOIN ws_previous_dues wpd 
            ON cl.customer_id = wpd.customer_id 
            AND cl.customer_type = 'ws'
        
        LEFT JOIN ws_sales ws 
            ON cl.customer_id = ws.customer_id 
            AND cl.customer_type = 'ws'
        
        LEFT JOIN ws_recoveries wr 
            ON cl.customer_id = wr.customer_id 
            AND cl.customer_type = 'ws'
    )

    SELECT 
        COALESCE(SUM(GREATEST(customer_due, 0)), 0) AS total_due
    FROM customer_dues
    `,
                [
                    pumpId, dateFrom, dateTo,  // customer_list - local
                    pumpId, dateFrom, dateTo,  // customer_list - ws
                    pumpId, dateFrom, dateTo,  // credit_sales_totals - local
                    pumpId, dateFrom, dateTo,  // credit_sales_totals - ws
                    pumpId                     // ws_recoveries - station_id
                ]
            ),

            // 10. Outstanding dues count with date filter
            connection.execute(
                `SELECT COUNT(*) AS cnt
                FROM (
                    SELECT
                        base.customer_type,
                        base.customer_id,
                        GREATEST(
                            CASE
                                WHEN base.customer_type = 'local'
                                    THEN COALESCE(cs.credit_sales_total, 0) + COALESCE(cl.debit_total, 0) - COALESCE(cl.credit_total, 0)
                                ELSE (
                                    COALESCE(wc.previous_dues, 0) +
                                    GREATEST(
                                        0,
                                        COALESCE(ws_sales.total_sales_amount, 0) -
                                        GREATEST(0, COALESCE(ws_recovery.total_recovery, 0) - COALESCE(wc.previous_dues, 0))
                                    ) +
                                    COALESCE(cs.credit_sales_total, 0)
                                )
                            END,
                            0
                        ) AS customer_due
                    FROM (
                        -- local customers with date filter
                        SELECT DISTINCT 'local' AS customer_type, cs.fuel_station_customer_id AS customer_id
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ? 
                            AND cs.Active = 1 
                            AND cs.fuel_station_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        
                        UNION
                        
                        -- WS customers with date filter
                        SELECT DISTINCT 'ws' AS customer_type, cs.ws_customer_id AS customer_id
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ? 
                            AND cs.Active = 1 
                            AND cs.ws_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                    ) base
                    
                    LEFT JOIN (
                        SELECT
                            'local' AS customer_type,
                            cs.fuel_station_customer_id AS customer_id,
                            COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ? 
                            AND cs.Active = 1 
                            AND cs.fuel_station_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        GROUP BY cs.fuel_station_customer_id
                        
                        UNION ALL
                        
                        SELECT
                            'ws' AS customer_type,
                            cs.ws_customer_id AS customer_id,
                            COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ? 
                            AND cs.Active = 1 
                            AND cs.ws_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        GROUP BY cs.ws_customer_id
                    ) cs ON base.customer_id = cs.customer_id AND base.customer_type = cs.customer_type
                    
                    LEFT JOIN (
                        SELECT
                            c.id AS customer_id,
                            COALESCE(c.Previous_Dues, 0) AS previous_dues
                        FROM customers c
                        WHERE c.active = 1
                    ) wc ON base.customer_id = wc.customer_id AND base.customer_type = 'ws'
                    
                    LEFT JOIN (
                        SELECT
                            ps.client_id AS customer_id,
                            COALESCE(SUM(ps.total_amount), 0) AS total_sales_amount
                        FROM pol_sale ps
                        WHERE ps.Active = 1
                        GROUP BY ps.client_id
                    ) ws_sales ON base.customer_id = ws_sales.customer_id AND base.customer_type = 'ws'
                    
                    LEFT JOIN (
                        SELECT
                            customer_id,
                            COALESCE(SUM(debit), 0) AS debit_total,
                            COALESCE(SUM(credit), 0) AS credit_total
                        FROM customer_ledger
                        WHERE Active = 1
                        GROUP BY customer_id
                    ) cl ON base.customer_id = cl.customer_id AND base.customer_type = 'local'
                    
                    LEFT JOIN (
                        SELECT
                            fscr.ws_customer_id AS customer_id,
                            COALESCE(SUM(fscr.amount), 0) AS total_recovery
                        FROM fuel_station_customer_recoveries fscr
                        WHERE fscr.Active = 1
                            AND fscr.station_id = ?
                            AND fscr.ws_customer_id IS NOT NULL
                        GROUP BY fscr.ws_customer_id
                    ) ws_recovery ON base.customer_id = ws_recovery.customer_id AND base.customer_type = 'ws'
                ) dues
                WHERE customer_due > 0`,
                [
                    // Base - local (3 params)
                    pumpId, dateFrom, dateTo,
                    // Base - WS (3 params)
                    pumpId, dateFrom, dateTo,
                    // Credit sales - local (3 params)
                    pumpId, dateFrom, dateTo,
                    // Credit sales - WS (3 params)
                    pumpId, dateFrom, dateTo,
                    // Recoveries station_id (1 param)
                    pumpId
                ]
            ),

            //11. Outstanding dues customer list with date filter
            /*  db.execute(
                 `
     SELECT 
         base.customer_type,
         base.customer_id,
         COALESCE(
             CASE 
                 WHEN base.customer_type = 'local' THEN fsc.customer_name
                 ELSE wc.name
             END, 
             ''
         ) AS customer_name,
         COALESCE(
             CASE 
                 WHEN base.customer_type = 'local' THEN fsc.phone_number
                 ELSE wc.phone
             END, 
             ''
         ) AS customer_phone,
         GREATEST(
             CASE
                 WHEN base.customer_type = 'local'
                     THEN COALESCE(cs.credit_sales_total, 0) + COALESCE(cl.debit_total, 0) - COALESCE(cl.credit_total, 0)
                 ELSE (
                     COALESCE(wc.Previous_Dues, 0) +
                     GREATEST(
                         0,
                         COALESCE(ws_sales.total_sales_amount, 0) -
                         GREATEST(0, COALESCE(ws_recovery.total_recovery, 0) - COALESCE(wc.Previous_Dues, 0))
                     ) +
                     COALESCE(cs.credit_sales_total, 0)
                 )
             END,
             0
         ) AS remaining_amount,
         cs.first_credit_date AS due_since,
         COALESCE(
             CASE 
                 WHEN base.customer_type = 'local' THEN lp.last_payment_amount
                 ELSE ws_recovery.last_recovery_amount
             END, 
             0
         ) AS last_payment,
         CASE 
             WHEN base.customer_type = 'local' THEN NULL
             ELSE ws_recovery.last_recovery_date
         END AS recovery_date,
         COALESCE(
             CASE 
                 WHEN base.customer_type = 'local' THEN lp.last_payment_amount
                 ELSE ws_recovery.last_recovery_amount
             END, 
             0
         ) AS recovery_last_amount,
         DATEDIFF(CURDATE(), cs.first_credit_date) AS due_since_days
     FROM (
         -- Get all local customers with credit sales in date range
         SELECT DISTINCT 'local' AS customer_type, cs.fuel_station_customer_id AS customer_id
         FROM credit_sales cs
         INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
         WHERE dse.pump_id = ? 
             AND cs.Active = 1 
             AND cs.fuel_station_customer_id IS NOT NULL
             AND DATE(dse.entry_date) BETWEEN ? AND ?
         
         UNION
         
         -- Get all WS customers with credit sales in date range
         SELECT DISTINCT 'ws' AS customer_type, cs.ws_customer_id AS customer_id
         FROM credit_sales cs
         INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
         WHERE dse.pump_id = ? 
             AND cs.Active = 1 
             AND cs.ws_customer_id IS NOT NULL
             AND DATE(dse.entry_date) BETWEEN ? AND ?
     ) base
     
     -- For local customers: Join directly to fuel_station_customer table
     LEFT JOIN fuel_station_customer fsc 
         ON base.customer_id = fsc.customer_id 
         AND fsc.Active = 1 
         AND base.customer_type = 'local'
     
     -- For WS customers: Join directly to customers table
     LEFT JOIN customers wc 
         ON base.customer_id = wc.id 
         AND wc.active = 1 
         AND base.customer_type = 'ws'
     
     -- Credit sales totals with first credit date
     LEFT JOIN (
         SELECT
             'local' AS customer_type,
             cs.fuel_station_customer_id AS customer_id,
             COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total,
             MIN(DATE(dse.entry_date)) AS first_credit_date
         FROM credit_sales cs
         INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
         WHERE dse.pump_id = ? 
             AND cs.Active = 1 
             AND cs.fuel_station_customer_id IS NOT NULL
             AND DATE(dse.entry_date) BETWEEN ? AND ?
         GROUP BY cs.fuel_station_customer_id
         
         UNION ALL
         
         SELECT
             'ws' AS customer_type,
             cs.ws_customer_id AS customer_id,
             COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total,
             MIN(DATE(dse.entry_date)) AS first_credit_date
         FROM credit_sales cs
         INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
         WHERE dse.pump_id = ? 
             AND cs.Active = 1 
             AND cs.ws_customer_id IS NOT NULL
             AND DATE(dse.entry_date) BETWEEN ? AND ?
         GROUP BY cs.ws_customer_id
     ) cs ON base.customer_id = cs.customer_id AND base.customer_type = cs.customer_type
     
     -- WS sales (POL sales)
     LEFT JOIN (
         SELECT
             ps.client_id AS customer_id,
             COALESCE(SUM(ps.total_amount), 0) AS total_sales_amount
         FROM pol_sale ps
         WHERE ps.Active = 1
         GROUP BY ps.client_id
     ) ws_sales ON base.customer_id = ws_sales.customer_id AND base.customer_type = 'ws'
     
     -- Local customer ledger
     LEFT JOIN (
         SELECT
             cl.customer_id,
             COALESCE(SUM(cl.debit), 0) AS debit_total,
             COALESCE(SUM(cl.credit), 0) AS credit_total
         FROM customer_ledger cl
         WHERE cl.Active = 1
         GROUP BY cl.customer_id
     ) cl ON base.customer_id = cl.customer_id AND base.customer_type = 'local'
     
     -- WS recoveries with last recovery info
     LEFT JOIN (
         SELECT
             fscr.ws_customer_id AS customer_id,
             COALESCE(SUM(fscr.amount), 0) AS total_recovery,
             MAX(fscr.amount) AS last_recovery_amount,
             MAX(fscr.recovery_date) AS last_recovery_date
         FROM fuel_station_customer_recoveries fscr
         WHERE fscr.Active = 1
             AND fscr.station_id = ?
             AND fscr.ws_customer_id IS NOT NULL
         GROUP BY fscr.ws_customer_id
     ) ws_recovery ON base.customer_id = ws_recovery.customer_id AND base.customer_type = 'ws'
     
     -- Local last payment from ledger
     LEFT JOIN (
         SELECT
             customer_id,
             MAX(credit) AS last_payment_amount
         FROM customer_ledger
         WHERE Active = 1 AND credit > 0
         GROUP BY customer_id
     ) lp ON base.customer_id = lp.customer_id AND base.customer_type = 'local'
     
     WHERE GREATEST(
         CASE
             WHEN base.customer_type = 'local'
                 THEN COALESCE(cs.credit_sales_total, 0) + COALESCE(cl.debit_total, 0) - COALESCE(cl.credit_total, 0)
             ELSE (
                 COALESCE(wc.Previous_Dues, 0) +
                 GREATEST(
                     0,
                     COALESCE(ws_sales.total_sales_amount, 0) -
                     GREATEST(0, COALESCE(ws_recovery.total_recovery, 0) - COALESCE(wc.Previous_Dues, 0))
                 ) +
                 COALESCE(cs.credit_sales_total, 0)
             )
         END,
         0
     ) > 0
     ORDER BY remaining_amount DESC
     `,
                 [
                     // Base subquery - local customers (3 params)
                     pumpId, dateFrom, dateTo,
                     // Base subquery - WS customers (3 params)
                     pumpId, dateFrom, dateTo,
                     // Credit sales totals - local (3 params)
                     pumpId, dateFrom, dateTo,
                     // Credit sales totals - WS (3 params)
                     pumpId, dateFrom, dateTo,
                     // Recoveries - station_id (1 param)
                     pumpId
                 ]
             ), */
            connection.execute(
                ` SELECT 
                        base.customer_type,
                        base.customer_id,
                        COALESCE(
                            CASE 
                                WHEN base.customer_type = 'local' THEN fsc.customer_name
                                WHEN base.customer_type = 'ws' THEN COALESCE(wc.name, pp.name, 'Unknown')
                                ELSE NULL
                            END, 
                            'Unknown'
                        ) AS customer_name,
                        COALESCE(
                            CASE 
                                WHEN base.customer_type = 'local' THEN fsc.phone_number
                                WHEN base.customer_type = 'ws' THEN COALESCE(wc.phone, 'Not Available')
                                ELSE NULL
                            END, 
                            ''
                        ) AS customer_phone,
                        GREATEST(
                            CASE
                                WHEN base.customer_type = 'local'
                                    THEN COALESCE(cs.credit_sales_total, 0) + COALESCE(cl.debit_total, 0) - COALESCE(cl.credit_total, 0)
                                ELSE (
                                    COALESCE(COALESCE(wc.Previous_Dues, pp.previous_dues, 0), 0) +
                                    GREATEST(
                                        0,
                                        COALESCE(ws_sales.total_sales_amount, 0) -
                                        GREATEST(0, COALESCE(ws_recovery.total_recovery, 0) - COALESCE(COALESCE(wc.Previous_Dues, pp.previous_dues, 0), 0))
                                    ) +
                                    COALESCE(cs.credit_sales_total, 0)
                                )
                            END,
                            0
                        ) AS remaining_amount,
                        cs.first_credit_date AS due_since,
                        COALESCE(
                            CASE 
                                WHEN base.customer_type = 'local' THEN lp.last_payment_amount
                                ELSE ws_recovery.last_recovery_amount
                            END, 
                            0
                        ) AS last_payment,
                        CASE 
                            WHEN base.customer_type = 'local' THEN NULL
                            ELSE ws_recovery.last_recovery_date
                        END AS recovery_date,
                        COALESCE(
                            CASE 
                                WHEN base.customer_type = 'local' THEN lp.last_payment_amount
                                ELSE ws_recovery.last_recovery_amount
                            END, 
                            0
                        ) AS recovery_last_amount,
                        DATEDIFF(CURDATE(), cs.first_credit_date) AS due_since_days
                    FROM (
                        -- Get all local customers with credit sales in date range
                        SELECT DISTINCT 'local' AS customer_type, cs.fuel_station_customer_id AS customer_id
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ?
                            AND cs.Active = 1 
                            AND cs.fuel_station_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        
                        UNION
                        
                        -- Get all WS customers with credit sales in date range
                        SELECT DISTINCT 'ws' AS customer_type, cs.ws_customer_id AS customer_id
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ?
                            AND cs.Active = 1 
                            AND cs.ws_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                    ) base
                    
                    -- For local customers: Join directly to fuel_station_customer table
                    LEFT JOIN fuel_station_customer fsc 
                        ON base.customer_id = fsc.customer_id 
                        AND fsc.Active = 1 
                        AND base.customer_type = 'local'
                    
                    -- For WS customers: First try to join to customers table
                    LEFT JOIN customers wc 
                        ON base.customer_id = wc.id 
                        AND base.customer_type = 'ws'
                    
                    -- For WS customers: Also try to join to petrol_pumps table
                    LEFT JOIN petrol_pumps pp 
                        ON base.customer_id = pp.id 
                        AND pp.Active = 1 
                        AND base.customer_type = 'ws'
                    
                    -- Credit sales totals with first credit date
                    LEFT JOIN (
                        SELECT
                            'local' AS customer_type,
                            cs.fuel_station_customer_id AS customer_id,
                            COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total,
                            MIN(DATE(dse.entry_date)) AS first_credit_date
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ?
                            AND cs.Active = 1 
                            AND cs.fuel_station_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        GROUP BY cs.fuel_station_customer_id
                        
                        UNION ALL
                        
                        SELECT
                            'ws' AS customer_type,
                            cs.ws_customer_id AS customer_id,
                            COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total,
                            MIN(DATE(dse.entry_date)) AS first_credit_date
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ?
                            AND cs.Active = 1 
                            AND cs.ws_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        GROUP BY cs.ws_customer_id
                    ) cs ON base.customer_id = cs.customer_id AND base.customer_type = cs.customer_type
                    
                    -- WS sales (POL sales)
                    LEFT JOIN (
                        SELECT
                            ps.client_id AS customer_id,
                            COALESCE(SUM(ps.total_amount), 0) AS total_sales_amount
                        FROM pol_sale ps
                        WHERE ps.Active = 1
                        GROUP BY ps.client_id
                    ) ws_sales ON base.customer_id = ws_sales.customer_id AND base.customer_type = 'ws'
                    
                    -- Local customer ledger
                    LEFT JOIN (
                        SELECT
                            cl.customer_id,
                            COALESCE(SUM(cl.debit), 0) AS debit_total,
                            COALESCE(SUM(cl.credit), 0) AS credit_total
                        FROM customer_ledger cl
                        WHERE cl.Active = 1
                        GROUP BY cl.customer_id
                    ) cl ON base.customer_id = cl.customer_id AND base.customer_type = 'local'
                    
                    -- WS recoveries with last recovery info
                    LEFT JOIN (
                        SELECT
                            fscr.ws_customer_id AS customer_id,
                            COALESCE(SUM(fscr.amount), 0) AS total_recovery,
                            MAX(fscr.amount) AS last_recovery_amount,
                            MAX(fscr.recovery_date) AS last_recovery_date
                        FROM fuel_station_customer_recoveries fscr
                        WHERE fscr.Active = 1
                            AND fscr.station_id = ?
                            AND fscr.ws_customer_id IS NOT NULL
                        GROUP BY fscr.ws_customer_id
                    ) ws_recovery ON base.customer_id = ws_recovery.customer_id AND base.customer_type = 'ws'
                    
                    -- Local last payment from ledger
                    LEFT JOIN (
                        SELECT
                            customer_id,
                            MAX(credit) AS last_payment_amount
                        FROM customer_ledger
                        WHERE Active = 1 AND credit > 0
                        GROUP BY customer_id
                    ) lp ON base.customer_id = lp.customer_id AND base.customer_type = 'local'
                    
                    WHERE GREATEST(
                        CASE
                            WHEN base.customer_type = 'local'
                                THEN COALESCE(cs.credit_sales_total, 0) + COALESCE(cl.debit_total, 0) - COALESCE(cl.credit_total, 0)
                            ELSE (
                                COALESCE(COALESCE(wc.Previous_Dues, pp.previous_dues, 0), 0) +
                                GREATEST(
                                    0,
                                    COALESCE(ws_sales.total_sales_amount, 0) -
                                    GREATEST(0, COALESCE(ws_recovery.total_recovery, 0) - COALESCE(COALESCE(wc.Previous_Dues, pp.previous_dues, 0), 0))
                                ) +
                                COALESCE(cs.credit_sales_total, 0)
                            )
                        END,
                        0
                    ) > 0
                    ORDER BY remaining_amount DESC
                    `,
                [
                    // Base subquery - local customers (3 params)
                    pumpId, dateFrom, dateTo,
                    // Base subquery - WS customers (3 params)
                    pumpId, dateFrom, dateTo,
                    // Credit sales totals - local (3 params)
                    pumpId, dateFrom, dateTo,
                    // Credit sales totals - WS (3 params)
                    pumpId, dateFrom, dateTo,
                    // Recoveries - station_id (1 param)
                    pumpId
                ]
            ),
            // 12. Customer recoveries list from fuel_station_customer_recoveries (local + ws mapping)
            connection.execute(
                `SELECT
                    agg.customer_type,
                    agg.customerId,
                    CASE
                        WHEN agg.customer_type = 'ws'
                            THEN COALESCE(wc.name, CONCAT('Customer #', agg.customerId))
                        ELSE COALESCE(fsc.customer_name, CONCAT('Customer #', agg.customerId))
                    END AS customer_name,
                    agg.remaining_amount,
                    NULL AS due_since,
                    0 AS last_payment,
                    agg.recovery_last_amount,
                    agg.recovery_date
                 FROM (
                     SELECT
                         CASE
                             WHEN fscr.ws_customer_id IS NOT NULL THEN 'ws'
                             ELSE 'local'
                         END AS customer_type,
                         COALESCE(fscr.ws_customer_id, fscr.customer_id) AS customerId,
                         COALESCE(SUM(fscr.amount), 0) AS remaining_amount,
                         MAX(fscr.amount) AS recovery_last_amount,
                         MAX(DATE(fscr.recovery_date)) AS recovery_date
                     FROM fuel_station_customer_recoveries fscr
                     WHERE fscr.Active = 1
                       AND fscr.station_id = ?
                       AND DATE(fscr.recovery_date) BETWEEN ? AND ?
                       AND (fscr.customer_id IS NOT NULL OR fscr.ws_customer_id IS NOT NULL)
                     GROUP BY
                         CASE
                             WHEN fscr.ws_customer_id IS NOT NULL THEN 'ws'
                             ELSE 'local'
                         END,
                         COALESCE(fscr.ws_customer_id, fscr.customer_id)
                 ) agg
                 LEFT JOIN fuel_station_customer fsc
                        ON agg.customer_type = 'local'
                       AND agg.customerId = fsc.customer_id
                       AND fsc.Active = 1
                 LEFT JOIN customers wc
                        ON agg.customer_type = 'ws'
                       AND agg.customerId = wc.id
                       AND wc.active = 1
                 ORDER BY agg.remaining_amount DESC, agg.recovery_date DESC
                 LIMIT 15`,
                [pumpId, dateFrom, dateTo]
            ),
            // 13. Daily expenses breakdown by category (with category name from expense_categories)
            connection.execute(
                `SELECT COALESCE(ec.name, 'Other') as expense_category_name, SUM(de.amount) as amount
                FROM daily_expenses de
                INNER JOIN cash_management cm ON de.cash_management_id = cm.id AND cm.Active = 1
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                LEFT JOIN expense_categories ec ON de.expense_category = ec.id
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND de.Active = 1
                GROUP BY de.expense_category, ec.name
                ORDER BY amount DESC`,
                [pumpId, dateFrom, dateTo]
            ),
            // 14. Daily expenses detail (each row with category name from expense_categories)
            connection.execute(
                `SELECT COALESCE(ec.name, 'Other') as expense_category_name, de.amount, de.description, DATE(dse.entry_date) as entry_date
                FROM daily_expenses de
                INNER JOIN cash_management cm ON de.cash_management_id = cm.id AND cm.Active = 1
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                LEFT JOIN expense_categories ec ON de.expense_category = ec.id
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND de.Active = 1
                ORDER BY dse.entry_date DESC, de.id DESC`,
                [pumpId, dateFrom, dateTo]
            ),

            // 15. Fuel stock - fetched via nozzles table
            connection.execute(
                `SELECT DISTINCT
                    ft.id AS tank_id,
                    ft.tank_number,
                    ft.fuel_type,
                    ft.current_level,
                    ft.capacity,
                    ft.low_alert_level,
                    COALESCE((
                        SELECT dti.opening_level
                        FROM daily_tank_inventory dti
                        INNER JOIN daily_sales_entries dse ON dse.id = dti.daily_entry_id AND dse.Active = 1
                        WHERE dti.Active = 1
                          AND dti.tank_id = ft.id
                          AND DATE(dse.entry_date) BETWEEN ? AND ?
                        ORDER BY dse.entry_date DESC, dti.id DESC
                        LIMIT 1
                    ), 0) AS old_stock,
                                        CASE
                                                WHEN LOWER(COALESCE(ft.fuel_type, '')) LIKE '%mobile%'
                                                    OR LOWER(COALESCE(ft.fuel_type, '')) LIKE '%oil%'
                                                THEN COALESCE((
                                                        SELECT SUM(mop.liters_purchased)
                                                        FROM mobile_oil_purchase mop
                                                        WHERE (mop.active = 1 OR mop.active IS NULL)
                                                            AND mop.pump_id = ft.pump_id
                                                            AND DATE(mop.cd) BETWEEN ? AND ?
                                                ), 0)
                                                ELSE COALESCE((
                                                        SELECT SUM(fu.liters_unloaded)
                                                        FROM fuel_unload fu
                                                        WHERE fu.Active = 1
                                                            AND fu.fuel_tank_id = ft.id
                                                            AND DATE(fu.CD) BETWEEN ? AND ?
                                                ), 0)
                                        END AS supply_purchased,
                                        COALESCE((
                                                SELECT SUM(nr.total_sold)
                                                FROM nozzle_readings nr
                                                INNER JOIN nozzles n ON n.id = nr.nozzle_id
                                                INNER JOIN daily_sales_entries dse ON dse.id = nr.daily_entry_id AND dse.Active = 1
                                                WHERE nr.Active = 1
                                                    AND n.tank_id = ft.id
                                                    AND DATE(dse.entry_date) BETWEEN ? AND ?
                                        ), 0) AS sold_liters,
                                        COALESCE((
                                                SELECT SUM(tr.liters_returned)
                                                FROM tank_returns tr
                                                INNER JOIN daily_sales_entries dse ON dse.id = tr.daily_entry_id AND dse.Active = 1
                                                WHERE tr.Active = 1
                                                    AND tr.fuel_tank_id = ft.id
                                                    AND dse.pump_id = ?
                                                    AND DATE(dse.entry_date) BETWEEN ? AND ?
                                        ), 0) AS returned_liters,
                    COALESCE((
                        SELECT pdr.volume_liters
                        FROM physical_dip_readings pdr
                        WHERE pdr.Active = 1
                          AND pdr.tank_id = ft.id
                          AND DATE(COALESCE(pdr.reading_time, pdr.CD)) BETWEEN ? AND ?
                        ORDER BY COALESCE(pdr.reading_time, pdr.CD) DESC, pdr.id DESC
                        LIMIT 1
                    ), 0) AS dip_stock,
                    COALESCE((
                    SELECT fta.adjustment_value
                    FROM fuel_tank_adjustments fta
                    WHERE fta.tank_id = ft.id
                    AND fta.Active = 1
                    ORDER BY fta.CD DESC
                    LIMIT 1
                ), 0) AS last_adjustment   -- <-- new column
                FROM fuel_tanks ft
                LEFT JOIN nozzles n ON n.tank_id = ft.id AND n.Active = 1
                WHERE ft.pump_id = ? AND ft.Active = 1
                ORDER BY ft.fuel_type, ft.tank_number, ft.id`,
                [dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, pumpId, dateFrom, dateTo, dateFrom, dateTo, pumpId]
            ),

            // 16. Sales by fuel type (last 7 days)
            connection.execute(
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

            // 17. Tank-wise sold liters for selected period
            connection.execute(
                `
                SELECT
                    ft.id AS tank_id,
                    ft.fuel_type,
                    ft.tank_number,
                    COALESCE(SUM(nr.total_sold), 0) AS sold_liters
                FROM fuel_tanks ft
                INNER JOIN nozzles n ON n.tank_id = ft.id AND n.Active = 1
                INNER JOIN nozzle_readings nr ON nr.nozzle_id = n.id AND nr.Active = 1
                INNER JOIN daily_sales_entries dse ON dse.id = nr.daily_entry_id 
                    AND dse.Active = 1 
                    AND dse.pump_id = ?
                    AND DATE(dse.entry_date) BETWEEN ? AND ?
                WHERE ft.pump_id = ?
                    AND ft.Active = 1
                    AND ft.fuel_type NOT IN ('Mobile Oil', 'mobile oil')
                GROUP BY ft.id, ft.fuel_type, ft.tank_number
                ORDER BY ft.fuel_type, ft.tank_number, ft.id
                `,
                [pumpId, dateFrom, dateTo, pumpId]
            ),

            // 18. Weekly trend (last 7 days) - optimized
            connection.execute(
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
            // 19. Latest nozzle readings per nozzle by daily_entry_id for selected pump
            connection.execute(
                `SELECT
                    nr.nozzle_id,
                    nr.opening_digital_reading,
                    nr.closing_digital_reading,
                    nr.opening_mechanical_reading,
                    nr.closing_mechanical_reading
                 FROM nozzle_readings nr
                 INNER JOIN nozzles n ON n.id = nr.nozzle_id
                 INNER JOIN machines m ON m.id = n.machine_id
                 INNER JOIN (
                    SELECT
                        nr2.nozzle_id,
                        MAX(nr2.daily_entry_id) AS latest_daily_entry_id
                    FROM nozzle_readings nr2
                    INNER JOIN nozzles n2 ON n2.id = nr2.nozzle_id
                    INNER JOIN machines m2 ON m2.id = n2.machine_id
                    INNER JOIN daily_sales_entries dse2 ON dse2.id = nr2.daily_entry_id AND dse2.Active = 1
                    WHERE nr2.Active = 1
                      AND m2.pump_id = ?
                    GROUP BY nr2.nozzle_id
                 ) latest ON latest.nozzle_id = nr.nozzle_id
                        AND latest.latest_daily_entry_id = nr.daily_entry_id
                 WHERE nr.Active = 1
                   AND m.pump_id = ?`,
                [pumpId, pumpId]
            ),

            // 20. Staff advance credit over date range
            connection.execute(
                `SELECT COALESCE(SUM(sas.debit), 0) as total
                FROM staff_advance_salary sas
                INNER JOIN cash_management cm ON sas.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ?
                AND DATE(dse.entry_date) BETWEEN ? AND ?
                AND sas.Active = 1`,
                [pumpId, dateFrom, dateTo]
            ), ,

            // 21. Self-customer sales that should be unloaded in respective tanks.
            connection.execute(
                `SELECT
                            fp.id,
                            COALESCE(fp.fuel_type, 'Fuel') as fuel_type,
                            fp.purchase_reference as trip_ref,
                            GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) as liters_remaining
                        FROM fuel_purchased fp
                        LEFT JOIN (
                            SELECT fuel_purchase_id, COALESCE(SUM(liters_unloaded), 0) as total_unloaded
                            FROM fuel_unload
                            WHERE Active = 1
                            GROUP BY fuel_purchase_id
                        ) fu ON fu.fuel_purchase_id = fp.id
                        WHERE fp.Active = 1
                            AND EXISTS (
                                    SELECT 1
                                    FROM trips t
                                    INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.Active = 1
                                WHERE CONCAT('Trip#', t.trip_no) COLLATE utf8mb4_unicode_ci = fp.purchase_reference COLLATE utf8mb4_unicode_ci
                                        AND ps.client_id = ?
                                        AND DATE(ps.date) BETWEEN ? AND ?
                            )
                            AND GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) > 0
                        ORDER BY fp.id DESC
                        LIMIT 50`,
                [pumpId, dateFrom, dateTo]
            )
        ]);

        // Process results
        //console.log('Pump:', pumpId + ', Date Range:', dateFrom, 'to', dateTo);

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
        const outstandingDues = (outstandingDuesResult[0] && outstandingDuesResult[0][0] && parseFloat(outstandingDuesResult[0][0].total_due)) || 0;
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
        console.log('Outstanding Dues List:', outstandingDuesListResult[0]);
        const customerRecoveriesList = (customerRecoveriesListResult[0] || []).map(row => ({
            customerId: row.customerId,
            customer_name: row.customer_name || 'Unknown',
            remaining_amount: parseFloat(row.remaining_amount) || 0,
            due_since: row.due_since,
            last_payment: parseFloat(row.last_payment) || 0,
            recovery_last_amount: parseFloat(row.recovery_last_amount) || 0,
            recovery_date: row.recovery_date
        }));
        const customerRecoveries = customerRecoveriesList.reduce((sum, row) => sum + (Number(row.remaining_amount) || 0), 0);
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

        const unloadNotifications = (unloadNotificationsResult && unloadNotificationsResult[0])
            ? unloadNotificationsResult[0].map((row) => ({
                title: `Unload ${row.fuel_type || 'Fuel'} to tank`,
                detail: `${Math.round((parseFloat(row.liters_remaining) || 0) * 100) / 100}L pending for ${row.trip_ref || 'reference'}`
            }))
            : [];

        /*   const unloadNotifications = (unloadNotificationsResult[0] || []).map((row) => ({
              title: `Unload ${row.fuel_type || 'Fuel'} to tank`,
              detail: `${Math.round((parseFloat(row.liters_remaining) || 0) * 100) / 100}L pending for ${row.trip_ref || 'reference'}`
          })); */

        const fuelStock = (fuelStockResult[0] || []).map(row => {
            const newStock = parseFloat(row.current_level) || 0;
            const dipStock = parseFloat(row.dip_stock) || 0;
            const lowAlertLevel = parseFloat(row.low_alert_level) || 0;
            return {
                tank_id: row.tank_id,
                tank_number: row.tank_number,
                fuel_type: row.fuel_type || 'N/A',
                old_stock: parseFloat(row.old_stock) || 0,
                supply_purchased: parseFloat(row.supply_purchased) || 0,
                sold_liters: parseFloat(row.sold_liters) || 0,
                returned_liters: parseFloat(row.returned_liters) || 0,
                new_stock: newStock,
                dip_stock: dipStock,
                variance: Math.round((dipStock - newStock) * 100) / 100,
                current_level: newStock,
                capacity: parseFloat(row.capacity) || 0,
                is_low_level: newStock <= lowAlertLevel,
                alert_status: newStock <= lowAlertLevel ? 'Low Level Alert' : 'Normal',
                last_adjustment: parseFloat(row.last_adjustment) || 0
            };
        });

        const salesByFuelType = (salesByFuelTypeResult[0] || []).map(row => ({
            fuel_type: row.fuel_type || 'N/A',
            total_sales: parseFloat(row.total_sales) || 0
        }));

        const tankSalesBreakdown = (tankSalesBreakdownResult[0] || []).map(row => {
            const tankNumber = row.tank_number != null ? row.tank_number : row.tank_id;
            return {
                tank_id: row.tank_id,
                tank_name: `${row.fuel_type || 'Fuel'} Tank ${tankNumber}`,
                fuel_type: row.fuel_type || 'N/A',
                sold_liters: Math.round((parseFloat(row.sold_liters) || 0) * 100) / 100
            };
        });

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
            customerRecoveries: Math.round(customerRecoveries * 100) / 100,
            customerRecoveriesList,
            dailyExpensesBreakdown,
            dailyExpensesDetail,
            staffSalary: Math.round(staffSalary * 100) / 100,
            fuelStock,
            salesByFuelType,
            tankSalesBreakdown,
            weeklyTrend,
            unloadNotifications
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
                weeklyTrend: [],
                unloadNotifications: []
            });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    } finally {
        if (connection) {
            connection.release();
        }
    }
};



exports.getPumpDashboardData = async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        const pumpId = req.query.pump_id;
        const minimal = req.query.minimal === '1' || req.query.minimal === 'true';
        const period = (req.query.period || 'daily').toLowerCase();
        const requestedEntryDate = String(req.query.entry_date || '').trim();
        const hasExplicitDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedEntryDate);

        if (!pumpId) {
            return res.status(400).json({ message: 'pump_id is required' });
        }

        const today = getLocalDateStr();
        const targetDate = hasExplicitDate ? requestedEntryDate : today;
        const { dateFrom, dateTo } = getDateRangeForPeriod(period, targetDate);

        // Get selected date entry first
        let [todayEntry] = await connection.execute(
            `SELECT id, entry_date FROM daily_sales_entries WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 LIMIT 1`,
            [pumpId, targetDate]
        );

        let todayEntryId = todayEntry && todayEntry[0] ? todayEntry[0].id : null;
        let entryDateUsed = targetDate;

        // Minimal mode: only Today's Sales + Cash Sales (2 cards) - 3 queries in parallel
        if (minimal) {
            const [salesAndLitersResult, creditSalesResult, mobileOilResult, unloadNotificationsResult] = await Promise.all([
                todayEntryId ? connection.execute(
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
                todayEntryId ? connection.execute(
                    `SELECT COALESCE(SUM(total_amount), 0) as total FROM credit_sales 
                    WHERE daily_entry_id = ? AND Active = 1`,
                    [todayEntryId]
                ) : Promise.resolve([[{ total: 0 }]]),
                connection.execute(
                    `SELECT
                        COALESCE(SUM(mo.total_amount), 0) as total_amount,
                        COALESCE(SUM(mo.liters_sold), 0) as liters_sold
                     FROM mobile_oil_cash_sales mo
                     WHERE mo.Active = 1
                       AND mo.daily_entry_id IN (
                            SELECT dse.id
                            FROM daily_sales_entries dse
                            WHERE dse.pump_id = ?
                              AND DATE(dse.entry_date) = ?
                              AND dse.Active = 1
                       )`,
                    [pumpId, targetDate]
                ),
                connection.execute(
                    `SELECT
                        fp.id,
                        COALESCE(fp.fuel_type, 'Fuel') as fuel_type,
                        fp.purchase_reference as trip_ref,
                        GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) as liters_remaining
                     FROM fuel_purchased fp
                     LEFT JOIN (
                        SELECT fuel_purchase_id, COALESCE(SUM(liters_unloaded), 0) as total_unloaded
                        FROM fuel_unload
                        WHERE Active = 1
                        GROUP BY fuel_purchase_id
                     ) fu ON fu.fuel_purchase_id = fp.id
                     WHERE fp.Active = 1
                         AND EXISTS (
                            SELECT 1
                            FROM trips t
                            INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.Active = 1
                            WHERE CONCAT('Trip#', t.trip_no) COLLATE utf8mb4_unicode_ci = fp.purchase_reference COLLATE utf8mb4_unicode_ci
                                AND ps.client_id = ?
                                AND DATE(ps.date) = ?
                         )
                         AND GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) > 0
                     ORDER BY fp.id DESC
                     LIMIT 25`,
                    [pumpId, targetDate]
                )
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

            const nrMinimal = (await connection.execute(
                `SELECT
                    nr.nozzle_id,
                    nr.opening_digital_reading,
                    nr.closing_digital_reading,
                    nr.opening_mechanical_reading,
                    nr.closing_mechanical_reading
                 FROM nozzle_readings nr
                 INNER JOIN nozzles n ON n.id = nr.nozzle_id
                 INNER JOIN machines m ON m.id = n.machine_id
                 INNER JOIN (
                    SELECT
                        nr2.nozzle_id,
                        MAX(nr2.daily_entry_id) AS latest_daily_entry_id
                    FROM nozzle_readings nr2
                    INNER JOIN nozzles n2 ON n2.id = nr2.nozzle_id
                    INNER JOIN machines m2 ON m2.id = n2.machine_id
                    INNER JOIN daily_sales_entries dse2 ON dse2.id = nr2.daily_entry_id AND dse2.Active = 1
                    WHERE nr2.Active = 1
                      AND m2.pump_id = ?
                    GROUP BY nr2.nozzle_id
                 ) latest ON latest.nozzle_id = nr.nozzle_id
                        AND latest.latest_daily_entry_id = nr.daily_entry_id
                 WHERE nr.Active = 1
                   AND m.pump_id = ?`,
                [pumpId, pumpId]
            ))[0] || [];

            const unloadNotifications = (unloadNotificationsResult[0] || []).map((row) => ({
                title: `Unload ${row.fuel_type || 'Fuel'} to tank`,
                detail: `${Math.round((parseFloat(row.liters_remaining) || 0) * 100) / 100}L pending for ${row.trip_ref || 'reference'}`
            }));

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
                weeklyTrend: [],
                unloadNotifications
            });
        }

        // Full mode: use date range for period
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = getLocalDateStr(sevenDaysAgo);

        // =============================================
        // BATCH 1: Sales and Financial Queries
        // =============================================
        const [
            salesAndLitersResult,
            mobileOilResult,
            creditSalesResult,
            bankTransfersResult
        ] = await Promise.all([
            // 1. Combined sales and liters over date range
            connection.execute(
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
            // 2. Mobile oil sales over date range
            connection.execute(
                `SELECT
                    COALESCE(SUM(mo.total_amount), 0) as total_amount,
                    COALESCE(SUM(mo.liters_sold), 0) as liters_sold
                 FROM mobile_oil_cash_sales mo
                 INNER JOIN daily_sales_entries dse ON mo.daily_entry_id = dse.id AND dse.Active = 1
                 WHERE mo.Active = 1
                     AND dse.pump_id = ?
                     AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),
            // 3. Credit sales over date range
            connection.execute(
                `SELECT COALESCE(SUM(cs.total_amount), 0) as total FROM credit_sales cs
                INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND cs.Active = 1`,
                [pumpId, dateFrom, dateTo]
            ),
            // 4. Bank transfers over date range
            connection.execute(
                `SELECT COALESCE(SUM(cob.amount), 0) as total FROM cash_outflow_bank cob
                INNER JOIN cash_management cm ON cob.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            )
        ]);

        // =============================================
        // BATCH 2: Cash Outflow and Expense Queries
        // =============================================
        const [
            cashOutflowNetResult,
            cashOutflowOwnerResult,
            expensesResult,
            staffSalaryResult
        ] = await Promise.all([
            // 5. Cash outflow Net over date range
            connection.execute(
                `SELECT COALESCE(SUM(con.amount), 0) as total FROM cash_outflow_net con
                INNER JOIN cash_management cm ON con.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),
            // 6. Cash outflow Owner over date range
            connection.execute(
                `SELECT COALESCE(SUM(coo.amount), 0) as total FROM cash_outflow_owner coo
                INNER JOIN cash_management cm ON coo.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?`,
                [pumpId, dateFrom, dateTo]
            ),
            // 7. Expenses over date range
            connection.execute(
                `SELECT COALESCE(SUM(de.amount), 0) as total FROM daily_expenses de
                INNER JOIN cash_management cm ON de.cash_management_id = cm.id AND cm.Active = 1
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND de.Active = 1`,
                [pumpId, dateFrom, dateTo]
            ),
            // 20. Staff advance credit over date range
            connection.execute(
                `SELECT COALESCE(SUM(sas.debit), 0) as total
                FROM staff_advance_salary sas
                INNER JOIN cash_management cm ON sas.cash_management_id = cm.id
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ?
                AND DATE(dse.entry_date) BETWEEN ? AND ?
                AND sas.Active = 1`,
                [pumpId, dateFrom, dateTo]
            )
        ]);

        // =============================================
        // BATCH 3: Cash and Dues Queries
        // =============================================
        const [
            cashInHandResult,
            outstandingDuesResult,
            outstandingDuesCountResult,
            outstandingDuesListResult,
            pumpadvance,
        ] = await Promise.all([
            // 8. Cash in hand and previous day cash
            connection.execute(
                `SELECT cm.final_cash_in_hand, cm.cash_from_previous_day FROM cash_management cm
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ?
                ORDER BY dse.entry_date DESC LIMIT 1`,
                [pumpId, dateFrom, dateTo]
            ),
            // 9. Outstanding dues total
            connection.execute(
                `
    WITH customer_list AS (
        SELECT DISTINCT 
            'local' AS customer_type,
            cs.fuel_station_customer_id AS customer_id
        FROM credit_sales cs
        JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id 
            AND dse.Active = 1
            AND dse.pump_id = ?
        WHERE cs.Active = 1 
            AND cs.fuel_station_customer_id IS NOT NULL
            AND dse.entry_date BETWEEN ? AND ?
        
        UNION
        
        SELECT DISTINCT 
            'ws' AS customer_type,
            cs.ws_customer_id AS customer_id
        FROM credit_sales cs
        JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id 
            AND dse.Active = 1
            AND dse.pump_id = ?
        WHERE cs.Active = 1 
            AND cs.ws_customer_id IS NOT NULL
            AND dse.entry_date BETWEEN ? AND ?
    ),

    credit_sales_totals AS (
        SELECT 
            'local' AS customer_type,
            cs.fuel_station_customer_id AS customer_id,
            SUM(cs.total_amount) AS total_sales
        FROM credit_sales cs
        JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id 
            AND dse.Active = 1
            AND dse.pump_id = ?
        WHERE cs.Active = 1 
            AND cs.fuel_station_customer_id IS NOT NULL
            AND dse.entry_date BETWEEN ? AND ?
        GROUP BY cs.fuel_station_customer_id
        
        UNION ALL
        
        SELECT 
            'ws' AS customer_type,
            cs.ws_customer_id AS customer_id,
            SUM(cs.total_amount) AS total_sales
        FROM credit_sales cs
        JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id 
            AND dse.Active = 1
            AND dse.pump_id = ?
        WHERE cs.Active = 1 
            AND cs.ws_customer_id IS NOT NULL
            AND dse.entry_date BETWEEN ? AND ?
        GROUP BY cs.ws_customer_id
    ),

    local_ledger AS (
        SELECT 
            customer_id,
            SUM(debit) AS total_debit,
            SUM(credit) AS total_credit
        FROM customer_ledger
        WHERE Active = 1
        GROUP BY customer_id
    ),

    ws_previous_dues AS (
        SELECT 
            id AS customer_id,
            Previous_Dues AS previous_dues
        FROM customers
        WHERE active = 1
    ),

    ws_sales AS (
        SELECT 
            client_id AS customer_id,
            SUM(total_amount) AS total_sales
        FROM pol_sale
        WHERE Active = 1
        GROUP BY client_id
    ),

    ws_recoveries AS (
        SELECT 
            ws_customer_id AS customer_id,
            SUM(amount) AS total_recovered
        FROM fuel_station_customer_recoveries
        WHERE Active = 1 
            AND station_id = ?
            AND ws_customer_id IS NOT NULL
        GROUP BY ws_customer_id
    ),

    customer_dues AS (
        SELECT 
            cl.customer_type,
            cl.customer_id,
            
            CASE 
                WHEN cl.customer_type = 'local' THEN
                    COALESCE(cs.total_sales, 0) + COALESCE(ll.total_debit, 0) - COALESCE(ll.total_credit, 0)
                
                ELSE
                    COALESCE(wpd.previous_dues, 0)
                    + GREATEST(0, 
                        COALESCE(ws.total_sales, 0) - 
                        GREATEST(0, COALESCE(wr.total_recovered, 0) - COALESCE(wpd.previous_dues, 0))
                    )
                    + COALESCE(cs.total_sales, 0)
            END AS customer_due
            
        FROM customer_list cl
        
        LEFT JOIN credit_sales_totals cs 
            ON cl.customer_id = cs.customer_id 
            AND cl.customer_type = cs.customer_type
        
        LEFT JOIN local_ledger ll 
            ON cl.customer_id = ll.customer_id 
            AND cl.customer_type = 'local'
        
        LEFT JOIN ws_previous_dues wpd 
            ON cl.customer_id = wpd.customer_id 
            AND cl.customer_type = 'ws'
        
        LEFT JOIN ws_sales ws 
            ON cl.customer_id = ws.customer_id 
            AND cl.customer_type = 'ws'
        
        LEFT JOIN ws_recoveries wr 
            ON cl.customer_id = wr.customer_id 
            AND cl.customer_type = 'ws'
    )

    SELECT 
        COALESCE(SUM(GREATEST(customer_due, 0)), 0) AS total_due
    FROM customer_dues
    `,
                [
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId
                ]
            ),
            // 10. Outstanding dues count
            connection.execute(
                `SELECT COUNT(*) AS cnt
                FROM (
                    SELECT
                        base.customer_type,
                        base.customer_id,
                        GREATEST(
                            CASE
                                WHEN base.customer_type = 'local'
                                    THEN COALESCE(cs.credit_sales_total, 0) + COALESCE(cl.debit_total, 0) - COALESCE(cl.credit_total, 0)
                                ELSE (
                                    COALESCE(wc.previous_dues, 0) +
                                    GREATEST(
                                        0,
                                        COALESCE(ws_sales.total_sales_amount, 0) -
                                        GREATEST(0, COALESCE(ws_recovery.total_recovery, 0) - COALESCE(wc.previous_dues, 0))
                                    ) +
                                    COALESCE(cs.credit_sales_total, 0)
                                )
                            END,
                            0
                        ) AS customer_due
                    FROM (
                        SELECT DISTINCT 'local' AS customer_type, cs.fuel_station_customer_id AS customer_id
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ? 
                            AND cs.Active = 1 
                            AND cs.fuel_station_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        
                        UNION
                        
                        SELECT DISTINCT 'ws' AS customer_type, cs.ws_customer_id AS customer_id
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ? 
                            AND cs.Active = 1 
                            AND cs.ws_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                    ) base
                    
                    LEFT JOIN (
                        SELECT
                            'local' AS customer_type,
                            cs.fuel_station_customer_id AS customer_id,
                            COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ? 
                            AND cs.Active = 1 
                            AND cs.fuel_station_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        GROUP BY cs.fuel_station_customer_id
                        
                        UNION ALL
                        
                        SELECT
                            'ws' AS customer_type,
                            cs.ws_customer_id AS customer_id,
                            COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ? 
                            AND cs.Active = 1 
                            AND cs.ws_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        GROUP BY cs.ws_customer_id
                    ) cs ON base.customer_id = cs.customer_id AND base.customer_type = cs.customer_type
                    
                    LEFT JOIN (
                        SELECT
                            c.id AS customer_id,
                            COALESCE(c.Previous_Dues, 0) AS previous_dues
                        FROM customers c
                        WHERE c.active = 1
                    ) wc ON base.customer_id = wc.customer_id AND base.customer_type = 'ws'
                    
                    LEFT JOIN (
                        SELECT
                            ps.client_id AS customer_id,
                            COALESCE(SUM(ps.total_amount), 0) AS total_sales_amount
                        FROM pol_sale ps
                        WHERE ps.Active = 1
                        GROUP BY ps.client_id
                    ) ws_sales ON base.customer_id = ws_sales.customer_id AND base.customer_type = 'ws'
                    
                    LEFT JOIN (
                        SELECT
                            customer_id,
                            COALESCE(SUM(debit), 0) AS debit_total,
                            COALESCE(SUM(credit), 0) AS credit_total
                        FROM customer_ledger
                        WHERE Active = 1
                        GROUP BY customer_id
                    ) cl ON base.customer_id = cl.customer_id AND base.customer_type = 'local'
                    
                    LEFT JOIN (
                        SELECT
                            fscr.ws_customer_id AS customer_id,
                            COALESCE(SUM(fscr.amount), 0) AS total_recovery
                        FROM fuel_station_customer_recoveries fscr
                        WHERE fscr.Active = 1
                            AND fscr.station_id = ?
                            AND fscr.ws_customer_id IS NOT NULL
                        GROUP BY fscr.ws_customer_id
                    ) ws_recovery ON base.customer_id = ws_recovery.customer_id AND base.customer_type = 'ws'
                ) dues
                WHERE customer_due > 0`,
                [
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId
                ]
            ),
            // 11. Outstanding dues customer list
            connection.execute(
                ` SELECT 
                        base.customer_type,
                        base.customer_id,
                        COALESCE(
                            CASE 
                                WHEN base.customer_type = 'local' THEN fsc.customer_name
                                WHEN base.customer_type = 'ws' THEN COALESCE(wc.name, pp.name, 'Unknown')
                                ELSE NULL
                            END, 
                            'Unknown'
                        ) AS customer_name,
                        COALESCE(
                            CASE 
                                WHEN base.customer_type = 'local' THEN fsc.phone_number
                                WHEN base.customer_type = 'ws' THEN COALESCE(wc.phone, 'Not Available')
                                ELSE NULL
                            END, 
                            ''
                        ) AS customer_phone,
                        GREATEST(
                            CASE
                                WHEN base.customer_type = 'local'
                                    THEN COALESCE(cs.credit_sales_total, 0) + COALESCE(cl.debit_total, 0) - COALESCE(cl.credit_total, 0)
                                ELSE (
                                    COALESCE(COALESCE(wc.Previous_Dues, pp.previous_dues, 0), 0) +
                                    GREATEST(
                                        0,
                                        COALESCE(ws_sales.total_sales_amount, 0) -
                                        GREATEST(0, COALESCE(ws_recovery.total_recovery, 0) - COALESCE(COALESCE(wc.Previous_Dues, pp.previous_dues, 0), 0))
                                    ) +
                                    COALESCE(cs.credit_sales_total, 0)
                                )
                            END,
                            0
                        ) AS remaining_amount,
                        cs.first_credit_date AS due_since,
                        COALESCE(
                            CASE 
                                WHEN base.customer_type = 'local' THEN lp.last_payment_amount
                                ELSE ws_recovery.last_recovery_amount
                            END, 
                            0
                        ) AS last_payment,
                        CASE 
                            WHEN base.customer_type = 'local' THEN NULL
                            ELSE ws_recovery.last_recovery_date
                        END AS recovery_date,
                        COALESCE(
                            CASE 
                                WHEN base.customer_type = 'local' THEN lp.last_payment_amount
                                ELSE ws_recovery.last_recovery_amount
                            END, 
                            0
                        ) AS recovery_last_amount,
                        DATEDIFF(CURDATE(), cs.first_credit_date) AS due_since_days
                    FROM (
                        SELECT DISTINCT 'local' AS customer_type, cs.fuel_station_customer_id AS customer_id
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ?
                            AND cs.Active = 1 
                            AND cs.fuel_station_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        
                        UNION
                        
                        SELECT DISTINCT 'ws' AS customer_type, cs.ws_customer_id AS customer_id
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ?
                            AND cs.Active = 1 
                            AND cs.ws_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                    ) base
                    
                    LEFT JOIN fuel_station_customer fsc 
                        ON base.customer_id = fsc.customer_id 
                        AND fsc.Active = 1 
                        AND base.customer_type = 'local'
                    
                    LEFT JOIN customers wc 
                        ON base.customer_id = wc.id 
                        AND base.customer_type = 'ws'
                    
                    LEFT JOIN petrol_pumps pp 
                        ON base.customer_id = pp.id 
                        AND pp.Active = 1 
                        AND base.customer_type = 'ws'
                    
                    LEFT JOIN (
                        SELECT
                            'local' AS customer_type,
                            cs.fuel_station_customer_id AS customer_id,
                            COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total,
                            MIN(DATE(dse.entry_date)) AS first_credit_date
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ?
                            AND cs.Active = 1 
                            AND cs.fuel_station_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        GROUP BY cs.fuel_station_customer_id
                        
                        UNION ALL
                        
                        SELECT
                            'ws' AS customer_type,
                            cs.ws_customer_id AS customer_id,
                            COALESCE(SUM(cs.total_amount), 0) AS credit_sales_total,
                            MIN(DATE(dse.entry_date)) AS first_credit_date
                        FROM credit_sales cs
                        INNER JOIN daily_sales_entries dse ON cs.daily_entry_id = dse.id AND dse.Active = 1
                        WHERE dse.pump_id = ?
                            AND cs.Active = 1 
                            AND cs.ws_customer_id IS NOT NULL
                            AND DATE(dse.entry_date) BETWEEN ? AND ?
                        GROUP BY cs.ws_customer_id
                    ) cs ON base.customer_id = cs.customer_id AND base.customer_type = cs.customer_type
                    
                    LEFT JOIN (
                        SELECT
                            ps.client_id AS customer_id,
                            COALESCE(SUM(ps.total_amount), 0) AS total_sales_amount
                        FROM pol_sale ps
                        WHERE ps.Active = 1
                        GROUP BY ps.client_id
                    ) ws_sales ON base.customer_id = ws_sales.customer_id AND base.customer_type = 'ws'
                    
                    LEFT JOIN (
                        SELECT
                            cl.customer_id,
                            COALESCE(SUM(cl.debit), 0) AS debit_total,
                            COALESCE(SUM(cl.credit), 0) AS credit_total
                        FROM customer_ledger cl
                        WHERE cl.Active = 1
                        GROUP BY cl.customer_id
                    ) cl ON base.customer_id = cl.customer_id AND base.customer_type = 'local'
                    
                    LEFT JOIN (
                        SELECT
                            fscr.ws_customer_id AS customer_id,
                            COALESCE(SUM(fscr.amount), 0) AS total_recovery,
                            MAX(fscr.amount) AS last_recovery_amount,
                            MAX(fscr.recovery_date) AS last_recovery_date
                        FROM fuel_station_customer_recoveries fscr
                        WHERE fscr.Active = 1
                            AND fscr.station_id = ?
                            AND fscr.ws_customer_id IS NOT NULL
                        GROUP BY fscr.ws_customer_id
                    ) ws_recovery ON base.customer_id = ws_recovery.customer_id AND base.customer_type = 'ws'
                    
                    LEFT JOIN (
                        SELECT
                            customer_id,
                            MAX(credit) AS last_payment_amount
                        FROM customer_ledger
                        WHERE Active = 1 AND credit > 0
                        GROUP BY customer_id
                    ) lp ON base.customer_id = lp.customer_id AND base.customer_type = 'local'
                    
                    WHERE GREATEST(
                        CASE
                            WHEN base.customer_type = 'local'
                                THEN COALESCE(cs.credit_sales_total, 0) + COALESCE(cl.debit_total, 0) - COALESCE(cl.credit_total, 0)
                            ELSE (
                                COALESCE(COALESCE(wc.Previous_Dues, pp.previous_dues, 0), 0) +
                                GREATEST(
                                    0,
                                    COALESCE(ws_sales.total_sales_amount, 0) -
                                    GREATEST(0, COALESCE(ws_recovery.total_recovery, 0) - COALESCE(COALESCE(wc.Previous_Dues, pp.previous_dues, 0), 0))
                                ) +
                                COALESCE(cs.credit_sales_total, 0)
                            )
                        END,
                        0
                    ) > 0
                    ORDER BY remaining_amount DESC
                    `,
                [
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId, dateFrom, dateTo,
                    pumpId
                ]
            ),
            connection.execute(
                `SELECT 
            pa.id,
            pa.cash_management_id,
            pa.amount as pump_advance,
            pa.pump_id,
            pa.reference_name,
            pa.purpose,
            pa.CB,
            pa.MB,
            pa.CD,
            pa.MD,
            pa.Active,
            dse.entry_date,
            dse.id as daily_entry_id
        FROM pump_advance pa
        INNER JOIN cash_management cm ON pa.cash_management_id = cm.id AND cm.Active = 1
        INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
        WHERE pa.pump_id = ? 
            AND DATE(dse.entry_date) BETWEEN ? AND ?
            AND pa.Active = 1
        ORDER BY dse.entry_date DESC, pa.id DESC`,
                [pumpId, dateFrom, dateTo]
            )
        ]);

        // =============================================
        // BATCH 4: Customer and Stock Queries
        // =============================================
        const [
            customerRecoveriesListResult,
            fuelStockResult,
            tankSalesBreakdownResult
        ] = await Promise.all([
            // 12. Customer recoveries list
            connection.execute(
                `SELECT
                    agg.customer_type,
                    agg.customerId,
                    CASE
                        WHEN agg.customer_type = 'ws'
                            THEN COALESCE(wc.name, CONCAT('Customer #', agg.customerId))
                        ELSE COALESCE(fsc.customer_name, CONCAT('Customer #', agg.customerId))
                    END AS customer_name,
                    agg.remaining_amount,
                    NULL AS due_since,
                    0 AS last_payment,
                    agg.recovery_last_amount,
                    agg.recovery_date
                 FROM (
                     SELECT
                         CASE
                             WHEN fscr.ws_customer_id IS NOT NULL THEN 'ws'
                             ELSE 'local'
                         END AS customer_type,
                         COALESCE(fscr.ws_customer_id, fscr.customer_id) AS customerId,
                         COALESCE(SUM(fscr.amount), 0) AS remaining_amount,
                         MAX(fscr.amount) AS recovery_last_amount,
                         MAX(DATE(fscr.recovery_date)) AS recovery_date
                     FROM fuel_station_customer_recoveries fscr
                     WHERE fscr.Active = 1
                       AND fscr.station_id = ?
                       AND DATE(fscr.recovery_date) BETWEEN ? AND ?
                       AND (fscr.customer_id IS NOT NULL OR fscr.ws_customer_id IS NOT NULL)
                     GROUP BY
                         CASE
                             WHEN fscr.ws_customer_id IS NOT NULL THEN 'ws'
                             ELSE 'local'
                         END,
                         COALESCE(fscr.ws_customer_id, fscr.customer_id)
                 ) agg
                 LEFT JOIN fuel_station_customer fsc
                        ON agg.customer_type = 'local'
                       AND agg.customerId = fsc.customer_id
                       AND fsc.Active = 1
                 LEFT JOIN customers wc
                        ON agg.customer_type = 'ws'
                       AND agg.customerId = wc.id
                       AND wc.active = 1
                 ORDER BY agg.remaining_amount DESC, agg.recovery_date DESC
                 LIMIT 15`,
                [pumpId, dateFrom, dateTo]
            ),
            // 15. Fuel stock
            connection.execute(
                `SELECT DISTINCT
                    ft.id AS tank_id,
                    ft.tank_number,
                    ft.fuel_type,
                    ft.current_level,
                    ft.capacity,
                    ft.low_alert_level,
                    COALESCE((
                        SELECT dti.opening_level
                        FROM daily_tank_inventory dti
                        INNER JOIN daily_sales_entries dse ON dse.id = dti.daily_entry_id AND dse.Active = 1
                        WHERE dti.Active = 1
                          AND dti.tank_id = ft.id
                          AND DATE(dse.entry_date) BETWEEN ? AND ?
                        ORDER BY dse.entry_date DESC, dti.id DESC
                        LIMIT 1
                    ), 0) AS old_stock,
                    CASE
                        WHEN LOWER(COALESCE(ft.fuel_type, '')) LIKE '%mobile%'
                            OR LOWER(COALESCE(ft.fuel_type, '')) LIKE '%oil%'
                        THEN COALESCE((
                                SELECT SUM(mop.liters_purchased)
                                FROM mobile_oil_purchase mop
                                WHERE (mop.active = 1 OR mop.active IS NULL)
                                    AND mop.pump_id = ft.pump_id
                                    AND DATE(mop.cd) BETWEEN ? AND ?
                        ), 0)
                        ELSE COALESCE((
                                SELECT SUM(fu.liters_unloaded)
                                FROM fuel_unload fu
                                WHERE fu.Active = 1
                                    AND fu.fuel_tank_id = ft.id
                                    AND DATE(fu.CD) BETWEEN ? AND ?
                        ), 0)
                    END AS supply_purchased,
                    COALESCE((
                            SELECT SUM(nr.total_sold)
                            FROM nozzle_readings nr
                            INNER JOIN nozzles n ON n.id = nr.nozzle_id
                            INNER JOIN daily_sales_entries dse ON dse.id = nr.daily_entry_id AND dse.Active = 1
                            WHERE nr.Active = 1
                                AND n.tank_id = ft.id
                                AND DATE(dse.entry_date) BETWEEN ? AND ?
                    ), 0) AS sold_liters,
                    COALESCE((
                            SELECT SUM(tr.liters_returned)
                            FROM tank_returns tr
                            INNER JOIN daily_sales_entries dse ON dse.id = tr.daily_entry_id AND dse.Active = 1
                            WHERE tr.Active = 1
                                AND tr.fuel_tank_id = ft.id
                                AND dse.pump_id = ?
                                AND DATE(dse.entry_date) BETWEEN ? AND ?
                    ), 0) AS returned_liters,
                    COALESCE((
                        SELECT pdr.volume_liters
                        FROM physical_dip_readings pdr
                        WHERE pdr.Active = 1
                          AND pdr.tank_id = ft.id
                          AND DATE(COALESCE(pdr.reading_time, pdr.CD)) BETWEEN ? AND ?
                        ORDER BY COALESCE(pdr.reading_time, pdr.CD) DESC, pdr.id DESC
                        LIMIT 1
                    ), 0) AS dip_stock,
                    COALESCE((
                    SELECT fta.adjustment_value
                    FROM fuel_tank_adjustments fta
                    WHERE fta.tank_id = ft.id
                    AND fta.Active = 1
                    ORDER BY fta.CD DESC
                    LIMIT 1
                ), 0) AS last_adjustment
                FROM fuel_tanks ft
                LEFT JOIN nozzles n ON n.tank_id = ft.id AND n.Active = 1
                WHERE ft.pump_id = ? AND ft.Active = 1
                ORDER BY ft.fuel_type, ft.tank_number, ft.id`,
                [dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, pumpId, dateFrom, dateTo, dateFrom, dateTo, pumpId]
            ),
            // 17. Tank-wise sold liters
            connection.execute(
                `
                SELECT
                    ft.id AS tank_id,
                    ft.fuel_type,
                    ft.tank_number,
                    COALESCE(SUM(nr.total_sold), 0) AS sold_liters
                FROM fuel_tanks ft
                INNER JOIN nozzles n ON n.tank_id = ft.id AND n.Active = 1
                INNER JOIN nozzle_readings nr ON nr.nozzle_id = n.id AND nr.Active = 1
                INNER JOIN daily_sales_entries dse ON dse.id = nr.daily_entry_id 
                    AND dse.Active = 1 
                    AND dse.pump_id = ?
                    AND DATE(dse.entry_date) BETWEEN ? AND ?
                WHERE ft.pump_id = ?
                    AND ft.Active = 1
                    AND ft.fuel_type NOT IN ('Mobile Oil', 'mobile oil')
                GROUP BY ft.id, ft.fuel_type, ft.tank_number
                ORDER BY ft.fuel_type, ft.tank_number, ft.id
                `,
                [pumpId, dateFrom, dateTo, pumpId]
            )
        ]);

        // =============================================
        // BATCH 5: Sales and Trend Queries
        // =============================================
        const [
            dailyExpensesBreakdownResult,
            dailyExpensesDetailResult,
            salesByFuelTypeResult,
            weeklyTrendResult
        ] = await Promise.all([
            // 13. Daily expenses breakdown by category
            connection.execute(
                `SELECT COALESCE(ec.name, 'Other') as expense_category_name, SUM(de.amount) as amount
                FROM daily_expenses de
                INNER JOIN cash_management cm ON de.cash_management_id = cm.id AND cm.Active = 1
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                LEFT JOIN expense_categories ec ON de.expense_category = ec.id
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND de.Active = 1
                GROUP BY de.expense_category, ec.name
                ORDER BY amount DESC`,
                [pumpId, dateFrom, dateTo]
            ),
            // 14. Daily expenses detail
            connection.execute(
                `SELECT COALESCE(ec.name, 'Other') as expense_category_name, de.amount, de.description, DATE(dse.entry_date) as entry_date
                FROM daily_expenses de
                INNER JOIN cash_management cm ON de.cash_management_id = cm.id AND cm.Active = 1
                INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
                LEFT JOIN expense_categories ec ON de.expense_category = ec.id
                WHERE dse.pump_id = ? AND DATE(dse.entry_date) BETWEEN ? AND ? AND de.Active = 1
                ORDER BY dse.entry_date DESC, de.id DESC`,
                [pumpId, dateFrom, dateTo]
            ),
            // 16. Sales by fuel type
            connection.execute(
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
            // 18. Weekly trend
            connection.execute(
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
            )
        ]);

        // =============================================
        // BATCH 6: Nozzle and Unload Queries
        // =============================================
        const [
            nozzleReadingsResult,
            unloadNotificationsResult
        ] = await Promise.all([
            // 19. Latest nozzle readings
            connection.execute(
                `SELECT
                    nr.nozzle_id,
                    nr.opening_digital_reading,
                    nr.closing_digital_reading,
                    nr.opening_mechanical_reading,
                    nr.closing_mechanical_reading
                 FROM nozzle_readings nr
                 INNER JOIN nozzles n ON n.id = nr.nozzle_id
                 INNER JOIN machines m ON m.id = n.machine_id
                 INNER JOIN (
                    SELECT
                        nr2.nozzle_id,
                        MAX(nr2.daily_entry_id) AS latest_daily_entry_id
                    FROM nozzle_readings nr2
                    INNER JOIN nozzles n2 ON n2.id = nr2.nozzle_id
                    INNER JOIN machines m2 ON m2.id = n2.machine_id
                    INNER JOIN daily_sales_entries dse2 ON dse2.id = nr2.daily_entry_id AND dse2.Active = 1
                    WHERE nr2.Active = 1
                      AND m2.pump_id = ?
                    GROUP BY nr2.nozzle_id
                 ) latest ON latest.nozzle_id = nr.nozzle_id
                        AND latest.latest_daily_entry_id = nr.daily_entry_id
                 WHERE nr.Active = 1
                   AND m.pump_id = ?`,
                [pumpId, pumpId]
            ),
            // 21. Self-customer sales that should be unloaded
            connection.execute(
                `SELECT
                    fp.id,
                    COALESCE(fp.fuel_type, 'Fuel') as fuel_type,
                    fp.purchase_reference as trip_ref,
                    GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) as liters_remaining
                FROM fuel_purchased fp
                LEFT JOIN (
                    SELECT fuel_purchase_id, COALESCE(SUM(liters_unloaded), 0) as total_unloaded
                    FROM fuel_unload
                    WHERE Active = 1
                    GROUP BY fuel_purchase_id
                ) fu ON fu.fuel_purchase_id = fp.id
                WHERE fp.Active = 1
                    AND EXISTS (
                            SELECT 1
                            FROM trips t
                            INNER JOIN pol_sale ps ON ps.trip_id = t.id AND ps.Active = 1
                        WHERE CONCAT('Trip#', t.trip_no) COLLATE utf8mb4_unicode_ci = fp.purchase_reference COLLATE utf8mb4_unicode_ci
                                AND ps.client_id = ?
                                AND DATE(ps.date) BETWEEN ? AND ?
                    )
                    AND GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) > 0
                ORDER BY fp.id DESC
                LIMIT 50`,
                [pumpId, dateFrom, dateTo]
            )
        ]);

        // =============================================
        // Process all results
        // =============================================
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
        const staffSalary = (staffSalaryResult[0] && staffSalaryResult[0][0] && parseFloat(staffSalaryResult[0][0].total)) || 0;

        const cashInHandRow = cashInHandResult[0] && cashInHandResult[0][0] ? cashInHandResult[0][0] : {};
        const cashInHand = parseFloat(cashInHandRow.final_cash_in_hand) || 0;
        const previousDayCash = parseFloat(cashInHandRow.cash_from_previous_day) || 0;
        const pumpadvances = (pumpadvance[0] || []).reduce((sum, row) => sum + (parseFloat(row.pump_advance) || 0), 0);

        console.log('pumpadvances: ' + pumpadvances);

        const outstandingDues = (outstandingDuesResult[0] && outstandingDuesResult[0][0] && parseFloat(outstandingDuesResult[0][0].total_due)) || 0;
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

        const customerRecoveriesList = (customerRecoveriesListResult[0] || []).map(row => ({
            customerId: row.customerId,
            customer_name: row.customer_name || 'Unknown',
            remaining_amount: parseFloat(row.remaining_amount) || 0,
            due_since: row.due_since,
            last_payment: parseFloat(row.last_payment) || 0,
            recovery_last_amount: parseFloat(row.recovery_last_amount) || 0,
            recovery_date: row.recovery_date
        }));

        const customerRecoveries = customerRecoveriesList.reduce((sum, row) => sum + (Number(row.remaining_amount) || 0), 0);

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

        const unloadNotifications = (unloadNotificationsResult && unloadNotificationsResult[0])
            ? unloadNotificationsResult[0].map((row) => ({
                title: `Unload ${row.fuel_type || 'Fuel'} to tank`,
                detail: `${Math.round((parseFloat(row.liters_remaining) || 0) * 100) / 100}L pending for ${row.trip_ref || 'reference'}`
            }))
            : [];

        const fuelStock = (fuelStockResult[0] || []).map(row => {
            const newStock = parseFloat(row.current_level) || 0;
            const dipStock = parseFloat(row.dip_stock) || 0;
            const lowAlertLevel = parseFloat(row.low_alert_level) || 0;
            return {
                tank_id: row.tank_id,
                tank_number: row.tank_number,
                fuel_type: row.fuel_type || 'N/A',
                old_stock: parseFloat(row.old_stock) || 0,
                supply_purchased: parseFloat(row.supply_purchased) || 0,
                sold_liters: parseFloat(row.sold_liters) || 0,
                returned_liters: parseFloat(row.returned_liters) || 0,
                new_stock: newStock,
                dip_stock: dipStock,
                variance: Math.round((dipStock - newStock) * 100) / 100,
                current_level: newStock,
                capacity: parseFloat(row.capacity) || 0,
                is_low_level: newStock <= lowAlertLevel,
                alert_status: newStock <= lowAlertLevel ? 'Low Level Alert' : 'Normal',
                last_adjustment: parseFloat(row.last_adjustment) || 0
            };
        });

        const salesByFuelType = (salesByFuelTypeResult[0] || []).map(row => ({
            fuel_type: row.fuel_type || 'N/A',
            total_sales: parseFloat(row.total_sales) || 0
        }));

        const tankSalesBreakdown = (tankSalesBreakdownResult[0] || []).map(row => {
            const tankNumber = row.tank_number != null ? row.tank_number : row.tank_id;
            return {
                tank_id: row.tank_id,
                tank_name: `${row.fuel_type || 'Fuel'} Tank ${tankNumber}`,
                fuel_type: row.fuel_type || 'N/A',
                sold_liters: Math.round((parseFloat(row.sold_liters) || 0) * 100) / 100
            };
        });

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
            pumpAdvance: Math.round(pumpadvances * 100) / 100,
            outstandingDues: Math.round(outstandingDues * 100) / 100,
            outstandingDuesCount,
            outstandingDuesList,
            customerRecoveries: Math.round(customerRecoveries * 100) / 100,
            customerRecoveriesList,
            dailyExpensesBreakdown,
            dailyExpensesDetail,
            staffSalary: Math.round(staffSalary * 100) / 100,
            fuelStock,
            salesByFuelType,
            tankSalesBreakdown,
            weeklyTrend,
            unloadNotifications
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
                weeklyTrend: [],
                unloadNotifications: []
            });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    } finally {
        if (connection) connection.release();
    }

};
