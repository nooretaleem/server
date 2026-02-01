const db = require('../models/db');


exports.getProjectsCombo = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT project_id as id,project_name as name from projects');
        //console.log(rows); // check if rows is coming from the database
        const project = rows.map(row => ({
            id: row.id,
            name: row.name,

        }));
        res.json(project);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
}

exports.getProjectTypes = async (req, res) => {
    try {
        const type = req.query.type;
        const [rows] = await db.execute('SELECT id,type from projecttypes');
        //console.log(rows); // check if rows is coming from the database
        const projects = rows.map(row => ({
            id: row.id,
            type: row.type,

        }));
        // Get cost data for each project and add it to the project object
        for (const project of projects) {
            const cost = await getProjectCost(project.id);
            project.totalcost = Number(project.totalcost) + Number(cost[0].totalcost); // Assuming it's a single value
        }
        res.json(projects);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};
exports.getUserProjects = async (req, res) => {
    try {
        const type = req.query.type;
        const userid = req.query.userid;
        const [rows] = await db.execute('SELECT prj.project_id as id,prj.project_name,prj.project_description,prj.budget, ' +
            ' prj.start_date,prj.end_date, prj.status,prj.landcost,prj.taxes,prj.commission,prj.notes, prj.coveredarea,' +
            ' loc.id as loc_id, loc.name as location, prj.status as status FROM ' +
            ' `projects` AS prj ' +
            ' INNER JOIN `locations` as loc ON prj.location_id=loc.id' +
            ' INNER JOIN `userprojects` as up ON up.projectid=prj.project_id' +
            ' where prj.type=' + type + ' and up.userid=' + userid);
        //console.log(rows); // check if rows is coming from the database
        const projects = rows.map(row => ({
            id: row.id,
            project_name: row.project_name,
            description: row.project_description,
            budget: row.budget,
            loc_id: row.loc_id,
            location: row.location,
            startdate: row.start_date,
            enddate: row.end_date,
            status: row.status,
            landcost: row.landcost,
            commission: row.commission,
            taxes: row.taxes,
            notes: row.notes,
            coveredarea: row.coveredarea,
            totalcost: Number(row.landcost) + Number(row.commission) + Number(row.taxes)


        }));
        // Get cost data for each project and add it to the project object
        for (const project of projects) {
            const cost = await getProjectCost(project.id);
            project.totalcost = Number(project.totalcost) + Number(cost[0].totalcost); // Assuming it's a single value
        }
        console.log(projects);
        res.json(projects);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};


exports.getProjDetails = async (req, res) => {
    try {
        const id = req.query.id;
        const [rows] = await db.execute('SELECT prj.project_id as id,prj.project_name,prj.project_description,prj.budget, ' +
            ' prj.start_date,prj.end_date, prj.status,prj.landcost,prj.taxes,prj.commission,prj.notes, prj.coveredarea,' +
            ' loc.id as loc_id, loc.name as location, prj.status as status FROM ' +
            ' `projects` AS prj ' +
            ' INNER JOIN `locations` as loc ON prj.location_id=loc.id' +
            ' where prj.project_id=' + id);
        //console.log(rows); // check if rows is coming from the database
        const projects = rows.map(row => ({
            id: row.id,
            project_name: row.project_name,
            description: row.project_description,
            budget: row.budget,
            loc_id: row.loc_id,
            location: row.location,
            startdate: row.start_date,
            enddate: row.end_date,
            status: row.status,
            landcost: row.landcost,
            commission: row.commission,
            taxes: row.taxes,
            notes: row.notes,
            coveredarea: row.coveredarea,
            totalcost: Number(row.landcost) + Number(row.commission) + Number(row.taxes)


        }));
        // Get cost data for each project and add it to the project object
        for (const project of projects) {
            const cost = await getProjectCost(project.id);
            project.totalcost = Number(project.totalcost) + Number(cost[0].totalcost); // Assuming it's a single value
        }
        res.json(projects);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};
exports.getAllProjects = async (req, res) => {
    try {
        const type = req.query.type;
        const [rows] = await db.execute('SELECT prj.project_id as id,prj.project_name,prj.project_description,prj.budget, ' +
            ' prj.start_date,prj.end_date, prj.status,prj.landcost,prj.taxes,prj.commission,prj.notes, prj.coveredarea,' +
            ' loc.id as loc_id, loc.name as location, prj.status as status FROM ' +
            ' `projects` AS prj ' +
            ' INNER JOIN `locations` as loc ON prj.location_id=loc.id' +
            ' where prj.type=' + type);
        //console.log(rows); // check if rows is coming from the database
        const projects = rows.map(row => ({
            id: row.id,
            project_name: row.project_name,
            description: row.project_description,
            budget: row.budget,
            loc_id: row.loc_id,
            location: row.location,
            startdate: row.start_date,
            enddate: row.end_date,
            status: row.status,
            landcost: row.landcost,
            commission: row.commission,
            taxes: row.taxes,
            notes: row.notes,
            coveredarea: row.coveredarea,
            totalcost: Number(row.landcost) + Number(row.commission) + Number(row.taxes)


        }));
        // Get cost data for each project and add it to the project object
        for (const project of projects) {
            const cost = await getProjectCost(project.id);
            project.totalcost = Number(project.totalcost) + Number(cost[0].totalcost); // Assuming it's a single value
        }
        res.json(projects);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};

exports.getProjectsList = async (req, res) => {
    try {

        const [rows] = await db.execute('SELECT prj.project_id as id,prj.project_name,prj.project_description,prj.budget, ' +
            ' prj.start_date,prj.end_date, prj.status,prj.landcost,prj.taxes,prj.commission,prj.notes, prj.coveredarea,' +
            ' loc.id as loc_id, loc.name as location, prj.status as status FROM ' +
            ' `projects` AS prj ' +
            ' INNER JOIN `locations` as loc ON prj.location_id=loc.id');
        //console.log(rows); // check if rows is coming from the database
        const projects = rows.map(row => ({
            id: row.id,
            project_name: row.project_name,
            description: row.project_description,
            budget: row.budget,
            loc_id: row.loc_id,
            location: row.location,
            startdate: row.start_date,
            enddate: row.end_date,
            status: row.status,
            landcost: row.landcost,
            commission: row.commission,
            taxes: row.taxes,
            notes: row.notes,
            coveredarea: row.coveredarea,
            totalcost: Number(row.landcost) + Number(row.commission) + Number(row.taxes)


        }));
        // Get cost data for each project and add it to the project object
        for (const project of projects) {
            const cost = await getProjectCost(project.id);
            project.totalcost = Number(project.totalcost) + Number(cost[0].totalcost); // Assuming it's a single value
        }
        res.json(projects);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};
exports.getUsersProjects = async (req, res) => {

    try {
        const type = req.query.type;
        const userid = req.query.userid;
        const [rows_cost] = await db.execute('SELECT userprojects.id,userprojects.userid,userprojects.projectid from userprojects' +
            ' Inner Join projects on userprojects.projectid=projects.project_id' +
            ' Inner Join users on userprojects.userid=users.id' +
            ' where projects.type=' + type + ' and users.id=' + userid);

        const _temp = rows_cost.map(row => ({
            id: row.id,
            userid: row.userid,
            projectid: row.projectid,

        }));
        //console.log(_temp);
        res.json(_temp);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
}

exports.getUserAllProjects = async (req, res) => {

    try {

        const userid = req.query.userid;
        const [rows_cost] = await db.execute('SELECT userprojects.id,userprojects.userid,userprojects.projectid from userprojects' +
            ' Inner Join projects on userprojects.projectid=projects.project_id' +
            ' Inner Join users on userprojects.userid=users.id' +
            ' where users.id=' + userid);

        const _temp = rows_cost.map(row => ({
            id: row.id,
            userid: row.userid,
            projectid: row.projectid,

        }));
        //console.log(_temp);
        res.json(_temp);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
}
async function getProjectCost(id) {
    try {
        const [rows_cost] = await db.execute('SELECT sum(cost.amount) as totalcost FROM ' +
            '`projectcost` AS cost ' +
            ' INNER JOIN `projects` as prj ON cost.project=prj.project_id' +
            ' where cost.project=' + id);

        const _temp = rows_cost.map(row => ({
            totalcost: row.totalcost
        }));

        return _temp;
    } catch (error) {
        console.error(err);
        res.status(500).json({ message: err });
    }
}

//Dashboard Functions
exports.getProjDashboard = async (req, res) => {
    try {
        // Return default values if projects table doesn't exist
        res.status(200).json({ residential: 0, commercial: 0 });
    } catch (err) {
        console.error(err);
        res.status(200).json({ residential: 0, commercial: 0 });
    }
};
exports.getPlotDashboard = async (req, res) => {
    try {
        // Return default value if plots table doesn't exist
        res.json([{ plot: 0 }]);
    } catch (err) {
        console.error(err);
        res.json([{ plot: 0 }]);
    }
};
exports. getProfitSummary = async (req, res) => {
    try {
        // Return default values if tables don't exist
        res.json({
            resprofit: 0,
            commprofit: 0,
            plotprofit: 0
        });
    } catch (err) {
        console.error(err);
        res.json({
            resprofit: 0,
            commprofit: 0,
            plotprofit: 0
        });
    }
};

exports.getInvestorSummary = async (req, res) => {
    try {
        // Return default values if investors table doesn't exist
        res.json([{
            investors: 0,
            investment: 0
        }]);
    } catch (err) {
        console.error(err);
        res.json([{
            investors: 0,
            investment: 0
        }]);
    }
};

exports.getClientInventorySummary = async (req, res) => {
    try {
        // Return default values if tables don't exist
        res.json({
            res_client: 0,
            totalunits: 0
        });
    } catch (err) {
        console.error(err);
        res.json({
            res_client: 0,
            totalunits: 0
        });
    }
};

exports.getCashSummary = async (req, res) => {
    try {
        // Return default values if tables don't exist
        res.json({
            res_bank: [],
            res_novita: 0
        });
    } catch (err) {
        console.error(err);
        res.json({
            res_bank: [],
            res_novita: 0
        });
    }
};

// Get dashboard data for new dashboard design
exports.getDashboardData = async (req, res) => {
    try {
        // 1. Get Cash in Hand Balance - calculate sum of credits minus debits for active records
        let cashInHand = 0;
        try {
            const [cashRows] = await db.execute(`
                SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
                FROM cash_in_hand
                WHERE Active = 1
            `);
            cashInHand = parseFloat(cashRows[0]?.balance || 0);
        } catch (err) {
            console.error('Error fetching cash in hand:', err);
            cashInHand = 0;
        }

        // 2. Get Total Bank Balance (sum of all account balances)
        let bankBalance = 0;
        try {
            // First, check if accounts exist and get debug info
            const [debugRows] = await db.execute(`
                SELECT COUNT(*) as total_accounts,
                       COUNT(CASE WHEN active = 1 THEN 1 END) as active_accounts,
                       COALESCE(SUM(CASE WHEN active = 1 THEN Balance ELSE 0 END), 0) as total_balance
                FROM accounts
            `);
            
            console.log('[Dashboard] Bank Balance Debug Info:', debugRows[0]);
            
            // Get the actual balance
            const [bankRows] = await db.execute(`
                SELECT COALESCE(SUM(Balance), 0) as total_balance
                FROM accounts
                WHERE active = 1
            `);
            bankBalance = parseFloat(bankRows[0]?.total_balance || 0);
            console.log('[Dashboard] Bank Balance Query Result:', {
                total_balance: bankRows[0]?.total_balance,
                parsed: bankBalance,
                rowCount: bankRows.length
            });
        } catch (err) {
            console.error('Error fetching bank balance:', err);
            console.error('Error details:', {
                message: err.message,
                code: err.code,
                sqlState: err.sqlState,
                sqlMessage: err.sqlMessage
            });
            bankBalance = 0;
        }

        // 3. Get Total Client Due (Total Sales - Total Payments)
        // Calculate per client and sum up, same as getClientDues endpoint
        let totalClientDue = 0;
        try {
            // Calculate total client due by summing (sales - recoveries) per client
            // This ensures accuracy when there are multiple clients
            const [clientDuesRows] = await db.execute(`
                SELECT 
                    c.id as client_id,
                    COALESCE(SUM(CASE WHEN ps.Active = 1 THEN ps.total_amount ELSE 0 END), 0) as total_sales,
                    COALESCE(SUM(CASE WHEN r.Active = 1 THEN r.Amount ELSE 0 END), 0) as total_recoveries,
                    (COALESCE(SUM(CASE WHEN ps.Active = 1 THEN ps.total_amount ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN r.Active = 1 THEN r.Amount ELSE 0 END), 0)) as due_amount
                FROM customers c
                LEFT JOIN pol_sale ps ON ps.client_id = c.id AND ps.Active = 1
                LEFT JOIN recoveries r ON r.ClientID = c.id AND r.Active = 1
                WHERE c.active = 1
                GROUP BY c.id
                HAVING due_amount > 0
            `);
            
            // Sum all client dues
            totalClientDue = clientDuesRows.reduce((sum, row) => {
                return sum + parseFloat(row.due_amount || 0);
            }, 0);
            
            console.log(`[Dashboard] Total Client Due calculated: ${totalClientDue} (from ${clientDuesRows.length} clients with dues)`);
        } catch (err) {
            console.error('Error fetching total client due:', err);
            totalClientDue = 0;
        }

        // 3.5. Get Total Payable to Depos (remaining balance) - only for credit purchases, exclude cash
        let totalPayableToDepos = 0;
        try {
            const [payableRows] = await db.execute(`
                SELECT COALESCE(SUM(payable_amount - COALESCE(paid_amount, 0)), 0) as total_remaining
                FROM trip_depos
                WHERE (payable_amount - COALESCE(paid_amount, 0)) > 0
                  AND purchase_type != 'cash'
                  AND Active = 1
            `);
            totalPayableToDepos = parseFloat(payableRows[0]?.total_remaining || 0);
        } catch (err) {
            console.error('Error fetching total payable to depos:', err);
            totalPayableToDepos = 0;
        }

        // 3.6. Get count of trips with credit products
        let creditTripsCount = 0;
        try {
            const [creditTripsRows] = await db.execute(`
                SELECT COUNT(DISTINCT t.id) as credit_trips_count
                FROM trips t
                INNER JOIN trip_depos td ON td.trip_id = t.id AND td.Active = 1
                WHERE td.purchase_type = 'credit'
                  AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                  AND t.active = 1
            `);
            creditTripsCount = parseInt(creditTripsRows[0]?.credit_trips_count || 0);
        } catch (err) {
            console.error('Error fetching credit trips count:', err);
            creditTripsCount = 0;
        }

        // 4. Get Depo Credit Usage
        let depoCreditUsage = [];
        try {
            // Get depo credit usage from pool table:
            // Limit = Initial DepoLimit (from first entry where TripID, recovery_id, payment_id are NULL)
            // Available = Calculate by summing all active transactions: InitialLimit + SUM(Credit) - SUM(Debit) for active entries
            // Used = Initial Limit - Available
            // This ensures correct calculation even if DepoLimit field wasn't properly maintained
            const [depoRows] = await db.execute(`
                SELECT 
                    d.id as DepoID,
                    d.name as DepoName,
                    c.name as CompanyName,
                    COALESCE((SELECT p.DepoLimit 
                              FROM pool p 
                              WHERE p.DepoID = d.id 
                                AND p.TripID IS NULL 
                                AND p.recovery_id IS NULL 
                                AND p.payment_id IS NULL 
                                AND p.active = 1 
                              ORDER BY p.ID ASC 
                              LIMIT 1), d.Balance, 0) as InitialLimit
                FROM depo d
                LEFT JOIN depo_company dc ON dc.depo_id = d.id AND dc.active = 1
                LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
                WHERE d.active = 1
                ORDER BY d.name ASC
            `);
            
            // For each depo, calculate current limit by summing all active transactions
            depoCreditUsage = await Promise.all(depoRows.map(async (row) => {
                const initialLimit = parseFloat(row.InitialLimit || 0);
                
                // Calculate current limit: InitialLimit + SUM(Credit) - SUM(Debit) for all active entries
                // This is more reliable than using DepoLimit field which might not be updated correctly
                const [currentLimitRows] = await db.execute(`
                    SELECT 
                        COALESCE(SUM(COALESCE(Credit, 0)), 0) as total_credit,
                        COALESCE(SUM(COALESCE(Debit, 0)), 0) as total_debit
                    FROM pool
                    WHERE DepoID = ? 
                      AND active = 1
                      AND NOT (TripID IS NULL AND recovery_id IS NULL AND payment_id IS NULL)
                `, [row.DepoID]);
                
                const totalCredit = parseFloat(currentLimitRows[0]?.total_credit || 0);
                const totalDebit = parseFloat(currentLimitRows[0]?.total_debit || 0);
                
                // Current limit = Initial balance + Credits (payments received) - Debits (credit purchases)
                const currentLimit = initialLimit + totalCredit - totalDebit;
                
                // Limit = Initial DepoLimit (starting balance)
                const limit = initialLimit;
                
                // Available = Current limit after all active transactions
                const available = Math.max(0, currentLimit); // Ensure non-negative
                
                // Used = Initial Limit - Available
                const used = Math.max(0, initialLimit - available);
                
                // Get advance balance from advance_balance table (latest Balance)
                const [advanceRows] = await db.execute(`
                    SELECT COALESCE(Balance, 0) as advance_balance
                    FROM advance_balance
                    WHERE DepoID = ? AND Active = 1
                    ORDER BY ID DESC
                    LIMIT 1
                `, [row.DepoID]);
                
                const advanceBalance = parseFloat(advanceRows[0]?.advance_balance || 0);
                
                // Calculate used advance balance from advance_balance table (Debit entries with TripID)
                // Sum all Debit entries in advance_balance table for active trips for this depo
                const [usedAdvanceRows] = await db.execute(`
                    SELECT COALESCE(SUM(ab.Debit), 0) as total_used_advance
                    FROM advance_balance ab
                    INNER JOIN trips tr ON ab.TripID = tr.id
                    WHERE ab.DepoID = ?
                      AND ab.Active = 1
                      AND tr.Active = 1
                      AND ab.Debit > 0
                      AND ab.TripID IS NOT NULL
                `, [row.DepoID]);
                
                const usedAdvanceBalance = parseFloat(usedAdvanceRows[0]?.total_used_advance || 0);
                const availableAdvanceBalance = Math.max(0, advanceBalance - usedAdvanceBalance);
                
                console.log(`Depo ${row.DepoID} (${row.DepoName}): InitialLimit=${initialLimit}, TotalCredit=${totalCredit}, TotalDebit=${totalDebit}, CurrentLimit=${currentLimit}, Limit=${limit}, Used=${used}, Available=${available}, AdvanceBalance=${advanceBalance}, UsedAdvance=${usedAdvanceBalance}, AvailableAdvance=${availableAdvanceBalance}`);
                
                return {
                    depo: row.DepoName || `Depo ${row.DepoID}`,
                    depo_id: row.DepoID,
                    company_name: row.CompanyName || null,
                    limit: limit,
                    used: used,
                    available: available,
                    advance_balance: advanceBalance,
                    used_advance_balance: usedAdvanceBalance,
                    available_advance_balance: availableAdvanceBalance
                };
            }));
        } catch (err) {
            console.error('Error fetching depo credit usage:', err);
            console.error('Error details:', err.message);
            console.error('Error stack:', err.stack);
            depoCreditUsage = [];
        }

        // 5. Get Trips Pending Payment > 4 Days
        // Show trips where payment is pending (total amount > paid amount) after 4 days of trip creation
        let pendingTripsCount = 0;
        try {
            const [pendingRows] = await db.execute(`
                SELECT COUNT(*) as count
                FROM trips
                WHERE COALESCE(total_amount, 0) > COALESCE(paid, 0)
                  AND DATEDIFF(NOW(), start_date) > 4
                  AND active = 1
            `);
            pendingTripsCount = parseInt(pendingRows[0]?.count || 0);
        } catch (err) {
            console.error('Error fetching pending trips:', err);
            pendingTripsCount = 0;
        }

        // 6. Get Summary Data
        let tripsToday = 0;
        let fuelPurchased = 0;
        let fuelPurchasedVolume = 0;
        let fuelSold = 0;
        let fuelSoldVolume = 0;
        let cashInHandToday = 0;
        let bankTotalToday = 0;

        try {
            // Trips
            const [tripsRows] = await db.execute(`
               SELECT COUNT(*) AS count
                FROM pol.trips
                WHERE active = 1
                AND CD >= CURDATE()
                AND CD < CURDATE() + INTERVAL 1 DAY;
            `);
            tripsToday = parseInt(tripsRows[0]?.count || 0);

            // Fuel Purchased - get total amount from trips table
            const [fuelPurchasedRows] = await db.execute(`
                SELECT 
                    COALESCE(SUM(total_amount), 0) as total
                FROM trips
                WHERE active = 1  AND CD >= CURDATE()
                AND CD < CURDATE() + INTERVAL 1 DAY;
            `);
            fuelPurchased = parseFloat(fuelPurchasedRows[0]?.total || 0);
            
            // Fuel Purchased Volume - get total volume from trip_products
            const [fuelPurchasedVolumeRows] = await db.execute(`
                SELECT 
                    COALESCE(SUM(tp.quantity_ltr), 0) as volume
                FROM trips t
                LEFT JOIN trip_products tp ON t.id = tp.trip_id AND tp.active = 1
                WHERE t.active = 1  AND t.CD >= CURDATE()
                AND t.CD < CURDATE() + INTERVAL 1 DAY;
            `);
            fuelPurchasedVolume = parseFloat(fuelPurchasedVolumeRows[0]?.volume || 0);

            // Fuel Sold (from pol_sale table) - get both amount and volume
            const [fuelSoldRows] = await db.execute(`
                SELECT 
                    COALESCE(SUM(total_amount), 0) as total,
                    COALESCE(SUM(fuel), 0) as volume
                FROM pol_sale
                WHERE Active = 1  AND pol_sale.CD >= CURDATE()
                AND pol_sale.CD < CURDATE() + INTERVAL 1 DAY;
            `);
            fuelSold = parseFloat(fuelSoldRows[0]?.total || 0);
            fuelSoldVolume = parseFloat(fuelSoldRows[0]?.volume || 0);

            // Cash in Hand - get balance from last record
            const [cashTodayAmountRows] = await db.execute(`
                SELECT balance
                FROM cash_in_hand
                WHERE Active = 1
                ORDER BY id DESC
                LIMIT 1
            `);
            cashInHandToday = parseFloat(cashTodayAmountRows[0]?.balance || 0);

            // Bank Total - sum of Balance column from accounts table
            const [bankTodayRows] = await db.execute(`
                SELECT COALESCE(SUM(Balance), 0) as total
                FROM accounts
                WHERE active = 1
            `);
            bankTotalToday = parseFloat(bankTodayRows[0]?.total || 0);
        } catch (err) {
            console.error('Error fetching summary data:', err);
            console.error('Error details:', err.message);
        }

        // 7. Get Total Rent Paid (from vehicle_rent table)
        let totalRentPaidToday = 0;
        try {
            const [rentRows] = await db.execute(`
                SELECT COALESCE(SUM(total_rent), 0) as total
                FROM vehicle_rent
                WHERE Active = 1  AND CD >= CURDATE()
                AND CD < CURDATE() + INTERVAL 1 DAY;
            `);
            totalRentPaidToday = parseFloat(rentRows[0]?.total || 0);
        } catch (err) {
            console.error('Error fetching total rent paid:', err);
            totalRentPaidToday = 0;
        }

        // 8. Get Total Payment to Depos (from payments table)
        let totalPaymentToDeposToday = 0;
        try {
            const [paymentToDeposRows] = await db.execute(`
                SELECT COALESCE(SUM(p.Amount), 0) as total
                FROM payments p
                INNER JOIN transactions t ON t.ID = p.transactionID
                WHERE (t.Purpose LIKE '%Payment to %' OR t.Purpose LIKE 'Payment for %')
                  AND t.active = 1
                  AND p.active = 1
                  AND p.DepoID IS NOT NULL 
                  AND p.CD >= CURDATE()
                  AND p.CD < CURDATE() + INTERVAL 1 DAY;
            `);
            totalPaymentToDeposToday = parseFloat(paymentToDeposRows[0]?.total || 0);
        } catch (err) {
            console.error('Error fetching total payment to depos:', err);
            totalPaymentToDeposToday = 0;
        }

        // 9. Get Total Recoveries (from recoveries table)
        let totalRecoveriesToday = 0;
        try {
            const [recoveriesRows] = await db.execute(`
                SELECT COALESCE(SUM(Amount), 0) as total
                FROM recoveries
                WHERE Active = 1  AND CD >= CURDATE()
                AND CD < CURDATE() + INTERVAL 1 DAY;
            `);
            totalRecoveriesToday = parseFloat(recoveriesRows[0]?.total || 0);
        } catch (err) {
            console.error('Error fetching total recoveries:', err);
            totalRecoveriesToday = 0;
        }

        // 10. Get Total Expenditure (sum of personal, business, rental, and vehicle expenses)
        let totalExpenditure = 0;
        try {
            // Personal and Business expenses from expenses table
            const [personalBusinessRows] = await db.execute(`
                SELECT COALESCE(SUM(e.amount), 0) as total
                FROM expenses e
                LEFT JOIN expense_categories ec ON e.category_id = ec.id
                LEFT JOIN transactions t ON e.transaction_id = t.ID
                WHERE e.active = 1 AND t.active = 1
                  AND ec.expense_type IN ('PERSONAL', 'BUSINESS')
            `);
            const personalBusinessTotal = parseFloat(personalBusinessRows[0]?.total || 0);

            // Rental expenses from vehicle_rent table
            const [rentalRows] = await db.execute(`
                SELECT COALESCE(SUM(total_rent), 0) as total
                FROM vehicle_rent
                WHERE Active = 1
            `);
            const rentalTotal = parseFloat(rentalRows[0]?.total || 0);

            // Vehicle expenses from vehicle_expenses table
            const [vehicleExpenseRows] = await db.execute(`
                SELECT COALESCE(SUM(amount), 0) as total
                FROM vehicle_expenses
                WHERE Active = 1
            `);
            const vehicleExpenseTotal = parseFloat(vehicleExpenseRows[0]?.total || 0);

            totalExpenditure = personalBusinessTotal + rentalTotal + vehicleExpenseTotal;
            console.log(`Total Expenditure: Personal/Business=${personalBusinessTotal}, Rental=${rentalTotal}, Vehicle=${vehicleExpenseTotal}, Total=${totalExpenditure}`);
        } catch (err) {
            console.error('Error fetching total expenditure:', err);
            totalExpenditure = 0;
        }

        res.json({
            cashInHand: cashInHand,
            bankBalance: bankBalance,
            totalClientDue: totalClientDue,
            totalPayableToDepos: totalPayableToDepos,
            depoCreditUsage: depoCreditUsage,
            pendingTripsCount: pendingTripsCount,
            creditTripsCount: creditTripsCount,
            tripsToday: tripsToday,
            fuelPurchased: fuelPurchased,
            fuelPurchasedVolume: fuelPurchasedVolume,
            fuelSold: fuelSold,
            fuelSoldVolume: fuelSoldVolume,
            cashInHandToday: cashInHandToday,
            bankTotalToday: bankTotalToday,
            totalRentPaidToday: totalRentPaidToday,
            totalPaymentToDeposToday: totalPaymentToDeposToday,
            totalRecoveriesToday: totalRecoveriesToday,
            totalExpenditure: totalExpenditure
        });
    } catch (err) {
        console.error('Error fetching dashboard data:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message,
            cashInHand: 0,
            bankBalance: 0,
            totalClientDue: 0,
            depoCreditUsage: [],
            pendingTripsCount: 0,
            creditTripsCount: 0
        });
    }
};

// Get Total Client Due filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredClientDue = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Use range queries (>= and <) for performance, not DATE() function
        // Filter both sales and payments by the SAME date range
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        let dateRangeInfo = {};
        
        switch (filter) {
            case 'daily':
                // Today: from start of today to start of tomorrow
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                dateRangeInfo = { description: 'Today', start: dateStart, end: dateEnd };
                break;
            case 'weekly':
                // Last 7 days: from 7 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                dateRangeInfo = { description: 'Last 7 days', start: dateStart, end: dateEnd };
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                dateRangeInfo = { description: 'Current month', start: dateStart, end: dateEnd };
                break;
            case 'yearly':
                // Current year: from first day of year to first day of next year
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                dateRangeInfo = { description: 'Current year', start: dateStart, end: dateEnd };
                break;
            default:
                // Default to daily if invalid filter
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                dateRangeInfo = { description: 'Today', start: dateStart, end: dateEnd };
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Build date range conditions using range queries (>= and <) for performance
        // Use CD (Created Date) column for date filtering
        const salesDateRange = `AND ps.CD >= '${startStr}' AND ps.CD < '${endStr}'`;
        const recoveriesDateRange = `AND r.CD >= '${startStr}' AND r.CD < '${endStr}'`;
        
        // Client dues = SUM(sales.net_amount or total_amount) - SUM(payments.amount)
        // Both filtered by the SAME date range
        // Use LEFT JOIN so unpaid sales are still counted
        // Use subqueries to avoid Cartesian product when joining sales and recoveries
        // Calculate sales and recoveries separately, then combine to get accurate totals
        const [clientDuesBaseRows] = await db.execute(`
            SELECT 
                c.id as client_id,
                c.name as client_name,
                -- Purchased: SUM of sales (total_amount) in period (calculated separately)
                COALESCE((
                    SELECT IFNULL(SUM(ps.total_amount), 0)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                    AND ps.Active = 1 
                    ${salesDateRange}
                ), 0) as total_sales,
                -- Paid: SUM of recoveries (Amount) in period (calculated separately)
                COALESCE((
                    SELECT IFNULL(SUM(r.Amount), 0)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                    AND r.Active = 1 
                    ${recoveriesDateRange}
                ), 0) as total_recoveries,
                -- Get last sale date in period
                (
                    SELECT MAX(ps.CD)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                    AND ps.Active = 1 
                    ${salesDateRange}
                ) as last_sale_date,
                -- Get last recovery date in period
                (
                    SELECT MAX(r.CD)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                    AND r.Active = 1 
                    ${recoveriesDateRange}
                ) as last_recovery_date
            FROM customers c
            WHERE c.active = 1
            -- Only show customers who had activity (sales OR recoveries) in the period
            HAVING (
                COALESCE((
                    SELECT IFNULL(SUM(ps.total_amount), 0)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                    AND ps.Active = 1 
                    ${salesDateRange}
                ), 0) > 0 OR
                COALESCE((
                    SELECT IFNULL(SUM(r.Amount), 0)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                    AND r.Active = 1 
                    ${recoveriesDateRange}
                ), 0) > 0
            )
        `);
        
        // Calculate due_amount and last_transaction_date for each customer
        const clientDuesRows = clientDuesBaseRows.map(row => {
            const total_sales = parseFloat(row.total_sales || 0);
            const total_recoveries = parseFloat(row.total_recoveries || 0);
            const due_amount = total_sales - total_recoveries;
            
            const last_sale_date = row.last_sale_date || null;
            const last_recovery_date = row.last_recovery_date || null;
            
            const last_transaction_date = 
                (!last_recovery_date || (last_sale_date && last_sale_date > last_recovery_date)) 
                    ? last_sale_date 
                    : last_recovery_date;
            
            return {
                client_id: row.client_id,
                client_name: row.client_name,
                total_sales: total_sales,
                total_recoveries: total_recoveries,
                due_amount: due_amount,
                last_sale_date: last_sale_date,
                last_recovery_date: last_recovery_date,
                last_transaction_date: last_transaction_date
            };
        });
        
        // Sum all remaining amounts (only positive remaining, negative means overpaid)
        const totalClientDue = clientDuesRows.reduce((sum, row) => {
            const remaining = parseFloat(row.due_amount || 0);
            // Only add positive remaining amounts (if paid > purchased, remaining is negative, so don't count it)
            return sum + (remaining > 0 ? remaining : 0);
        }, 0);
        
        // Format date for display
        const formatDateForDisplay = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };
        
        const actualDateRange = {
            start: formatDateForDisplay(dateStart),
            end: formatDateForDisplay(new Date(dateEnd.getTime() - 1)) // Subtract 1 day for display
        };
        
        console.log(`[Filtered Client Due] Filter: ${filter} (${dateRangeInfo.description}), Total: ${totalClientDue} (from ${clientDuesRows.length} clients with dues), Date Range: ${actualDateRange.start} to ${actualDateRange.end}`);
        
        res.json({
            success: true,
            totalClientDue: totalClientDue,
            filter: filter,
            dateRange: actualDateRange,
            dateRangeDescription: dateRangeInfo.description,
            clientCount: clientDuesRows.length,
            clientDetails: clientDuesRows.map(row => ({
                client_id: row.client_id,
                client_name: row.client_name,
                total_sales: parseFloat(row.total_sales || 0),
                total_recoveries: parseFloat(row.total_recoveries || 0),
                due_amount: parseFloat(row.due_amount || 0)
            }))
        });
    } catch (err) {
        console.error('Error fetching filtered client due:', err);
        res.status(500).json({
            success: false,
            message: 'Server Error',
            error: err.message,
            totalClientDue: 0
        });
    }
};

// Get list of trips with pending payments after 4 days
exports.getPendingTrips = async (req, res) => {
    try {
        const [pendingTrips] = await db.execute(`
            SELECT DISTINCT
                t.id,
                t.trip_no,
                t.start_date,
                t.vehicle_id,
                v.number as vehicle_number,
                t.amount_collected,
                t.paid,
                t.total_amount,
                (COALESCE(t.total_amount, 0) - COALESCE(t.paid, 0)) as pending_amount,
                DATEDIFF(NOW(), t.start_date) as days_pending,
                t.status,
                depo.name as depo_name,
                c.name as company_name
            FROM trips t
            LEFT JOIN vehicles v ON t.vehicle_id = v.id
            LEFT JOIN trip_depos td ON td.trip_id = t.id AND td.Active = 1
            LEFT JOIN depo ON td.depo_id = depo.id AND depo.active = 1
            LEFT JOIN depo_company dc ON dc.depo_id = depo.id AND dc.active = 1
            LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
            WHERE COALESCE(t.total_amount, 0) > COALESCE(t.paid, 0)
              AND DATEDIFF(NOW(), t.start_date) > 4
              AND t.active = 1
            ORDER BY t.start_date ASC
        `);
        res.json(pendingTrips);
    } catch (err) {
        console.error('Error fetching pending trips list:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message
        });
    }
};

// Get list of trips with credit products and their details
exports.getCreditTrips = async (req, res) => {
    try {
        const [creditTrips] = await db.execute(`
            SELECT DISTINCT
                t.id,
                t.trip_no,
                t.start_date,
                t.vehicle_id,
                v.number as vehicle_number,
                d.name as driver_name,
                t.status,
                t.total_amount,
                t.paid,
                (COALESCE(t.total_amount, 0) - COALESCE(t.paid, 0)) as remaining_amount,
                depo.name as depo_name,
                c.name as company_name
            FROM trips t
            INNER JOIN trip_depos td ON td.trip_id = t.id AND td.Active = 1
            LEFT JOIN vehicles v ON t.vehicle_id = v.id
            LEFT JOIN drivers d ON v.driver_id = d.id
            LEFT JOIN depo ON td.depo_id = depo.id AND depo.active = 1
            LEFT JOIN depo_company dc ON dc.depo_id = depo.id AND dc.active = 1
            LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
            WHERE td.purchase_type = 'credit'
              AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
              AND t.active = 1
            ORDER BY t.start_date DESC, t.id DESC
        `);
        res.json(creditTrips);
    } catch (err) {
        console.error('Error fetching credit trips list:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message
        });
    }
};

// Get payable amounts per dealer using pol_sale and recoveries
// Get Total Payable to Dealers filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredDealerPayables = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Use range queries (>= and <) for performance, not DATE() function
        // Filter trip_depos by trip date (CD column from trips table)
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        let dateRangeInfo = {};
        
        switch (filter) {
            case 'daily':
                // Today: from start of today to start of tomorrow
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                dateRangeInfo = { description: 'Today', start: dateStart, end: dateEnd };
                break;
            case 'weekly':
                // Last 7 days: from 7 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                dateRangeInfo = { description: 'Last 7 days', start: dateStart, end: dateEnd };
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                dateRangeInfo = { description: 'Current month', start: dateStart, end: dateEnd };
                break;
            case 'yearly':
                // Current year: from first day of year to first day of next year
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                dateRangeInfo = { description: 'Current year', start: dateStart, end: dateEnd };
                break;
            default:
                // Default to daily if invalid filter
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                dateRangeInfo = { description: 'Today', start: dateStart, end: dateEnd };
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Build date range condition for trips (filter by trip date)
        const tripDateRange = `AND t.CD >= '${startStr}' AND t.CD < '${endStr}'`;
        
        // Calculate total payable to dealers for the filtered period
        // Join with trips table to filter by trip date
        const [payableRows] = await db.execute(`
            SELECT COALESCE(SUM(td.payable_amount - COALESCE(td.paid_amount, 0)), 0) as total_remaining
            FROM trip_depos td
            INNER JOIN trips t ON t.id = td.trip_id AND t.active = 1
            WHERE (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
              AND td.purchase_type != 'cash'
              AND td.Active = 1
              ${tripDateRange}
        `);
        
        const totalPayableToDealers = parseFloat(payableRows[0]?.total_remaining || 0);
        
        // Format date for display
        const formatDateForDisplay = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };
        
        const actualDateRange = {
            start: formatDateForDisplay(dateStart),
            end: formatDateForDisplay(new Date(dateEnd.getTime() - 1)) // Subtract 1 day for display
        };
        
        console.log(`[Filtered Dealer Payables] Filter: ${filter} (${dateRangeInfo.description}), Total: ${totalPayableToDealers}, Date Range: ${actualDateRange.start} to ${actualDateRange.end}`);
        
        res.json({
            success: true,
            totalPayableToDealers: totalPayableToDealers,
            filter: filter,
            dateRange: actualDateRange
        });
    } catch (err) {
        console.error('Error fetching filtered dealer payables:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            error: err.message, 
            totalPayableToDealers: 0 
        });
    }
};

exports.getDealerPayables = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly', or undefined for all
        
        // Build date range condition if filter is provided
        let tripDateRange = '';
        if (filter) {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            let dateStart = null;
            let dateEnd = null;
            
            switch (filter) {
                case 'daily':
                    dateStart = today;
                    dateEnd = new Date(today);
                    dateEnd.setDate(dateEnd.getDate() + 1);
                    break;
                case 'weekly':
                    dateStart = new Date(today);
                    dateStart.setDate(dateStart.getDate() - 6);
                    dateEnd = new Date(today);
                    dateEnd.setDate(dateEnd.getDate() + 1);
                    break;
                case 'monthly':
                    // Last 30 days: from 30 days ago to start of tomorrow
                    dateStart = new Date(today);
                    dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                    dateEnd = new Date(today);
                    dateEnd.setDate(dateEnd.getDate() + 1);
                    break;
                case 'yearly':
                    dateStart = new Date(now.getFullYear(), 0, 1);
                    dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                    break;
            }
            
            if (dateStart && dateEnd) {
                const formatDateTime = (date) => {
                    const year = date.getFullYear();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const day = String(date.getDate()).padStart(2, '0');
                    return `${year}-${month}-${day} 00:00:00`;
                };
                
                const startStr = formatDateTime(dateStart);
                const endStr = formatDateTime(dateEnd);
                tripDateRange = `AND t.CD >= '${startStr}' AND t.CD < '${endStr}'`;
            }
        }
        
        // Get all active dealers with their payable amounts
        // Calculate based on trip_depos (payable_amount - paid_amount) for credit purchases
        // Use subquery to filter by trip date if filter is provided (avoids JOIN issues)
        let payableCondition = '';
        if (filter && tripDateRange) {
            // When filter is provided, only include trip_depos from trips within the date range
            // Replace all occurrences of 't.CD' with 'CD' for the subquery (no table alias in subquery)
            const subqueryDateRange = tripDateRange.replace(/t\.CD/g, 'CD');
            payableCondition = `AND td.trip_id IN (
                SELECT id FROM trips WHERE active = 1 ${subqueryDateRange}
            )`;
        }
        
        const [dealerPayablesRows] = await db.execute(`
            SELECT 
                d.id as depo_id,
                d.name as depo_name,
                c.name as company_name,
                COALESCE(SUM(td.payable_amount - COALESCE(td.paid_amount, 0)), 0) as payable_amount
            FROM depo d
            LEFT JOIN depo_company dc ON dc.depo_id = d.id AND dc.active = 1
            LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
            LEFT JOIN trip_depos td ON td.depo_id = d.id 
                AND td.Active = 1 
                AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
                AND td.purchase_type != 'cash'
                ${payableCondition}
            WHERE d.active = 1
            GROUP BY d.id, d.name, c.name
            HAVING payable_amount > 0
            ORDER BY payable_amount DESC
        `);

        const dealerPayables = [];

        for (const row of dealerPayablesRows) {
            const depoId = row.depo_id;
            const payableAmount = parseFloat(row.payable_amount || 0);

            // Get starting credit (InitialLimit from pool table)
            const [initialLimitRows] = await db.execute(`
                SELECT COALESCE(p.DepoLimit, d.Balance, 0) as initial_limit
                FROM depo d
                LEFT JOIN pool p ON p.DepoID = d.id 
                    AND p.TripID IS NULL 
                    AND p.recovery_id IS NULL 
                    AND p.payment_id IS NULL 
                    AND p.active = 1
                WHERE d.id = ?
                ORDER BY p.ID ASC 
                LIMIT 1
            `, [depoId]);

            const startingCredit = parseFloat(initialLimitRows[0]?.initial_limit || 0);

            // Get current balance from advance_balance table (latest Balance)
            const [advanceBalanceRows] = await db.execute(`
                SELECT COALESCE(Balance, 0) as current_balance
                FROM advance_balance
                WHERE DepoID = ? AND Active = 1
                ORDER BY ID DESC
                LIMIT 1
            `, [depoId]);

            const currentBalance = parseFloat(advanceBalanceRows[0]?.current_balance || 0);

            // Get available credit from pool table (last DepoLimit/Balance)
            const [poolBalanceRows] = await db.execute(`
                SELECT COALESCE(DepoLimit, 0) as available_credit
                FROM pool
                WHERE DepoID = ? AND active = 1
                ORDER BY ID DESC
                LIMIT 1
            `, [depoId]);

            const availableCredit = parseFloat(poolBalanceRows[0]?.available_credit || 0);

            dealerPayables.push({
                depo_id: depoId,
                depo_name: row.depo_name,
                company_name: row.company_name || 'N/A',
                starting_credit: startingCredit,
                current_balance: currentBalance,
                available_credit: availableCredit,
                payable_amount: payableAmount
            });
        }

        res.json(dealerPayables);
    } catch (err) {
        console.error('Error fetching dealer payables:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message
        });
    }
};

// Get client dues using pol_sale and recoveries
exports.getClientDues = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly', or undefined for all
        
        // If no filter, show all-time data
        if (!filter) {
            // Get all clients with their all-time due amounts
            // Use subqueries to avoid Cartesian product when joining sales and recoveries
            const [clientDuesBaseRows] = await db.execute(`
            SELECT 
                c.id as client_id,
                c.name as client_name,
                    -- Purchased: SUM of all sales (calculated separately)
                    COALESCE((
                        SELECT IFNULL(SUM(ps.total_amount), 0)
                        FROM pol_sale ps
                        WHERE ps.client_id = c.id AND ps.Active = 1
                    ), 0) as total_sales,
                    -- Paid: SUM of all recoveries (calculated separately)
                    COALESCE((
                        SELECT IFNULL(SUM(r.Amount), 0)
                        FROM recoveries r
                        WHERE r.ClientID = c.id AND r.Active = 1
                    ), 0) as total_recoveries,
                    -- Get last sale date
                    (
                        SELECT MAX(ps.CD)
                        FROM pol_sale ps
                        WHERE ps.client_id = c.id AND ps.Active = 1
                    ) as last_sale_date,
                    -- Get last recovery date
                    (
                        SELECT MAX(r.CD)
                        FROM recoveries r
                        WHERE r.ClientID = c.id AND r.Active = 1
                    ) as last_recovery_date
            FROM customers c
            WHERE c.active = 1
                HAVING (
                    COALESCE((
                        SELECT IFNULL(SUM(ps.total_amount), 0)
                        FROM pol_sale ps
                        WHERE ps.client_id = c.id AND ps.Active = 1
                    ), 0) - 
                    COALESCE((
                        SELECT IFNULL(SUM(r.Amount), 0)
                        FROM recoveries r
                        WHERE r.ClientID = c.id AND r.Active = 1
                    ), 0)
                ) > 0
                ORDER BY (
                    COALESCE((
                        SELECT IFNULL(SUM(ps.total_amount), 0)
                        FROM pol_sale ps
                        WHERE ps.client_id = c.id AND ps.Active = 1
                    ), 0) - 
                    COALESCE((
                        SELECT IFNULL(SUM(r.Amount), 0)
                        FROM recoveries r
                        WHERE r.ClientID = c.id AND r.Active = 1
                    ), 0)
                ) DESC
        `);

            // Calculate due_amount and last_transaction_date for each customer
            const clientDuesRows = clientDuesBaseRows.map(row => {
                const total_sales = parseFloat(row.total_sales || 0);
                const total_recoveries = parseFloat(row.total_recoveries || 0);
                const due_amount = total_sales - total_recoveries;
                
                const last_sale_date = row.last_sale_date || null;
                const last_recovery_date = row.last_recovery_date || null;
                
                const last_transaction_date = 
                    (!last_recovery_date || (last_sale_date && last_sale_date > last_recovery_date)) 
                        ? last_sale_date 
                        : last_recovery_date;
                
                return {
            client_id: row.client_id,
            client_name: row.client_name,
                    total_sales: total_sales,
                    total_recoveries: total_recoveries,
                    due_amount: due_amount,
                    last_sale_date: last_sale_date,
                    last_recovery_date: last_recovery_date,
                    last_transaction_date: last_transaction_date
                };
            });

            return res.json(clientDuesRows);
        }
        
        // For filtered queries, show only activity in that period
        // Use range queries (>= and <) for performance, not DATE() function
        // Filter both sales and payments by the SAME date range
        let dateStart = null;
        let dateEnd = null;
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        switch (filter) {
            case 'daily':
                // Today: from start of today to start of tomorrow
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                // Last 7 days: from 7 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                // Current year: from first day of year to first day of next year
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = null;
                dateEnd = null;
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        // Build date range conditions using range queries (>= and <) for performance
        // Use CD (Created Date) column for date filtering
        let salesDateRange = '';
        let recoveriesDateRange = '';
        
        if (dateStart && dateEnd) {
            const startStr = formatDateTime(dateStart);
            const endStr = formatDateTime(dateEnd);
            // Use CD column. Use range queries for performance
            salesDateRange = `AND ps.CD >= '${startStr}' AND ps.CD < '${endStr}'`;
            recoveriesDateRange = `AND r.CD >= '${startStr}' AND r.CD < '${endStr}'`;
        }
        
        // Use subqueries to avoid Cartesian product when joining sales and recoveries
        // Calculate sales and recoveries separately, then combine to get accurate totals
        const [clientDuesBaseRows] = await db.execute(`
            SELECT 
                c.id as client_id,
                c.name as client_name,
                -- Purchased: SUM of sales (total_amount) in period (calculated separately)
                COALESCE((
                    SELECT IFNULL(SUM(ps.total_amount), 0)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                    AND ps.Active = 1 
                    ${salesDateRange}
                ), 0) as total_sales,
                -- Paid: SUM of recoveries (Amount) in period (calculated separately)
                COALESCE((
                    SELECT IFNULL(SUM(r.Amount), 0)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                    AND r.Active = 1 
                    ${recoveriesDateRange}
                ), 0) as total_recoveries,
                -- Get last sale date in period
                (
                    SELECT MAX(ps.CD)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                    AND ps.Active = 1 
                    ${salesDateRange}
                ) as last_sale_date,
                -- Get last recovery date in period
                (
                    SELECT MAX(r.CD)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                    AND r.Active = 1 
                    ${recoveriesDateRange}
                ) as last_recovery_date
            FROM customers c
            WHERE c.active = 1
            -- Only show customers who had activity (sales OR recoveries) in the period
            HAVING (
                COALESCE((
                    SELECT IFNULL(SUM(ps.total_amount), 0)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                    AND ps.Active = 1 
                    ${salesDateRange}
                ), 0) > 0 OR
                COALESCE((
                    SELECT IFNULL(SUM(r.Amount), 0)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                    AND r.Active = 1 
                    ${recoveriesDateRange}
                ), 0) > 0
            )
            ORDER BY c.name ASC
        `);
        
        // Calculate due_amount and last_transaction_date for each customer
        const clientDuesRows = clientDuesBaseRows.map(row => {
            const total_sales = parseFloat(row.total_sales || 0);
            const total_recoveries = parseFloat(row.total_recoveries || 0);
            const due_amount = total_sales - total_recoveries;
            
            const last_sale_date = row.last_sale_date || null;
            const last_recovery_date = row.last_recovery_date || null;
            
            const last_transaction_date = 
                (!last_recovery_date || (last_sale_date && last_sale_date > last_recovery_date)) 
                    ? last_sale_date 
                    : last_recovery_date;
            
            return {
                client_id: row.client_id,
                client_name: row.client_name,
                total_sales: total_sales,
                total_recoveries: total_recoveries,
                due_amount: due_amount,
                last_sale_date: last_sale_date,
                last_recovery_date: last_recovery_date,
                last_transaction_date: last_transaction_date
            };
        });

        res.json(clientDuesRows);
    } catch (err) {
        console.error('Error fetching client dues:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message
        });
    }
};

// Get Total Expenditure filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredExpenditure = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Build date conditions for each expense type
        const transactionDateRange = `AND t.CD >= '${startStr}' AND t.CD < '${endStr}'`;
        const vehicleRentDateRange = `AND vr.CD >= '${startStr}' AND vr.CD < '${endStr}'`;
        const vehicleExpenseDateRange = `AND ve.CD >= '${startStr}' AND ve.CD < '${endStr}'`;
        
        let totalExpenditure = 0;
        
        try {
            // Personal and Business expenses from expenses table (filtered by transaction date)
            const [personalBusinessRows] = await db.execute(`
                SELECT COALESCE(SUM(e.amount), 0) as total
                FROM expenses e
                LEFT JOIN expense_categories ec ON e.category_id = ec.id
                LEFT JOIN transactions t ON e.transaction_id = t.ID
                WHERE e.active = 1 AND t.active = 1
                  AND ec.expense_type IN ('PERSONAL', 'BUSINESS')
                  ${transactionDateRange}
            `);
            const personalBusinessTotal = parseFloat(personalBusinessRows[0]?.total || 0);

            // Rental expenses from vehicle_rent table (filtered by CD)
            const [rentalRows] = await db.execute(`
                SELECT COALESCE(SUM(total_rent), 0) as total
                FROM vehicle_rent vr
                WHERE Active = 1
                ${vehicleRentDateRange}
            `);
            const rentalTotal = parseFloat(rentalRows[0]?.total || 0);

            // Vehicle expenses from vehicle_expenses table (filtered by CD)
            const [vehicleExpenseRows] = await db.execute(`
                SELECT COALESCE(SUM(amount), 0) as total
                FROM vehicle_expenses ve
                WHERE Active = 1
                ${vehicleExpenseDateRange}
            `);
            const vehicleExpenseTotal = parseFloat(vehicleExpenseRows[0]?.total || 0);

            totalExpenditure = personalBusinessTotal + rentalTotal + vehicleExpenseTotal;
            
            console.log(`[Filtered Expenditure] Filter: ${filter}, Personal/Business=${personalBusinessTotal}, Rental=${rentalTotal}, Vehicle=${vehicleExpenseTotal}, Total=${totalExpenditure}`);
        } catch (err) {
            console.error('Error fetching filtered expenditure:', err);
            totalExpenditure = 0;
        }
        
        res.json({
            success: true,
            totalExpenditure: totalExpenditure,
            filter: filter
        });
    } catch (err) {
        console.error('Error fetching filtered expenditure:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            error: err.message, 
            totalExpenditure: 0 
        });
    }
};

// Get Fuel Purchased filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredFuelPurchased = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Get Fuel Purchased amount from trips table
        const [fuelPurchasedRows] = await db.execute(`
            SELECT 
                COALESCE(SUM(total_amount), 0) as total
            FROM trips
            WHERE active = 1
            AND CD >= ? AND CD < ?
        `, [startStr, endStr]);
        
        const fuelPurchased = parseFloat(fuelPurchasedRows[0]?.total || 0);
        
        // Get Fuel Purchased Volume from trip_products
        const [fuelPurchasedVolumeRows] = await db.execute(`
            SELECT 
                COALESCE(SUM(tp.quantity_ltr), 0) as volume
            FROM trips t
            LEFT JOIN trip_products tp ON t.id = tp.trip_id AND tp.active = 1
            WHERE t.active = 1
            AND t.CD >= ? AND t.CD < ?
        `, [startStr, endStr]);
        
        const fuelPurchasedVolume = parseFloat(fuelPurchasedVolumeRows[0]?.volume || 0);
        
        console.log(`[Filtered Fuel Purchased] Filter: ${filter}, Amount: ${fuelPurchased}, Volume: ${fuelPurchasedVolume}`);
        
        res.json({
            success: true,
            fuelPurchased: fuelPurchased,
            fuelPurchasedVolume: fuelPurchasedVolume,
            filter: filter
        });
    } catch (err) {
        console.error('Error fetching filtered fuel purchased:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            error: err.message, 
            fuelPurchased: 0,
            fuelPurchasedVolume: 0
        });
    }
};

// Get Fuel Sold filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredFuelSold = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Get Fuel Sold amount and volume from pol_sale table
        const [fuelSoldRows] = await db.execute(`
            SELECT 
                COALESCE(SUM(total_amount), 0) as total,
                COALESCE(SUM(fuel), 0) as volume
            FROM pol_sale
            WHERE Active = 1
            AND CD >= ? AND CD < ?
        `, [startStr, endStr]);
        
        const fuelSold = parseFloat(fuelSoldRows[0]?.total || 0);
        const fuelSoldVolume = parseFloat(fuelSoldRows[0]?.volume || 0);
        
        console.log(`[Filtered Fuel Sold] Filter: ${filter}, Amount: ${fuelSold}, Volume: ${fuelSoldVolume}`);
        
        res.json({
            success: true,
            fuelSold: fuelSold,
            fuelSoldVolume: fuelSoldVolume,
            filter: filter
        });
    } catch (err) {
        console.error('Error fetching filtered fuel sold:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            error: err.message, 
            fuelSold: 0,
            fuelSoldVolume: 0
        });
    }
};

// Get Rent Paid filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredRentPaid = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Get Total Rent Paid from vehicle_rent table
        const [rentRows] = await db.execute(`
            SELECT COALESCE(SUM(total_rent), 0) as total
            FROM vehicle_rent
            WHERE Active = 1
            AND CD >= ? AND CD < ?
        `, [startStr, endStr]);
        
        const totalRentPaid = parseFloat(rentRows[0]?.total || 0);
        
        console.log(`[Filtered Rent Paid] Filter: ${filter}, Total: ${totalRentPaid}`);
        
        res.json({
            success: true,
            totalRentPaid: totalRentPaid,
            filter: filter
        });
    } catch (err) {
        console.error('Error fetching filtered rent paid:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            error: err.message, 
            totalRentPaid: 0
        });
    }
};

// Get Payments to Dealers filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredPayments = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Get Total Payment to Depos from payments table
        const [paymentToDeposRows] = await db.execute(`
            SELECT COALESCE(SUM(p.Amount), 0) as total
            FROM payments p
            INNER JOIN transactions t ON t.ID = p.transactionID
            WHERE (t.Purpose LIKE '%Payment to %' OR t.Purpose LIKE 'Payment for %')
              AND t.active = 1
              AND p.active = 1
              AND p.DepoID IS NOT NULL 
              AND p.CD >= ? AND p.CD < ?
        `, [startStr, endStr]);
        
        const totalPayments = parseFloat(paymentToDeposRows[0]?.total || 0);
        
        console.log(`[Filtered Payments] Filter: ${filter}, Total: ${totalPayments}`);
        
        res.json({
            success: true,
            totalPayments: totalPayments,
            filter: filter
        });
    } catch (err) {
        console.error('Error fetching filtered payments:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            error: err.message, 
            totalPayments: 0
        });
    }
};

// Get Recoveries filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredRecoveries = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Get Total Recoveries from recoveries table
        const [recoveriesRows] = await db.execute(`
            SELECT COALESCE(SUM(Amount), 0) as total
            FROM recoveries
            WHERE Active = 1
            AND CD >= ? AND CD < ?
        `, [startStr, endStr]);
        
        const totalRecoveries = parseFloat(recoveriesRows[0]?.total || 0);
        
        console.log(`[Filtered Recoveries] Filter: ${filter}, Total: ${totalRecoveries}`);
        
        res.json({
            success: true,
            totalRecoveries: totalRecoveries,
            filter: filter
        });
    } catch (err) {
        console.error('Error fetching filtered recoveries:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            error: err.message, 
            totalRecoveries: 0
        });
    }
};

// Get Total Trips Count filtered by date range (daily, weekly, monthly, yearly)
exports.getFilteredTripsCount = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        // Count trips in the filtered period
        const [tripsRows] = await db.execute(`
            SELECT COUNT(*) AS count
            FROM trips
            WHERE active = 1
            AND CD >= ? AND CD < ?
        `, [startStr, endStr]);
        
        const tripsCount = parseInt(tripsRows[0]?.count || 0);
        
        console.log(`[Filtered Trips Count] Filter: ${filter}, Count: ${tripsCount}`);
        
        res.json({
            success: true,
            tripsCount: tripsCount,
            filter: filter
        });
    } catch (err) {
        console.error('Error fetching filtered trips count:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            error: err.message, 
            tripsCount: 0 
        });
    }
};

exports.getExpenditureBreakdown = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly', or undefined for all
        
        // Build date range conditions if filter is provided
        let transactionDateRange = '';
        let vehicleRentDateRange = '';
        let vehicleExpenseDateRange = '';
        
        if (filter) {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            let dateStart = null;
            let dateEnd = null;
            
            switch (filter) {
                case 'daily':
                    dateStart = today;
                    dateEnd = new Date(today);
                    dateEnd.setDate(dateEnd.getDate() + 1);
                    break;
                case 'weekly':
                    dateStart = new Date(today);
                    dateStart.setDate(dateStart.getDate() - 6);
                    dateEnd = new Date(today);
                    dateEnd.setDate(dateEnd.getDate() + 1);
                    break;
                case 'monthly':
                    // Last 30 days: from 30 days ago to start of tomorrow
                    dateStart = new Date(today);
                    dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                    dateEnd = new Date(today);
                    dateEnd.setDate(dateEnd.getDate() + 1);
                    break;
                case 'yearly':
                    dateStart = new Date(now.getFullYear(), 0, 1);
                    dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                    break;
            }
            
            if (dateStart && dateEnd) {
                const formatDateTime = (date) => {
                    const year = date.getFullYear();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const day = String(date.getDate()).padStart(2, '0');
                    return `${year}-${month}-${day} 00:00:00`;
                };
                
                const startStr = formatDateTime(dateStart);
                const endStr = formatDateTime(dateEnd);
                transactionDateRange = `AND t.CD >= '${startStr}' AND t.CD < '${endStr}'`;
                vehicleRentDateRange = `AND vr.CD >= '${startStr}' AND vr.CD < '${endStr}'`;
                vehicleExpenseDateRange = `AND ve.CD >= '${startStr}' AND ve.CD < '${endStr}'`;
            }
        }
        
        const expenditureBreakdown = [];

        // 1. Personal and Business expenses from expenses table
        const [personalBusinessRows] = await db.execute(`
            SELECT 
                ec.expense_type as category,
                ec.name as category_name,
                COALESCE(SUM(e.amount), 0) as total_amount,
                MAX(t.CD) as last_date
            FROM expenses e
            LEFT JOIN expense_categories ec ON e.category_id = ec.id
            LEFT JOIN transactions t ON e.transaction_id = t.ID
            WHERE e.active = 1 AND t.active = 1
              AND ec.expense_type IN ('PERSONAL', 'BUSINESS')
              ${transactionDateRange}
            GROUP BY ec.expense_type, ec.name
            ORDER BY total_amount DESC
        `);

        // Add Personal and Business expenses
        for (const row of personalBusinessRows) {
            expenditureBreakdown.push({
                category_type: row.category,
                category_name: row.category_name || row.category,
                amount: parseFloat(row.total_amount || 0),
                last_date: row.last_date || null
            });
        }

        // 2. Rental expenses from vehicle_rent table
        const [rentalRows] = await db.execute(`
            SELECT 
                'RENTAL' as category_type,
                'Vehicle Rent' as category_name,
                COALESCE(SUM(total_rent), 0) as total_amount,
                MAX(vr.CD) as last_date
            FROM vehicle_rent vr
            WHERE Active = 1
            ${vehicleRentDateRange}
        `);

        if (rentalRows.length > 0 && parseFloat(rentalRows[0].total_amount || 0) > 0) {
            expenditureBreakdown.push({
                category_type: 'RENTAL',
                category_name: 'Vehicle Rent',
                amount: parseFloat(rentalRows[0].total_amount || 0),
                last_date: rentalRows[0].last_date || null
            });
        }

        // 3. Vehicle expenses from vehicle_expenses table
        const [vehicleExpenseRows] = await db.execute(`
            SELECT 
                'VEHICLE' as category_type,
                'Vehicle Expenses' as category_name,
                COALESCE(SUM(amount), 0) as total_amount,
                MAX(ve.CD) as last_date
            FROM vehicle_expenses ve
            WHERE Active = 1
            ${vehicleExpenseDateRange}
        `);

        if (vehicleExpenseRows.length > 0 && parseFloat(vehicleExpenseRows[0].total_amount || 0) > 0) {
            expenditureBreakdown.push({
                category_type: 'VEHICLE',
                category_name: 'Vehicle Expenses',
                amount: parseFloat(vehicleExpenseRows[0].total_amount || 0),
                last_date: vehicleExpenseRows[0].last_date || null
            });
        }

        // Sort by amount descending
        expenditureBreakdown.sort((a, b) => b.amount - a.amount);

        res.json(expenditureBreakdown);
    } catch (err) {
        console.error('Error fetching expenditure breakdown:', err);
        res.status(500).json({ error: 'Failed to fetch expenditure breakdown' });
    }
};

exports.getNovitaRecordsSummary = async (req, res) => {
    try {
        // Return empty array if tables don't exist
        res.json([]);
    } catch (err) {
        console.error(err);
        res.json([]);
    }
};

exports.getBranchesDBSummary = async (req, res) => {
    try {
        // Return default values if tables don't exist
        res.json([{
            branches: 0,
            year: '',
            totalincome: 0,
            totalexpense: 0,
            totalprofit: 0
        }]);
    } catch (err) {
        console.error(err);
        res.json([{
            branches: 0,
            year: '',
            totalincome: 0,
            totalexpense: 0,
            totalprofit: 0
        }]);
    }
};

// Get POL Purchase Report
exports.getPurchaseReport = async (req, res) => {
    try {
        const startDate = req.query.startDate || null;
        const endDate = req.query.endDate || null;

        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Start date and end date are required' });
        }

        const [purchaseRows] = await db.execute(`
            SELECT 
                t.trip_no,
                t.start_date as date,
                d.name as depo_name,
                c.name as company_name,
                tp.product_type,
                tp.quantity_ltr as fuel,
                tp.invoice_rate as rate,
                tp.discount,
                td.payable_amount as total_amount,
                COALESCE(td.paid_amount, 0) as paid
            FROM trip_depos td
            INNER JOIN trips t ON td.trip_id = t.id AND t.active = 1
            INNER JOIN trip_products tp ON td.product_id = tp.id AND tp.active = 1
            LEFT JOIN depo d ON td.depo_id = d.id AND d.active = 1
            LEFT JOIN depo_company dc ON dc.depo_id = d.id AND dc.active = 1
            LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
            WHERE td.Active = 1
              AND DATE(t.start_date) >= ?
              AND DATE(t.start_date) <= ?
            ORDER BY t.start_date DESC, t.id DESC
        `, [startDate, endDate]);

        res.json(purchaseRows);
    } catch (err) {
        console.error('Error fetching purchase report:', err);
        res.status(500).json({ error: 'Failed to fetch purchase report' });
    }
};

// Get Sale Report
exports.getSaleReport = async (req, res) => {
    try {
        const startDate = req.query.startDate || null;
        const endDate = req.query.endDate || null;

        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Start date and end date are required' });
        }

        const [saleRows] = await db.execute(`
            SELECT 
                ps.date,
                cust.name as client_name,
                t.trip_no,
                tp.product_type,
                ps.fuel,
                ps.rate,
                ps.total_amount
            FROM pol_sale ps
            INNER JOIN customers cust ON ps.client_id = cust.id AND cust.active = 1
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.active = 1
            WHERE ps.Active = 1
              AND DATE(ps.date) >= ?
              AND DATE(ps.date) <= ?
            ORDER BY ps.date DESC, ps.id DESC
        `, [startDate, endDate]);

        res.json(saleRows);
    } catch (err) {
        console.error('Error fetching sale report:', err);
        res.status(500).json({ error: 'Failed to fetch sale report' });
    }
};

// Get Customers Report
exports.getCustomersReport = async (req, res) => {
    try {
        const startDate = req.query.startDate || null;
        const endDate = req.query.endDate || null;

        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Start date and end date are required' });
        }

        // Use subqueries to avoid Cartesian product when joining sales and recoveries
        const [customerRows] = await db.execute(`
            SELECT 
                c.id as client_id,
                c.name as client_name,
                COALESCE((
                    SELECT IFNULL(SUM(ps.total_amount), 0)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                        AND ps.Active = 1 
                        AND DATE(ps.date) >= ? 
                        AND DATE(ps.date) <= ?
                ), 0) as total_sales,
                COALESCE((
                    SELECT IFNULL(SUM(ps.fuel), 0)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                        AND ps.Active = 1 
                        AND DATE(ps.date) >= ? 
                        AND DATE(ps.date) <= ?
                ), 0) as total_fuel,
                COALESCE((
                    SELECT IFNULL(SUM(r.Amount), 0)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                        AND r.Active = 1 
                        AND DATE(r.Date) >= ? 
                        AND DATE(r.Date) <= ?
                ), 0) as total_recoveries,
                (COALESCE((
                    SELECT IFNULL(SUM(ps.total_amount), 0)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                        AND ps.Active = 1 
                        AND DATE(ps.date) >= ? 
                        AND DATE(ps.date) <= ?
                ), 0) - 
                COALESCE((
                    SELECT IFNULL(SUM(r.Amount), 0)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                        AND r.Active = 1 
                        AND DATE(r.Date) >= ? 
                        AND DATE(r.Date) <= ?
                ), 0)) as due_amount
            FROM customers c
            WHERE c.active = 1
            HAVING (
                COALESCE((
                    SELECT IFNULL(SUM(ps.total_amount), 0)
                    FROM pol_sale ps
                    WHERE ps.client_id = c.id 
                        AND ps.Active = 1 
                        AND DATE(ps.date) >= ? 
                        AND DATE(ps.date) <= ?
                ), 0) > 0 OR
                COALESCE((
                    SELECT IFNULL(SUM(r.Amount), 0)
                    FROM recoveries r
                    WHERE r.ClientID = c.id 
                        AND r.Active = 1 
                        AND DATE(r.Date) >= ? 
                        AND DATE(r.Date) <= ?
                ), 0) > 0
            )
            ORDER BY due_amount DESC
        `, [
            startDate, endDate,  // total_sales
            startDate, endDate,  // total_fuel
            startDate, endDate,  // total_recoveries
            startDate, endDate,  // due_amount sales
            startDate, endDate,  // due_amount recoveries
            startDate, endDate,  // HAVING sales
            startDate, endDate   // HAVING recoveries
        ]);

        res.json(customerRows);
    } catch (err) {
        console.error('Error fetching customers report:', err);
        res.status(500).json({ error: 'Failed to fetch customers report' });
    }
};
//Dashboard Functions

exports.addProject = async (req, res) => {
    //const { name, password, email } = req.body;
    const project_name = req.body.name;
    const description = req.body.description;
    const budget = req.body.budget;
    const location = req.body.location;
    const startdate = req.body.startdate;
    const enddate = req.body.enddate;
    const status = req.body.status;
    const landcost = req.body.landcost;
    const taxes = req.body.taxes;
    const commission = req.body.commission;
    const notes = req.body.notes;
    const coveredarea = req.body.coveredarea;
    const type = req.body.type;
    const role = req.body.role;
    const userid = req.body.userid;
    //console.log(startdate);

    try {

        const [rows] = await db.execute('SELECT * FROM projects WHERE project_name = ?', [
            project_name,
        ]);
        if (rows.length != 0) {

            console.log("------> Project already exists");
            //res.sendStatus(409);
            res.status(409).json({ message: 'Project already exists.' });
        }
        else {

            const [result] = await db.execute(

                'INSERT INTO projects (project_name, project_description,budget, location_id,start_date,end_date,status,' +
                'landcost,taxes,commission,notes,coveredarea,type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [project_name, description, budget, location, startdate, enddate, status, landcost,
                    taxes, commission, notes, coveredarea, type]
            );
            if (role == "Admin") {
                await db.execute(

                    'INSERT INTO userprojects (userid, projectid) VALUES (?,?)',
                    [userid, result.insertId]
                );
            }


            res.status(200).json({ message: 'Project is saved.' });
        }




    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};
exports.deleteProject = async (req, res) => {
    //const { name, password, email } = req.body;
    const id = req.body.id;
    //console.log('In api id is' + id + ' ');

    try {

       
        const [result] = await db.execute('Delete FROM projects WHERE project_id = ?', [id]);
        await db.execute('Delete FROM userprojects WHERE projectid = ?', [id]);
        res.json(result[0]);


    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Project can not be deleted due to connection to some other data.' });
    }
};
exports.deleteProjectSale = async (req, res) => {

    const id = req.body.id;
    console.log(id);

    try {

        const [result] = await db.execute(

            'Delete FROM projectsale WHERE id = ?', [id]);
        res.json(result[0]);


    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};
exports.getProjectSale = async (req, res) => {
    try {
        const id = req.query.id;
        const [rows_cost] = await db.execute('SELECT sum(cost.amount) as totalcost,prj.landcost,prj.taxes,prj.commission FROM ' +
            ' `projectcost` AS cost ' +
            ' INNER JOIN `projects` as prj ON cost.project=prj.project_id' +
            ' where cost.project=' + id);

        const _temp = rows_cost.map(row => ({

            totalcost: row.totalcost,
            landcost: row.landcost,
            taxes: row.taxes,
            commission: row.commission,

        }));
        console.log(_temp[0].totalcost);
        const [rows] = await db.execute('SELECT ps.id,ps.sellingdate,ps.sellingprice,ps.taxes,ps.commission,ps.totalprice,prj.landcost,' +
            ' ps.taxes,ps.commission,ps.netprofit FROM `projectsale` ps INNER JOIN projects prj' +
            ' ON ps.project_id=prj.project_id' +
            ' WHERE ps.project_id = ?', [id]);
        const projectsale = rows.map(row => ({
            id: row.id,
            sellingdate: row.sellingdate,
            sellingprice: row.sellingprice,
            taxes: row.taxes,
            commission: row.commission,
            totalprice: row.totalprice,
            totalcost: Number(_temp[0].totalcost) + Number(_temp[0].landcost) + Number(_temp[0].taxes) + Number(_temp[0].commission),
            netprofit: row.netprofit,

        }));
        res.json(projectsale);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};
exports.getProfitContribution = async (req, res) => {
    try {
        const id = req.query.id;
        // const [rows_profit] = await db.execute('SELECT investorid,investors.name as investor,contributions,'
        //     + ' projects.budget,sum(projectcost.amount) as project_cost,projectsale.netprofit,'
        //     + ' contributors.officeshare as office_percentage, projects.landcost,projects.taxes,projects.commission,'
        //     + ' CAST((projectsale.netprofit)*(contributors.officeshare/100) AS INT)  as office_share,projectsale.totalprice'
        //     + ' from contributors INNER JOIN investors on investors.id=contributors.investorid'
        //     + ' inner join projectsale on projectsale.project_id=contributors.projectid'
        //     + ' inner join projectcost on projectsale.project_id=projectcost.project'
        //     + ' inner join projects on projects.project_id=contributors.projectid'
        //     + ' where projects.project_id=' + id);

        const [rows_profit] = await db.execute('SELECT investors.id AS investorid, investors.name AS investor,'
            + ' contributors.contributions, projects.budget, total_project_cost.project_cost AS project_cost, projectsale.netprofit,'
            + ' contributors.officeshare AS office_percentage, projects.landcost, projects.taxes, projects.commission,'
            //+' CAST((projectsale.netprofit * (contributors.officeshare / 100)) AS INT) AS office_share,' 
            + ' projectsale.totalprice FROM contributors INNER JOIN investors ON investors.id = contributors.investorid'
            + ' INNER JOIN projectsale ON projectsale.project_id = contributors.projectid'
            + ' INNER JOIN (SELECT project, SUM(amount) AS project_cost FROM projectcost GROUP BY project) AS total_project_cost ON'
            + ' projectsale.project_id = total_project_cost.project'
            + ' INNER JOIN projects ON projects.project_id = contributors.projectid'
            + ' where projects.project_id=' + id);

        const _temp = rows_profit.map(row => ({

            investorid: row.investorid,
            investor: row.investor,
            contributions: row.contributions,
            budget: row.budget,
            price: row.totalprice,
            cost: Number(row.project_cost) + Number(row.landcost) + Number(row.taxes) + Number(row.commission),
            netprofit: row.netprofit,
            investorshare: Math.round((Number(row.contributions) / (Number(row.project_cost) + Number(row.landcost) + Number(row.taxes) + Number(row.commission)) * Number(row.netprofit))) - Math.round((Number(row.contributions) / (Number(row.project_cost) + Number(row.landcost) + Number(row.taxes) + Number(row.commission)) * Number(row.netprofit))) * Number(row.office_percentage / 100),
            officeshare: Math.round((Number(row.contributions) / (Number(row.project_cost) + Number(row.landcost) + Number(row.taxes) + Number(row.commission)) * Number(row.netprofit))) * Number(row.office_percentage / 100),
            officepercentage: row.office_percentage,

        }));

        res.json(_temp);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};
exports.addProjectSale = async (req, res) => {
    try {
        const proj_id = req.body.project;
        console.log(proj_id);
        const [rows_cost] = await db.execute('SELECT sum(cost.amount) as totalcost,prj.landcost,prj.taxes,prj.commission  FROM ' +
            '`projectcost` AS cost ' +
            ' INNER JOIN `projects` as prj ON cost.project=prj.project_id' +
            ' where cost.project=' + proj_id);

        const _temp = rows_cost.map(row => ({

            totalcost: Number(row.totalcost) + Number(row.landcost) + Number(row.taxes) + Number(row.commission)


        }));
        console.log(_temp[0].totalcost);
        const sellingprice = req.body.sellingprice;
        const sellingdate = req.body.sellingdate;
        const taxes = req.body.taxes;
        const commission = req.body.commission;
        const totalprice = Number(sellingprice) - (Number(taxes) + Number(commission));
        const netprofit = (Number(sellingprice) - (Number(taxes) + Number(commission))) - Number(_temp[0].totalcost);





        const [result] = await db.execute(

            'INSERT INTO projectsale (sellingdate, project_id,sellingprice,taxes, commission,totalprice,netprofit)' +
            ' VALUES (?,?,?,?,?,?,?)',
            [sellingdate, proj_id, sellingprice, taxes, commission, totalprice, netprofit]
        );
        const [data] = await db.execute('SELECT * FROM projectsale WHERE project_id = ?', [
            result.insertId,
        ]);
        res.json(data[0]);


    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};
exports.updateProjectSale = async (req, res) => {
    try {
        const id = req.body.id;
        const project = req.body.project;
        const [rows_cost] = await db.execute('SELECT sum(cost.amount) as totalcost,prj.landcost,prj.taxes,prj.commission  FROM ' +
            '`projectcost` AS cost ' +
            ' INNER JOIN `projects` as prj ON cost.project=prj.project_id' +
            ' where cost.project=' + project);

        const _temp = rows_cost.map(row => ({

            totalcost: Number(row.totalcost) + Number(row.landcost) + Number(row.taxes) + Number(row.commission)


        }));

        const sellingprice = req.body.sellingprice;
        const sellingdate = req.body.sellingdate;
        const taxes = req.body.taxes;
        const commission = req.body.commission;
        const totalprice = Number(sellingprice) - (Number(taxes) + Number(commission));
        const netprofit = (Number(sellingprice) - (Number(taxes) + Number(commission))) - Number(_temp[0].totalcost);

        const query = 'UPDATE projectsale SET sellingdate = ?,sellingprice=?,taxes=?,commission=?,totalprice = ?,netprofit = ? WHERE id = ?';

        const params = [
            sellingdate, sellingprice, taxes, commission, totalprice, netprofit, id
        ];

        const [result] = await db.execute(query, params);
        const [data] = await db.execute('SELECT * FROM projectsale WHERE id = ?', [
            result.insertId,
        ]);
        res.json(data[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};
exports.updateProject = async (req, res) => {

    const id = req.body.id;
    const project_name = req.body.name;
    const description = req.body.description;
    const budget = req.body.budget;
    const location = req.body.location;
    const startdate = req.body.startdate;
    const enddate = req.body.enddate;
    const status = req.body.status;
    const landcost = req.body.landcost;
    const taxes = req.body.taxes;
    const commission = req.body.commission;
    const notes = req.body.notes;
    const coveredarea = req.body.coveredarea;
    const type = req.body.type;

   

    try {

        const [rows] = await db.execute('SELECT * FROM projects WHERE project_name = ? and project_id!=?', [
            project_name,id
        ]);
        if (rows.length != 0) {

            console.log("------> Project with this name already exists");
            //res.sendStatus(409);
            res.status(409).json({ message: 'Project with this name already exists.' });
        }
        else {
            const query = 'UPDATE projects SET project_name = ?,project_description=?,location_id=?,start_date = ?,end_date = ?,budget = ?,' +
                'status = ?, landcost = ?, taxes = ?, commission = ?, notes = ?, coveredarea=?,type=? WHERE project_id = ?';

            const params = [
                project_name,
                description,
                location,
                startdate,
                enddate,
                budget,
                status,
                landcost,
                taxes,
                commission,
                notes,
                coveredarea,
                type,
                id
            ];
            const [result] = await db.execute(query, params);
            
            if(status=='Completed'){
               
                const [rows_restore] = await db.execute('SELECT projectid FROM restore_investment WHERE projectid=?', [
                    id
                ]);
                if (rows_restore.length != 0) {
                    res.status(200).json({message:'Updated Successfully.'});
                }
                else{

                    const [rows_contribution] = await db.execute('SELECT investorid,contributions FROM contributors WHERE projectid=?', [
                        id
                    ]);
                    if (rows_contribution.length != 0) {
                        
                        
                        const res_inv = rows_contribution.map(row => ({
                            investorid: row.investorid,
                            contributions: row.contributions,
                            
                        }));
                        //console.log(res_inv);
                        res_inv.forEach(async element => {
                        // console.log(element.investorid+' '+element.contributions);
                         const [restoreinvst] =  await db.execute('INSERT INTO restore_investment (projectid, investorid,amount) VALUES (?,?,?)',
                                 [id, element.investorid,element.contributions]);
                           
                      });
                    }

                }
               
            }
            else if(status!='Completed'){
               
                    const [result] = await db.execute('Delete FROM restore_investment WHERE projectid = ?', [id]);
                    res.status(200).json({message:'Updated Successfully.'});
                

            }
           

            
            // const [data] = await db.execute('SELECT * FROM projects WHERE project_id = ?', [
            //     result.insertId,
            // ]);
           

        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.assignProjecttoUsers = async (req, res) => {
    const userid = req.body.userid;
    const projects = req.body.projects;
    const flag = req.body.flag;

    try {
        if (flag == 1) {
            for (const projectId of projects) {
                // Build and execute the DELETE query for each project
                const [rows] = await db.execute('DELETE FROM userprojects WHERE userid = ? AND projectid = ?', [userid, projectId]);

                // Check the result if needed
                if (rows.affectedRows > 0) {
                    console.log(`Deleted records for userId ${userid} and projectId ${projectId}`);
                } else {
                    console.log(`No records found for userId ${userid} and projectId ${projectId}`);
                }
            }

            res.json({ message: 'Records deleted successfully' });
        }
        else {
            for (const projectId of projects) {

                // Build and execute the DELETE query for each project
                const [rows] = await db.execute('Insert into userprojects (userid,projectid) Values(?,?)', [userid, projectId]);

            }

            res.json({ message: 'Records inserted successfully' });
        }

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Get Today's Rent Payments
exports.getTodayRentPayments = async (req, res) => {
    const db = require('../models/db');
    
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        const [rows] = await db.execute(`
            SELECT 
                vr.id,
                vr.trip_id,
                t.trip_no,
                v.number as vehicle_no,
                v.type as vehicle_type,
                vr.distance_km,
                vr.rent_per_km,
                vr.total_rent,
                tr.PaymentMode as payment_source,
                vr.transactionID,
                tr.AccountID,
                a.AccountTitle as account_name,
                vr.CD as created_date
            FROM vehicle_rent vr
            LEFT JOIN trips t ON t.id = vr.trip_id AND t.active = 1
            LEFT JOIN vehicles v ON v.id = vr.vehicle_id AND v.active = 1
            LEFT JOIN transactions tr ON tr.ID = vr.transactionID AND tr.active = 1
            LEFT JOIN accounts a ON a.ID = tr.AccountID AND a.active = 1
            WHERE vr.Active = 1
              AND vr.CD >= ? AND vr.CD < ?
            ORDER BY vr.CD DESC
        `, [startStr, endStr]);
        
        res.json(rows || []);
    } catch (err) {
        console.error('Error fetching rent payments:', err);
        res.status(500).json({ message: 'Error fetching rent payments', error: err.message });
    }
};

// Get Payments to Dealers (filtered by date range)
exports.getTodayDealerPayments = async (req, res) => {
    const db = require('../models/db');
    
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        const [rows] = await db.execute(`
            SELECT 
                p.id,
                p.transactionID,
                p.DepoID,
                d.name as depo_name,
                c.name as company_name,
                p.Amount,
                t.Purpose,
                t.PaymentMode as PaymentMethod,
                t.AccountID,
                a.AccountTitle as account_name,
                p.CD as created_date
            FROM payments p
            INNER JOIN transactions t ON t.ID = p.transactionID AND t.active = 1
            LEFT JOIN depo d ON d.id = p.DepoID AND d.active = 1
            LEFT JOIN depo_company dc ON dc.depo_id = d.id AND dc.active = 1
            LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
            LEFT JOIN accounts a ON a.ID = t.AccountID AND a.active = 1
            WHERE (t.Purpose LIKE '%Payment to %' OR t.Purpose LIKE 'Payment for %')
              AND t.active = 1
              AND p.active = 1
              AND p.DepoID IS NOT NULL
              AND p.CD >= ? AND p.CD < ?
            ORDER BY p.CD DESC
        `, [startStr, endStr]);
        
        res.json(rows || []);
    } catch (err) {
        console.error('Error fetching dealer payments:', err);
        res.status(500).json({ message: 'Error fetching dealer payments', error: err.message });
    }
};

// Get Recoveries (filtered by date range)
exports.getTodayRecoveries = async (req, res) => {
    const db = require('../models/db');
    
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly'
        
        // Calculate date range based on filter
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let dateStart = null;
        let dateEnd = null;
        
        switch (filter) {
            case 'daily':
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'weekly':
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 6);
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'monthly':
                // Last 30 days: from 30 days ago to start of tomorrow
                dateStart = new Date(today);
                dateStart.setDate(dateStart.getDate() - 29); // 30 days including today
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
                break;
            case 'yearly':
                dateStart = new Date(now.getFullYear(), 0, 1);
                dateEnd = new Date(now.getFullYear() + 1, 0, 1);
                break;
            default:
                dateStart = today;
                dateEnd = new Date(today);
                dateEnd.setDate(dateEnd.getDate() + 1);
        }
        
        // Format dates for MySQL (YYYY-MM-DD HH:MM:SS)
        const formatDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day} 00:00:00`;
        };
        
        const startStr = formatDateTime(dateStart);
        const endStr = formatDateTime(dateEnd);
        
        const [rows] = await db.execute(`
            SELECT 
                r.id,
                r.trip_id,
                t.trip_no,
                r.ClientID,
                c.name as client_name,
                r.Amount,
                r.Date as recovery_date,
                COALESCE(tr.PaymentMode, r.Payment_Head, 'N/A') as PaymentMethod,
                r.transactionID,
                tr.AccountID,
                a.AccountTitle as account_name,
                r.CD as created_date
            FROM recoveries r
            LEFT JOIN trips t ON t.id = r.trip_id AND t.active = 1
            LEFT JOIN customers c ON c.id = r.ClientID AND c.active = 1
            LEFT JOIN transactions tr ON tr.ID = r.transactionID AND tr.active = 1
            LEFT JOIN accounts a ON a.ID = tr.AccountID AND a.active = 1
            WHERE r.Active = 1
              AND r.CD >= ? AND r.CD < ?
            ORDER BY r.CD DESC
        `, [startStr, endStr]);
        
        res.json(rows || []);
    } catch (err) {
        console.error('Error fetching recoveries:', err);
        res.status(500).json({ message: 'Error fetching recoveries', error: err.message });
    }
};




