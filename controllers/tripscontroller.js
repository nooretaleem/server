const db = require('../models/db');

function resolveAuditUser(body = {}, fallback = 'System') {
    return (
        body.MB ||
        body.CB ||
        body.userName ||
        body.username ||
        body.UserName ||
        body.createdBy ||
        body.modifiedBy ||
        fallback
    ).toString().trim() || fallback;
}

// Helper function to check and mark trip as Completed if all payments, recoveries are cleared and all fuel is sold
async function checkAndCloseTrip(connection, tripId) {
    try {
        // Check if all trip_depos are fully paid (paid_amount >= payable_amount)
        // This covers both payments and recoveries since both update trip_depos.paid_amount
        const [tripDeposCheck] = await connection.execute(
            `SELECT COUNT(*) as total_count,
                    SUM(CASE WHEN paid_amount >= payable_amount THEN 1 ELSE 0 END) as paid_count
             FROM trip_depos
             WHERE trip_id = ? AND Active = 1`,
            [tripId]
        );

        const totalCount = parseInt(tripDeposCheck[0]?.total_count || 0);
        const paidCount = parseInt(tripDeposCheck[0]?.paid_count || 0);

        // Check if all fuel is sold (sum of quantity_ltr from trip_products equals sum of fuel from pol_sale)
        const [fuelCheck] = await connection.execute(
            `SELECT 
                COALESCE((SELECT SUM(quantity_ltr) FROM trip_products WHERE trip_id = ? AND Active = 1), 0) as total_fuel,
                COALESCE((SELECT SUM(fuel) FROM pol_sale WHERE trip_id = ? AND Active = 1), 0) as sold_fuel
            `,
            [tripId, tripId]
        );

        const totalFuel = parseFloat(fuelCheck[0]?.total_fuel || 0);
        const soldFuel = parseFloat(fuelCheck[0]?.sold_fuel || 0);

        // If all payments/recoveries are cleared and all fuel is sold, update status to 'Completed'
        // Also allow completing if there's no fuel to sell (totalFuel = 0) and all payments are cleared
        if (totalCount > 0 && paidCount === totalCount && (totalFuel === 0 || (totalFuel > 0 && soldFuel >= totalFuel))) {
            await connection.execute(
                `UPDATE trips 
                 SET status = 'Completed', 
                     completed_at = NOW(),
                     MD = NOW()
                 WHERE id = ? AND status != 'Completed' AND status != 'Cancelled'`,
                [tripId]
            );
            console.log(`Trip ${tripId} status updated to Completed - all payments/recoveries cleared and all fuel sold`);
        }
        return true;
    } catch (err) {
        console.error(`[checkAndCloseTrip] Failed for trip ${tripId}:`, err);
        return false;
    }
}

// Helper function to recalculate all balances in cash_in_hand table
async function recalculateAllBalances(connection) {
    try {
        // Get all active records ordered by id ASC (IDs are sequential and represent insertion order)
        // This ensures correct balance calculation regardless of created_at timestamp issues
        const [allRecords] = await connection.execute(`
            SELECT id, debit, credit
            FROM cash_in_hand
            WHERE Active = 1
            ORDER BY id ASC
        `);

        let runningBalance = 0;

        // Update each record with its running balance
        // Credit adds to balance, Debit subtracts from balance
        for (const record of allRecords) {
            runningBalance += (record.credit || 0) - (record.debit || 0);

            await connection.execute(`
                UPDATE cash_in_hand
                SET balance = ?
                WHERE id = ?
            `, [runningBalance, record.id]);
        }
    } catch (err) {
        console.error('Error recalculating balances:', err);
        throw err;
    }
}

// Helper function to recalculate advance_balance balances for a depo
// Recalculates all active rows in chronological order
async function recalculateAdvanceBalances(connection, depoId) {
    try {
        // Get all active advance_balance rows for this depo, ordered by ID (chronological)
        const [advanceRows] = await connection.execute(
            `SELECT ID, Debit, Credit, Balance
             FROM advance_balance
             WHERE DepoID = ? AND Active = 1
             ORDER BY ID ASC`,
            [depoId]
        );

        if (advanceRows.length === 0) {
            console.log(`No advance_balance rows found for depo ${depoId}`);
            return 0; // Return 0 if no rows
        }

        let runningBalance = 0;

        // Recalculate Balance for each row: Balance = previous Balance - Debit + Credit
        for (const row of advanceRows) {
            const debit = parseFloat(row.Debit) || 0;
            const credit = parseFloat(row.Credit) || 0;

            // Calculate new balance: previous balance - debit + credit
            runningBalance = runningBalance - debit + credit;

            // Update this row's Balance
            await connection.execute(
                `UPDATE advance_balance SET Balance = ? WHERE ID = ?`,
                [runningBalance, row.ID]
            );

            console.log(`Recalculated advance_balance row ${row.ID}: New Balance=${runningBalance} (Debit=${debit}, Credit=${credit})`);
        }

        return runningBalance; // Return final balance
    } catch (err) {
        console.error('Error recalculating advance balances:', err);
        throw err;
    }
}

// Helper function to recalculate pool balances for a depo starting from a specific row ID
// If startFromRowId is provided, recalculate from the row before it forward
async function _recalculatePoolBalancesFromRow(connection, depoId, startFromRowId = null) {
    try {
        // Get initial balance (where TripID IS NULL, payment_id IS NULL, recovery_id IS NULL, active = 1)
        const [initialBalanceRows] = await connection.execute(
            `SELECT ID, DepoLimit FROM pool 
             WHERE DepoID = ? AND TripID IS NULL AND payment_id IS NULL AND recovery_id IS NULL AND active = 1 
             ORDER BY ID ASC LIMIT 1`,
            [depoId]
        );

        if (initialBalanceRows.length === 0) {
            console.log(`No initial balance row found for depo ${depoId}`);
            return null;
        }

        const initialBalance = parseFloat(initialBalanceRows[0].DepoLimit || 0);
        const initialBalanceRowId = initialBalanceRows[0].ID;

        let currentBalance = initialBalance;
        let poolRows;

        if (startFromRowId) {
            // Find the row immediately before startFromRowId to get the previous balance
            const [previousRow] = await connection.execute(
                `SELECT DepoLimit FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID < ?
                 ORDER BY ID DESC LIMIT 1`,
                [depoId, startFromRowId]
            );
            if (previousRow.length > 0) {
                currentBalance = parseFloat(previousRow[0].DepoLimit || 0);
            }

            // Get all rows from startFromRowId onwards (active = 1)
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit 
                 FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID >= ?
                 ORDER BY ID ASC`,
                [depoId, startFromRowId]
            );
        } else {
            // Get all rows except initial balance row (active = 1)
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit 
                 FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID != ?
                 ORDER BY ID ASC`,
                [depoId, initialBalanceRowId]
            );
        }

        // Recalculate DepoLimit for all rows
        // Formula: New DepoLimit = Previous DepoLimit - Debit + Credit
        for (const row of poolRows) {
            const debit = parseFloat(row.Debit) || 0;
            const credit = parseFloat(row.Credit) || 0;

            // Calculate new balance: previous balance - debit + credit
            currentBalance = currentBalance - debit + credit;

            // Update this row's DepoLimit
            await connection.execute(
                `UPDATE pool SET DepoLimit = ? WHERE ID = ?`,
                [currentBalance, row.ID]
            );

            console.log(`Recalculated pool row ${row.ID}: New DepoLimit=${currentBalance} (Debit=${debit}, Credit=${credit})`);
        }

        // Return the final balance for depo table update
        const finalBalance = poolRows.length > 0 ? currentBalance : initialBalance;
        return finalBalance;
    } catch (err) {
        console.error('Error recalculating pool balances:', err);
        throw err;
    }
}
async function recalculatePoolBalancesFromRow(connection, depoId, startFromRowId = null, recalculateAll = false) {
    try {
        console.log(`Recalculating pool balances for depo ${depoId}, startFromRowId: ${startFromRowId || 'none'}, recalculateAll: ${recalculateAll}`);

        // Get the first active row (initial balance)
        const [initialRows] = await connection.execute(
            `SELECT ID, DepoLimit FROM pool 
             WHERE DepoID = ? AND TripID IS NULL AND payment_id IS NULL AND recovery_id IS NULL AND active = 1 
             ORDER BY ID ASC LIMIT 1`,
            [depoId]
        );

        if (initialRows.length === 0) {
            console.warn(`No initial balance row found for depo ${depoId}`);

            // Try to find any active row to use as starting point
            const [anyRows] = await connection.execute(
                `SELECT ID, DepoLimit FROM pool 
                 WHERE DepoID = ? AND active = 1 
                 ORDER BY ID ASC LIMIT 1`,
                [depoId]
            );

            if (anyRows.length === 0) {
                console.warn(`No active rows found for depo ${depoId}`);
                return null;
            }

            // If there are rows but no initial balance, set first row as initial
            console.warn(`Using first active row as initial balance for depo ${depoId}`);
            const firstRow = anyRows[0];
            await connection.execute(
                `UPDATE pool SET TripID = NULL, payment_id = NULL, recovery_id = NULL 
                 WHERE ID = ?`,
                [firstRow.ID]
            );

            return parseFloat(firstRow.DepoLimit || 0);
        }

        let currentBalance = parseFloat(initialRows[0].DepoLimit || 0);
        const initialBalanceRowId = initialRows[0].ID;

        console.log(`Initial balance for depo ${depoId}: ${currentBalance} (Row ID: ${initialBalanceRowId})`);

        let poolRows = [];

        if (recalculateAll) {
            // Recalculate all rows from scratch
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit, TripID, payment_id, recovery_id
                 FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID > ?
                 ORDER BY ID ASC`,
                [depoId, initialBalanceRowId]
            );
        } else if (startFromRowId) {
            // Get the row before startFromRowId to get previous balance
            const [previousRow] = await connection.execute(
                `SELECT ID, DepoLimit FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID < ?
                 ORDER BY ID DESC LIMIT 1`,
                [depoId, startFromRowId]
            );

            if (previousRow.length > 0) {
                // Start from the balance of the previous row
                currentBalance = parseFloat(previousRow[0].DepoLimit || 0);
                console.log(`Starting from previous row ${previousRow[0].ID} with balance: ${currentBalance}`);
            } else {
                // No previous row, start from initial balance
                console.log(`No previous row found, starting from initial balance: ${currentBalance}`);
            }

            // Get all rows from startFromRowId onwards (including the deleted rows that were set to active=0)
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit, TripID, payment_id, recovery_id, active
                 FROM pool 
                 WHERE DepoID = ? AND ID >= ? AND active = 1
                 ORDER BY ID ASC`,
                [depoId, startFromRowId]
            );

            console.log(`Found ${poolRows.length} rows to recalculate from ID ${startFromRowId}`);
        } else {
            // Get all rows except initial balance row
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit, TripID, payment_id, recovery_id
                 FROM pool 
                 WHERE DepoID = ? AND active = 1 AND ID != ?
                 ORDER BY ID ASC`,
                [depoId, initialBalanceRowId]
            );

            console.log(`Found ${poolRows.length} rows to recalculate (excluding initial row)`);
        }

        // Recalculate balances for all rows
        let updatedCount = 0;
        for (const row of poolRows) {
            const debit = parseFloat(row.Debit || 0);
            const credit = parseFloat(row.Credit || 0);

            // Store previous balance for logging
            const previousBalance = currentBalance;

            // Calculate new balance: previous balance - debit + credit
            currentBalance = previousBalance - debit + credit;

            // Update this row's DepoLimit
            await connection.execute(
                `UPDATE pool SET DepoLimit = ? WHERE ID = ?`,
                [currentBalance, row.ID]
            );
            updatedCount++;

            console.log(`Updated pool row ${row.ID}: ${previousBalance} - ${debit} + ${credit} = ${currentBalance}`);
        }

        console.log(`Updated ${updatedCount} pool rows for depo ${depoId}`);

        // Return the final balance
        return currentBalance;

    } catch (err) {
        console.error(`Error recalculating pool balances for depo ${depoId}:`, err);
        throw err;
    }
}

async function recalculateSpCreditBalancesFromRow(connection, depoId, startFromRowId = null, recalculateAll = false) {
    try {
        console.log(`Recalculating special_credit_limit balances for depo ${depoId}, startFromRowId: ${startFromRowId || 'none'}, recalculateAll: ${recalculateAll}`);

        // Get the first active row (initial balance)
        const [initialRows] = await connection.execute(
            `SELECT ID, DepoLimit FROM special_credit_limit 
             WHERE DepoID = ? AND TripID IS NULL AND payment_id IS NULL AND recovery_id IS NULL AND active = 1 
             ORDER BY ID ASC LIMIT 1`,
            [depoId]
        );

        if (initialRows.length === 0) {
            console.warn(`No initial balance row found for depo ${depoId}`);

            // Try to find any active row to use as starting point
            const [anyRows] = await connection.execute(
                `SELECT ID, DepoLimit FROM special_credit_limit 
                 WHERE DepoID = ? AND active = 1 
                 ORDER BY ID ASC LIMIT 1`,
                [depoId]
            );

            if (anyRows.length === 0) {
                console.warn(`No active rows found for depo ${depoId}`);
                return null;
            }

            // If there are rows but no initial balance, set first row as initial
            console.warn(`Using first active row as initial balance for depo ${depoId}`);
            const firstRow = anyRows[0];
            await connection.execute(
                `UPDATE special_credit_limit SET TripID = NULL, payment_id = NULL, recovery_id = NULL 
                 WHERE ID = ?`,
                [firstRow.ID]
            );

            return parseFloat(firstRow.DepoLimit || 0);
        }

        let currentBalance = parseFloat(initialRows[0].DepoLimit || 0);
        const initialBalanceRowId = initialRows[0].ID;

        console.log(`Initial balance for depo ${depoId}: ${currentBalance} (Row ID: ${initialBalanceRowId})`);

        let poolRows = [];

        if (recalculateAll) {
            // Recalculate all rows from scratch
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit, TripID, payment_id, recovery_id
                 FROM special_credit_limit 
                 WHERE DepoID = ? AND active = 1 AND ID > ?
                 ORDER BY ID ASC`,
                [depoId, initialBalanceRowId]
            );
        } else if (startFromRowId) {
            // Get the row before startFromRowId to get previous balance
            const [previousRow] = await connection.execute(
                `SELECT ID, DepoLimit FROM special_credit_limit 
                 WHERE DepoID = ? AND active = 1 AND ID < ?
                 ORDER BY ID DESC LIMIT 1`,
                [depoId, startFromRowId]
            );

            if (previousRow.length > 0) {
                // Start from the balance of the previous row
                currentBalance = parseFloat(previousRow[0].DepoLimit || 0);
                console.log(`Starting from previous row ${previousRow[0].ID} with balance: ${currentBalance}`);
            } else {
                // No previous row, start from initial balance
                console.log(`No previous row found, starting from initial balance: ${currentBalance}`);
            }

            // Get all rows from startFromRowId onwards (including the deleted rows that were set to active=0)
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit, TripID, payment_id, recovery_id, active
                 FROM special_credit_limit 
                 WHERE DepoID = ? AND ID >= ? AND active = 1
                 ORDER BY ID ASC`,
                [depoId, startFromRowId]
            );

            console.log(`Found ${poolRows.length} rows to recalculate from ID ${startFromRowId}`);
        } else {
            // Get all rows except initial balance row
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit, TripID, payment_id, recovery_id
                 FROM special_credit_limit 
                 WHERE DepoID = ? AND active = 1 AND ID != ?
                 ORDER BY ID ASC`,
                [depoId, initialBalanceRowId]
            );

            console.log(`Found ${poolRows.length} rows to recalculate (excluding initial row)`);
        }

        // Recalculate balances for all rows
        let updatedCount = 0;
        for (const row of poolRows) {
            const debit = parseFloat(row.Debit || 0);
            const credit = parseFloat(row.Credit || 0);

            // Store previous balance for logging
            const previousBalance = currentBalance;

            // Calculate new balance: previous balance - debit + credit
            currentBalance = previousBalance - debit + credit;

            // Update this row's DepoLimit
            await connection.execute(
                `UPDATE special_credit_limit SET DepoLimit = ? WHERE ID = ?`,
                [currentBalance, row.ID]
            );
            updatedCount++;

            console.log(`Updated special_credit_limit row ${row.ID}: ${previousBalance} - ${debit} + ${credit} = ${currentBalance}`);
        }

        console.log(`Updated ${updatedCount} special_credit_limit rows for depo ${depoId}`);

        // Return the final balance
        return currentBalance;

    } catch (err) {
        console.error(`Error recalculating special_credit_limit balances for depo ${depoId}:`, err);
        throw err;
    }
}
async function _recalculateSpCreditBalancesFromRow(connection, depoId, startFromRowId = null) {
    try {
        // Get initial balance (where TripID IS NULL, payment_id IS NULL, recovery_id IS NULL, active = 1)
        const [initialBalanceRows] = await connection.execute(
            `SELECT ID, DepoLimit FROM special_credit_limit 
             WHERE DepoID = ? AND TripID IS NULL AND payment_id IS NULL AND recovery_id IS NULL AND active = 1 
             ORDER BY ID ASC LIMIT 1`,
            [depoId]
        );

        if (initialBalanceRows.length === 0) {
            console.log(`No initial balance row found for depo ${depoId}`);
            return null;
        }

        const initialBalance = parseFloat(initialBalanceRows[0].DepoLimit || 0);
        const initialBalanceRowId = initialBalanceRows[0].ID;

        let currentBalance = initialBalance;
        let poolRows;

        if (startFromRowId) {
            // Find the row immediately before startFromRowId to get the previous balance
            const [previousRow] = await connection.execute(
                `SELECT DepoLimit FROM special_credit_limit
                 WHERE DepoID = ? AND active = 1 AND ID < ?
                 ORDER BY ID DESC LIMIT 1`,
                [depoId, startFromRowId]
            );
            if (previousRow.length > 0) {
                currentBalance = parseFloat(previousRow[0].DepoLimit || 0);
            }

            // Get all rows from startFromRowId onwards (active = 1)
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit 
                 FROM special_credit_limit
                 WHERE DepoID = ? AND active = 1 AND ID >= ?
                 ORDER BY ID ASC`,
                [depoId, startFromRowId]
            );
        } else {
            // Get all rows except initial balance row (active = 1)
            [poolRows] = await connection.execute(
                `SELECT ID, Debit, Credit, DepoLimit 
                 FROM special_credit_limit
                 WHERE DepoID = ? AND active = 1 AND ID != ?
                 ORDER BY ID ASC`,
                [depoId, initialBalanceRowId]
            );
        }

        // Recalculate DepoLimit for all rows
        // Formula: New DepoLimit = Previous DepoLimit - Debit + Credit
        for (const row of poolRows) {
            const debit = parseFloat(row.Debit) || 0;
            const credit = parseFloat(row.Credit) || 0;

            // Calculate new balance: previous balance - debit + credit
            currentBalance = currentBalance - debit + credit;

            // Update this row's DepoLimit
            await connection.execute(
                `UPDATE special_credit_limit  SET DepoLimit = ? WHERE ID = ?`,
                [currentBalance, row.ID]
            );

            console.log(`Recalculated special_credit_limit  row ${row.ID}: New DepoLimit=${currentBalance} (Debit=${debit}, Credit=${credit})`);
        }

        // Return the final balance for depo table update
        const finalBalance = poolRows.length > 0 ? currentBalance : initialBalance;
        return finalBalance;
    } catch (err) {
        console.error('Error recalculating special_credit_limit  balances:', err);
        throw err;
    }
}
// Get all trips with related data
exports.getTrips = async (req, res) => {
    try {
        const query = `
            SELECT 
                t.id,
                t.trip_no,
                t.start_date,
                t.vehicle_id,
    v.number AS vehicle_number,
    d.name AS driver_name,
                t.amount_collected,
                t.paid,
                t.status,
                t.completed_at,
                t.total_amount,
                t.CD,
                t.CB,
                t.MD,

                tr.cash_in_hand_id,
                tr.AccountID,
    a.AccountNo AS account_no,
    a.BankID AS bank_id,
    b.Name AS bank_name,

                CASE 
                    WHEN tr.cash_in_hand_id IS NOT NULL THEN 'Cash in Hand'
                    WHEN tr.AccountID IS NOT NULL AND b.Name IS NOT NULL THEN b.Name
                    ELSE NULL
    END AS account_head_display,

    td.depo_name,
    COALESCE((SELECT SUM(tp2.quantity_ltr) 
              FROM trip_products tp2 
              WHERE tp2.trip_id = t.id AND tp2.Active = 1), 0) AS fuel,

    td.purchase_type,
    td.non_cash_paid,
    td.non_cash_payable

            FROM trips t
            LEFT JOIN vehicles v ON t.vehicle_id = v.id
            LEFT JOIN drivers d ON v.driver_id = d.id

/* Aggregate trip_depos first */
LEFT JOIN (
    SELECT 
        td.trip_id,
        GROUP_CONCAT(DISTINCT dep.name ORDER BY dep.name SEPARATOR ', ') AS depo_name,
        GROUP_CONCAT(DISTINCT td.purchase_type ORDER BY td.purchase_type SEPARATOR ', ') AS purchase_type,
        SUM(CASE WHEN td.purchase_type != 'cash' THEN td.paid_amount ELSE 0 END) AS non_cash_paid,
        SUM(CASE WHEN td.purchase_type != 'cash' THEN td.payable_amount ELSE 0 END) AS non_cash_payable
    FROM trip_depos td
    JOIN depo dep ON td.depo_id = dep.id AND dep.active = 1
    WHERE td.Active = 1
    GROUP BY td.trip_id
) td ON td.trip_id = t.id

/* First transaction per trip */
            LEFT JOIN (
                SELECT tr1.*
                FROM transactions tr1
                INNER JOIN (
        SELECT trip_id, MIN(ID) AS min_id
                    FROM transactions
                    WHERE active = 1
                    GROUP BY trip_id
                ) tr2 ON tr1.ID = tr2.min_id AND tr1.trip_id = tr2.trip_id
                WHERE tr1.active = 1
            ) tr ON tr.trip_id = t.id

            LEFT JOIN accounts a ON a.ID = tr.AccountID AND a.active = 1
            LEFT JOIN bank b ON a.BankID = b.ID AND b.active = 1

            WHERE t.active = 1
ORDER BY t.start_date DESC, t.id DESC `;
        const [rows] = await db.execute(query);
        console.log(JSON.stringify(rows));
        res.json(rows);
    } catch (err) {
        console.error('Error fetching trips:', err);
        console.error('Error details:', {
            code: err.code,
            sqlMessage: err.sqlMessage,
            sqlState: err.sqlState,
            errno: err.errno
        });
        // If table doesn't exist, return empty array
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message,
                sqlMessage: err.sqlMessage,
                code: err.code
            });
        }
    }
};

// Get filtered pol_sales by date range (daily, weekly, monthly, yearly)
exports.getFilteredPolSales_old = async (req, res) => {
    try {
        const { filter } = req.query; // Get filter from query params: 'daily', 'weekly', 'monthly', 'yearly', or undefined for all

        // Build date range condition if filter is provided
        let dateCondition = '';
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
                dateCondition = `AND ps.CD >= '${startStr}' AND ps.CD < '${endStr}'`;
            }
        }

        const query = `
            SELECT 
                ps.id,
                ps.trip_id,
                ps.trip_product_id,
                ps.client_id,
                ps.Qty,
                ps.capacity,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.date,
                ps.container_type,
                c.name as client_name,
                t.trip_no,
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            WHERE ps.Active = 1
            ${dateCondition}
            ORDER BY ps.date DESC, ps.id DESC
        `;

        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching filtered pol sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message
            });
        }
    }
};

exports.getFilteredPolSales = async (req, res) => {
    let connection;

    try {
        const { filter } = req.query;

        // ✅ Validate filter parameter
        const validFilters = ['daily', 'weekly', 'monthly', 'yearly'];
        if (filter && !validFilters.includes(filter)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid filter. Use: daily, weekly, monthly, yearly'
            });
        }

        connection = await db.getConnection();

        // Build date range condition with proper parameterized queries
        let dateCondition = '';
        let queryParams = [];

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
                    dateStart = new Date(today);
                    dateStart.setDate(dateStart.getDate() - 29);
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

                dateCondition = 'AND ps.CD >= ? AND ps.CD < ?';
                queryParams = [formatDateTime(dateStart), formatDateTime(dateEnd)];
            }
        }

        // ✅ Use parameterized query - NO string interpolation!
        const query = `
      SELECT 
        ps.id,
        ps.trip_id,
        ps.trip_product_id,
        ps.client_id,
        ps.Qty,
        ps.capacity,
        ps.fuel,
        ps.rate,
        ps.Discount,
        ps.total_amount,
        ps.date,
        ps.container_type,
        c.name as client_name,
        t.trip_no,
        tp.product_type as fuel_type
      FROM pol_sale ps
      LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
      LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
      LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
      WHERE ps.Active = 1
      ${dateCondition}
      ORDER BY ps.date DESC, ps.id DESC
    `;

        const [rows] = await connection.execute(query, queryParams);

        return res.status(200).json(rows);

    } catch (err) {
        console.error('Error fetching filtered pol sales:', err);

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
// Get today's POL sales (all customers sold fuel today)
exports.getTodayPolSales = async (req, res) => {
    try {
        const query = `
            SELECT 
                ps.id,
                ps.trip_id,
                ps.trip_product_id,
                ps.client_id,
                ps.Qty,
                ps.capacity,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.date,
                ps.container_type,
                c.name as client_name,
                pp.name as petrol_pump_name,
                t.trip_no,
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
            LEFT JOIN petrol_pumps pp ON ps.petrol_pump_id = pp.id AND pp.active = 1
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            WHERE ps.Active = 1
            ORDER BY ps.date DESC, ps.id DESC
        `;

        const [rows] = await db.execute(query);
        console.log('Fetched today\'s POL sales:', rows);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching today\'s POL sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message
            });
        }
    }
};

// Get single trip by ID
exports.getTrip = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        const query = `
            SELECT 
                t.trip_no,
                t.start_date,
                t.vehicle_id,
                v.number as vehicle_number,
                d.name as driver_name,
                t.amount_collected,
                t.paid,
                t.status,
                t.completed_at,
                t.total_amount,
                t.CD,
                t.CB,
                t.MD,
                a.BankID as bank_id,
                tr.AccountID as account_id,
                tr.cash_in_hand_id,
                tr.PaymentMode as payment_mode,
                tr.ReferenceNo as reference_no,
                CASE 
                    WHEN tr.cash_in_hand_id IS NOT NULL THEN 'cash_in_hand'
                    WHEN tr.AccountID IS NOT NULL THEN 'bank'
                    ELSE NULL
                END as account_head
            FROM trips t
            LEFT JOIN vehicles v ON t.vehicle_id = v.id
            LEFT JOIN drivers d ON v.driver_id = d.id
            LEFT JOIN (
                SELECT tr1.*
                FROM transactions tr1
                INNER JOIN (
                    SELECT trip_id, MIN(ID) as min_id
                    FROM transactions
                    WHERE active = 1
                    GROUP BY trip_id
                ) tr2 ON tr1.ID = tr2.min_id AND tr1.trip_id = tr2.trip_id
                WHERE tr1.active = 1
            ) tr ON tr.trip_id = t.id
            LEFT JOIN accounts a ON a.ID = tr.AccountID 
                AND a.active = 1
            WHERE t.id = ? AND t.active = 1
        `;
        const [rows] = await db.execute(query, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Trip not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching trip:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

exports.addTrip = async (req, res) => {
    try {
        console.log('Received trip data:', req.body);


        const {
            trip_no,
            start_date,
            vehicle_id,
            depo_id,
            fuel,
            cpl,
            products,
            spl,
            amount_collected,
            paid,
            payment_method,
            account_head,
            bank_id,
            account_id,
            payment_mode,
            reference_no,
            status,
            completed_at
        } = req.body;

        // Validate required fields
        if (!start_date || !vehicle_id) {
            console.log('Validation failed:', {
                start_date: !!start_date,
                vehicle_id: !!vehicle_id
            });
            return res.status(400).json({ message: 'Start date and vehicle are required' });
        }

        // Validate products array
        if (!products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ message: 'At least one product is required' });
        }

        // Validate each product
        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            if (!product.depo_id || !product.product_type || !product.quantity_ltr || product.invoice_rate === undefined || product.invoice_rate === null) {
                return res.status(400).json({
                    message: `Product ${i + 1} is missing required fields (depo_id, product_type, quantity_ltr, or invoice_rate)`
                });
            }

            // Validate purchase_type - INCLUDING specialcredit
            if (!product.purchase_type || !['cash', 'specialcredit', 'credit'].includes(product.purchase_type)) {
                return res.status(400).json({
                    message: `Product ${i + 1} must have a valid purchase_type (cash, specialcredit, or credit)`
                });
            }

            // Validate Mobile/Lube Oil specific fields
            if (product.product_type === 'Mobile/Lube Oil') {
                if (!product.container_type) {
                    return res.status(400).json({
                        message: `Product ${i + 1}: Container Type is required for Mobile/Lube Oil`
                    });
                }
                if (product.container_type === 'Cotton') {
                    if (!product.container_liters || !product.no_of_containers) {
                        return res.status(400).json({
                            message: `Product ${i + 1}: Container Size and No. of Containers are required for Cotton`
                        });
                    }
                }
            }
        }

        // Validate payment fields per product
        const hasCashOrAdvanceProducts = products && products.some(p => p.purchase_type === 'cash' || p.purchase_type === 'advance');

        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            if (product.purchase_type === 'cash' || product.purchase_type === 'advance') {
                product.account_head = 'Advance Balance';
                if (!product.account_head) {
                    return res.status(400).json({
                        message: `Product ${i + 1}: Account Head is required for Cash purchase types`
                    });
                }
                if (product.account_head === 'bank') {
                    if (!product.bank_id) {
                        return res.status(400).json({
                            message: `Product ${i + 1}: Bank is required when Account Head is Bank`
                        });
                    }
                    if (!product.account_id) {
                        return res.status(400).json({
                            message: `Product ${i + 1}: Account is required when Account Head is Bank`
                        });
                    }
                    if (!product.payment_mode) {
                        return res.status(400).json({
                            message: `Product ${i + 1}: Payment Mode is required when Account Head is Bank`
                        });
                    }
                }
            }
        }

        // Get connection for transaction
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const CB = resolveAuditUser(req.body, 'Admin');

            // Check depo balance for credit products
            let depoCosts = {};
            let depoBalances = {};
            let depoNames = {};

            if (products && products.length > 0) {
                // Calculate total cost per depo for credit products
                products.forEach(product => {
                    if (product.purchase_type === 'credit') {
                        const depoId = product.depo_id;
                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const cost = parseFloat(product.quantity_ltr) * rateAfterDiscount;
                        if (!depoCosts[depoId]) {
                            depoCosts[depoId] = 0;
                        }
                        depoCosts[depoId] += cost;
                    }
                });

                // Check balance for each depo with credit products
                for (const depoId of Object.keys(depoCosts)) {
                    const [depoRows] = await connection.execute(
                        `SELECT 
                            d.Balance,
                            d.name,
                            (
                                SELECT COALESCE(ab.Balance, 0)
                                FROM advance_balance ab
                                WHERE ab.DepoID = d.id AND ab.Active = 1
                                ORDER BY ab.ID DESC
                                LIMIT 1
                            ) as advance_balance
                         FROM depo d
                         WHERE d.id = ? AND d.active = 1`,
                        [depoId]
                    );

                    if (depoRows.length === 0) {
                        await connection.rollback();
                        connection.release();
                        return res.status(400).json({
                            message: `Depo with ID ${depoId} not found or inactive.`
                        });
                    }

                    const depoBalance = parseFloat(depoRows[0].Balance || 0);
                    const advanceBalance = parseFloat(depoRows[0].advance_balance || 0);
                    const depoName = depoRows[0].name || `Depo ${depoId}`;
                    depoBalances[depoId] = depoBalance;
                    depoNames[depoId] = depoName;
                    const totalCost = depoCosts[depoId];

                    const totalAvailable = advanceBalance + depoBalance;

                    if (totalCost > totalAvailable) {
                        await connection.rollback();
                        connection.release();
                        return res.status(400).json({
                            message: `Total cost (Rs. ${totalCost.toFixed(2)}) for credit products exceeds available funds (Rs. ${totalAvailable.toFixed(2)}) for depo "${depoName}". ` +
                                `Available: Advance (Rs. ${advanceBalance.toFixed(2)}) + Credit (Rs. ${depoBalance.toFixed(2)}). ` +
                                `Please reduce quantities or increase the depo balance.`
                        });
                    }
                }
            }

            const poolEntryIds = [];
            req.poolEntryIdsForTrip = poolEntryIds;

            // Calculate total paid amount from products with cash/advance purchase types
            let totalPaidAmount = 0;
            if (products && products.length > 0) {
                products.forEach(product => {
                    const purchaseType = product.purchase_type || 'credit';
                    if (purchaseType === 'cash' || purchaseType === 'advance') {
                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const productAmount = (parseFloat(product.quantity_ltr) || 0) * rateAfterDiscount;

                        if (purchaseType === 'cash') {
                            totalPaidAmount += productAmount;
                        } else if (purchaseType === 'advance') {
                            const productPaidAmount = parseFloat(product.paid_amount) || productAmount;
                            totalPaidAmount += productPaidAmount;
                        }
                    }
                });
            }

            const transactionIDsForTrip = [];
            const cashInHandIdsForTransaction = [];
            let advanceBalanceEntryIds = {};

            // Handle payment transactions per product
            if (hasCashOrAdvanceProducts && totalPaidAmount > 0) {
                const productsByAccountHead = {};
                products.forEach((product, index) => {
                    if (product.purchase_type === 'cash' || product.purchase_type === 'advance') {
                        const accountHead = 'Advance Balance';
                        if (!productsByAccountHead[accountHead]) {
                            productsByAccountHead[accountHead] = [];
                        }
                        productsByAccountHead[accountHead].push({ product, index });
                    }
                });

                for (const [accountHead, productGroup] of Object.entries(productsByAccountHead)) {
                    let groupTotal = 0;
                    productGroup.forEach(({ product }) => {
                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const productAmount = (parseFloat(product.quantity_ltr) || 0) * rateAfterDiscount;

                        if (product.purchase_type === 'cash') {
                            groupTotal += productAmount;
                        } else if (product.purchase_type === 'advance') {
                            groupTotal += parseFloat(product.paid_amount) || productAmount;
                        }
                    });

                    if (accountHead === 'bank') {
                        const accountId = productGroup[0].product.account_id;
                        const bankId = productGroup[0].product.bank_id;
                        const paymentMode = productGroup[0].product.payment_mode;
                        const referenceNo = productGroup[0].product.reference_no;

                        const [accountRows] = await connection.execute(
                            'SELECT Balance, BankID FROM accounts WHERE ID = ? AND active = 1',
                            [accountId]
                        );

                        if (accountRows.length === 0) {
                            await connection.rollback();
                            connection.release();
                            return res.status(404).json({ message: 'Account not found or inactive' });
                        }

                        const currentBalance = parseFloat(accountRows[0].Balance) || 0;

                        if (currentBalance < groupTotal) {
                            await connection.rollback();
                            connection.release();
                            return res.status(400).json({
                                message: `Insufficient balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${groupTotal.toFixed(2)}`
                            });
                        }

                        const hasCash = productGroup.some(({ product }) => product.purchase_type === 'cash');
                        let purpose = 'Payment';
                        if (hasCash) {
                            purpose = 'Cash Payment';
                        }

                        const transactionQuery = `
                            INSERT INTO transactions (
                                AccountID, 
                                Purpose, 
                                Debit, 
                                Credit, 
                                Date, 
                                PaymentMode, 
                                ReferenceNo,
                                trip_id,
                                active
                            ) VALUES (?, ?, ?, 0, NOW(), ?, ?, NULL, 1)
                        `;

                        const [transactionResult] = await connection.execute(transactionQuery, [
                            accountId,
                            purpose,
                            groupTotal,
                            paymentMode || null,
                            referenceNo || null
                        ]);

                        transactionIDsForTrip.push(transactionResult.insertId);

                        const updateAccountQuery = `
                            UPDATE accounts 
                            SET Balance = Balance - ?, 
                                MD = NOW()
                            WHERE ID = ? AND active = 1
                        `;

                        await connection.execute(updateAccountQuery, [
                            groupTotal,
                            accountId
                        ]);
                    }
                    else if (accountHead === 'Advance Balance') {
                        const hasCash = productGroup.some(({ product }) => product.purchase_type === 'cash');
                        let purpose = 'Payment from Advance Balance';
                        if (hasCash) {
                            purpose = 'Full Payment from Advance Balance';
                        }

                        const transactionQuery = `
                            INSERT INTO transactions (
                                cash_in_hand_id,
                                AccountID,
                                Purpose, 
                                Debit, 
                                Credit, 
                                PaymentMode,
                                ReferenceNo,
                                Date,
                                trip_id,
                                active
                            ) VALUES (NULL, NULL, ?, ?, 0, NULL, NULL, NOW(), NULL, 1)
                        `;

                        const [transactionResult] = await connection.execute(transactionQuery, [
                            purpose,
                            groupTotal
                        ]);

                        transactionIDsForTrip.push(transactionResult.insertId);
                        console.log(`Created transaction for Advance Balance payment: Amount=${groupTotal}, TransactionID=${transactionResult.insertId}`);
                    } else if (accountHead === 'cash_in_hand') {
                        let currentCashBalance = 0;

                        if (cashInHandIdsForTransaction.length > 0) {
                            const [lastInsertedRow] = await connection.execute(
                                `SELECT balance FROM cash_in_hand WHERE id = ?`,
                                [cashInHandIdsForTransaction[cashInHandIdsForTransaction.length - 1]]
                            );
                            currentCashBalance = lastInsertedRow.length > 0
                                ? parseFloat(lastInsertedRow[0]?.balance || 0)
                                : 0;
                        } else {
                            const [lastBalanceRows] = await connection.execute(
                                `SELECT balance FROM cash_in_hand 
                                 WHERE Active = 1 
                                 ORDER BY created_at DESC, id DESC 
                                 LIMIT 1`
                            );
                            currentCashBalance = lastBalanceRows.length > 0
                                ? parseFloat(lastBalanceRows[0]?.balance || 0)
                                : 0;
                        }

                        if (currentCashBalance < groupTotal) {
                            await connection.rollback();
                            connection.release();
                            return res.status(400).json({
                                message: `Insufficient cash in hand. Available balance: ${currentCashBalance.toFixed(2)}, Required: ${groupTotal.toFixed(2)}`
                            });
                        }

                        const newBalance = currentCashBalance - groupTotal;

                        const insertCashInHandQuery = `
                            INSERT INTO cash_in_hand (
                                debit,
                                credit,
                                balance,
                                purpose,
                                created_at
                            ) VALUES (?, 0, ?, 'Trip payment', NOW())
                        `;

                        const [cashInHandResult] = await connection.execute(insertCashInHandQuery, [
                            groupTotal,
                            newBalance
                        ]);

                        const cashInHandIdForTransaction = cashInHandResult.insertId;
                        cashInHandIdsForTransaction.push(cashInHandIdForTransaction);

                        const hasAdvance = productGroup.some(({ product }) => product.purchase_type === 'advance');
                        const hasCash = productGroup.some(({ product }) => product.purchase_type === 'cash');
                        let purpose = 'Payment for Trip';
                        if (hasAdvance && hasCash) {
                            purpose = 'Mixed Payment';
                        } else if (hasAdvance) {
                            purpose = 'Advance Payment';
                        } else if (hasCash) {
                            purpose = 'Full Payment';
                        }

                        const transactionQuery = `
                            INSERT INTO transactions (
                                cash_in_hand_id,
                                Purpose, 
                                Debit, 
                                Credit, 
                                PaymentMode,
                                Date,
                                trip_id,
                                active
                            ) VALUES (?, ?, ?, 0, 'Cash', NOW(), NULL, 1)
                        `;

                        const [transactionResult] = await connection.execute(transactionQuery, [
                            cashInHandIdForTransaction,
                            purpose,
                            groupTotal
                        ]);

                        transactionIDsForTrip.push(transactionResult.insertId);
                    }
                }
            }

            // Generate trip_no
            let finalTripNo = trip_no;
            if (!finalTripNo || finalTripNo === '') {
                try {
                    const [maxTrip] = await connection.execute(
                        `SELECT MAX(CAST(SUBSTRING(trip_no, 6) AS UNSIGNED)) as max_num 
                     FROM trips 
                     WHERE trip_no LIKE 'TRIP-%'`
                    );
                    const nextNum = (maxTrip[0]?.max_num || 0) + 1;
                    finalTripNo = `TRIP-${String(nextNum).padStart(6, '0')}`;
                    console.log('Generated trip_no:', finalTripNo);
                } catch (err) {
                    console.error('Error generating trip_no:', err);
                    finalTripNo = `TRIP-${Date.now().toString().slice(-6)}`;
                }
            }

            // Update transaction purposes
            if (finalTripNo && transactionIDsForTrip.length > 0) {
                const hasAdvance = products && products.some(p => p.purchase_type === 'advance');
                const hasCash = products && products.some(p => p.purchase_type === 'cash');
                let purchaseTypeDisplay = 'Payment';
                if (hasAdvance && hasCash) {
                    purchaseTypeDisplay = 'Mixed Payment';
                } else if (hasAdvance) {
                    purchaseTypeDisplay = 'Advance Payment';
                } else if (hasCash) {
                    purchaseTypeDisplay = 'Full Payment';
                }

                const updateTransactionPurpose = `
                UPDATE transactions 
                SET Purpose = ? 
                WHERE ID = ?
            `;
                for (const transactionId of transactionIDsForTrip) {
                    await connection.execute(updateTransactionPurpose, [
                        `${purchaseTypeDisplay} - ${finalTripNo}`,
                        transactionId
                    ]);
                }
            }

            // Pre-calculate total purchase amount
            let productsTotalAmount = 0;
            if (products && products.length > 0) {
                productsTotalAmount = products.reduce((sum, p) => {
                    const qty = parseFloat(p.quantity_ltr) || 0;
                    const invoiceRate = parseFloat(p.invoice_rate) || 0;
                    const discount = parseFloat(p.discount) || 0;
                    const rateAfterDiscount = invoiceRate - discount;
                    return sum + (qty * rateAfterDiscount);
                }, 0);
            }

            // Insert trip
            const query = `
                INSERT INTO trips (
                    trip_no, start_date, vehicle_id, amount_collected, paid, 
                    status, completed_at, total_amount, CB, CD, MD, active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
            `;
            const queryParams = [
                finalTripNo,
                start_date,
                vehicle_id,
                amount_collected || 0,
                totalPaidAmount,
                'In Progress',
                completed_at || null,
                productsTotalAmount,
                CB
            ];

            const [result] = await connection.execute(query, queryParams);

            let tripInsertId = result.insertId;
            if (!tripInsertId || tripInsertId === 0) {
                try {
                    const [lastIdRows] = await connection.execute('SELECT LAST_INSERT_ID() as id');
                    tripInsertId = lastIdRows[0]?.id || null;
                } catch (err) {
                    console.error('Error getting LAST_INSERT_ID():', err.message);
                }
            }

            if (!tripInsertId || tripInsertId === 0) {
                await connection.rollback();
                connection.release();
                return res.status(500).json({
                    message: 'Failed to get trip ID after insertion.'
                });
            }

            // Insert products into trip_products
            let insertedProductIds = [];

            if (tripInsertId && products && products.length > 0) {
                try {
                    const insertProductQuery = `
                        INSERT INTO trip_products (
                            trip_id, comp_id, depo_id, pickup_id, product_type, quantity_ltr, invoice_rate, discount,
                            container_type, container_liters, no_of_containers,
                            CB, CD, MD, Active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                    `;

                    insertedProductIds = [];

                    for (const product of products) {
                        let companyId = null;
                        try {
                            const [companyRows] = await connection.execute(
                                `SELECT company_id FROM depo_company WHERE depo_id = ? AND active = 1 LIMIT 1`,
                                [product.depo_id]
                            );
                            if (companyRows.length > 0) {
                                companyId = companyRows[0].company_id;
                            }
                        } catch (err) {
                            console.log('Note: Could not get company_id for depo:', err.message);
                        }

                        const [productResult] = await connection.execute(insertProductQuery, [
                            tripInsertId,
                            companyId,
                            product.depo_id,
                            vehicle_id || null,
                            product.product_type,
                            parseFloat(product.quantity_ltr),
                            parseFloat(product.invoice_rate) || 0,
                            parseFloat(product.discount) || 0,
                            product.container_type || null,
                            product.container_liters || null,
                            product.no_of_containers || null,
                            CB
                        ]);

                        insertedProductIds.push(productResult.insertId);
                    }

                    console.log(`Inserted ${products.length} product(s) for trip ${tripInsertId}`);
                } catch (err) {
                    console.error('Error inserting products:', err.message);
                    throw err;
                }
            }

            // Insert into trip_depos and handle special credit
            let depoPurchaseData = {};

            if (tripInsertId && products && products.length > 0 && insertedProductIds && insertedProductIds.length > 0) {
                try {
                    depoPurchaseData = {};
                    const insertTripDeposQuery = `
                        INSERT INTO trip_depos (
                            trip_id, depo_id, product_id, purchase_type, paid_amount, payable_amount,
                            CB, CD, MD, Active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                    `;

                    for (let i = 0; i < products.length && i < insertedProductIds.length; i++) {
                        const product = products[i];
                        const productId = insertedProductIds[i];

                        const depoId = product.depo_id;
                        const purchaseType = product.purchase_type || 'credit';

                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const purchaseAmount = (parseFloat(product.quantity_ltr) || 0) * rateAfterDiscount;

                        let paidAmount = parseFloat(product.paid_amount) || 0;
                        let payableAmount = 0;

                        if (purchaseType === 'cash') {
                            paidAmount = purchaseAmount;
                            payableAmount = purchaseAmount;
                        } else if (purchaseType === 'advance') {
                            if (paidAmount === 0 || !paidAmount) {
                                paidAmount = purchaseAmount;
                            }
                            payableAmount = purchaseAmount;
                        } else {
                            // credit or specialcredit
                            paidAmount = 0;
                            payableAmount = purchaseAmount;
                        }

                        if (paidAmount > payableAmount) {
                            paidAmount = payableAmount;
                        }

                        await connection.execute(insertTripDeposQuery, [
                            tripInsertId,
                            depoId,
                            productId,
                            purchaseType,
                            paidAmount,
                            payableAmount,
                            CB
                        ]);

                        const key = `${depoId}_${purchaseType}`;
                        if (!depoPurchaseData[key]) {
                            depoPurchaseData[key] = {
                                depo_id: depoId,
                                purchase_type: purchaseType,
                                paid_amount: 0,
                                payable_amount: 0
                            };
                        }
                        depoPurchaseData[key].paid_amount += paidAmount;
                        depoPurchaseData[key].payable_amount += payableAmount;
                    }

                    console.log(`Successfully inserted ${products.length} trip_depos entries for trip ${tripInsertId}`);
                } catch (err) {
                    console.error('Error inserting trip_depos:', err.message);
                    throw err;
                }

                // Create pool entries and special credit entries
                try {
                    const advanceConsumedByDepo = {};
                    const creditUsedByDepo = {};
                    const specialCreditUsedByDepo = {};

                    for (const depoData of Object.values(depoPurchaseData)) {
                        const depoId = depoData.depo_id;
                        const purchaseType = depoData.purchase_type || 'credit';
                        const payableAmount = parseFloat(depoData.payable_amount || 0) || 0;
                        const paidAmount = parseFloat(depoData.paid_amount || 0) || 0;
                        const safePaid = Math.min(paidAmount, payableAmount);
                        const remainingDue = Math.max(0, payableAmount - safePaid);

                        if (purchaseType === 'cash' || purchaseType === 'advance') {
                            if (!advanceConsumedByDepo[depoId]) advanceConsumedByDepo[depoId] = 0;
                            advanceConsumedByDepo[depoId] += safePaid;
                        }

                        // Handle special credit separately
                        if (purchaseType === 'specialcredit') {
                            if (!specialCreditUsedByDepo[depoId]) specialCreditUsedByDepo[depoId] = 0;
                            specialCreditUsedByDepo[depoId] += payableAmount; // Full amount goes to special credit
                        }

                        // Regular credit for remaining due (only for credit type, not specialcredit)
                        if (purchaseType === 'credit' && remainingDue > 0) {
                            if (!creditUsedByDepo[depoId]) creditUsedByDepo[depoId] = 0;
                            creditUsedByDepo[depoId] += remainingDue;
                        }
                    }

                    const allDepoIds = Array.from(new Set([
                        ...Object.keys(advanceConsumedByDepo).map(k => parseInt(k, 10)),
                        ...Object.keys(creditUsedByDepo).map(k => parseInt(k, 10)),
                        ...Object.keys(specialCreditUsedByDepo).map(k => parseInt(k, 10))
                    ])).filter(n => !isNaN(n));

                    console.log(`Processing depos: ${allDepoIds.join(', ') || 'N/A'}`);

                    for (const depoId of allDepoIds) {
                        const advanceConsumed = parseFloat(advanceConsumedByDepo[depoId] || 0) || 0;
                        const creditUsed = parseFloat(creditUsedByDepo[depoId] || 0) || 0;
                        const specialCreditUsed = parseFloat(specialCreditUsedByDepo[depoId] || 0) || 0;

                        // 1) Consume advance
                        if (advanceConsumed > 0) {
                            const [lastAdvanceRows] = await connection.execute(
                                `SELECT Balance FROM advance_balance
                                 WHERE DepoID = ? AND Active = 1
                                 ORDER BY ID DESC LIMIT 1`,
                                [depoId]
                            );
                            const currentAdvanceBalance = lastAdvanceRows.length > 0
                                ? parseFloat(lastAdvanceRows[0].Balance || 0)
                                : 0;
                            const newAdvanceBalance = Math.max(0, currentAdvanceBalance - advanceConsumed);

                            await connection.execute(
                                `INSERT INTO advance_balance (
                                    DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                                ) VALUES (?, ?, NULL, NULL, ?, 0, ?, NOW(), NOW(), NOW(), ?, 1)`,
                                [depoId, tripInsertId, advanceConsumed, newAdvanceBalance, CB]
                            );

                            console.log(`Consumed advance for trip ${tripInsertId}, depo ${depoId}: Debit=${advanceConsumed}`);
                        }

                        // 2) Handle Special Credit
                        if (specialCreditUsed > 0) {
                            // Get current special credit limit from depo
                            const [depoRows] = await connection.execute(
                                `SELECT special_credit_limit FROM depo WHERE id = ? AND active = 1`,
                                [depoId]
                            );
                            const currentSpecialCreditLimit = depoRows.length > 0 ? parseFloat(depoRows[0].special_credit_limit || 0) : 0;
                            const newSpecialCreditLimit = Math.max(0, currentSpecialCreditLimit - specialCreditUsed);

                            // Get the latest special_credit_limit entry for DepoLimit
                            const [lastSpecialCreditRows] = await connection.execute(
                                `SELECT DepoLimit FROM special_credit_limit 
                                 WHERE DepoID = ? AND Active = 1
                                 ORDER BY ID DESC LIMIT 1`,
                                [depoId]
                            );
                            const previousDepoLimit = lastSpecialCreditRows.length > 0
                                ? parseFloat(lastSpecialCreditRows[0].DepoLimit || 0)
                                : currentSpecialCreditLimit;
                            const newDepoLimit = Math.max(0, previousDepoLimit - specialCreditUsed);

                            // Insert into special_credit_limit table
                            await connection.execute(
                                `INSERT INTO special_credit_limit (
                                    DepoID,
                                    TripID,
                                    recovery_id,
                                    payment_id,
                                    Debit,
                                    Credit,
                                    Date,
                                    DepoLimit,
                                    MD,
                                    CD,
                                    CB,
                                    MB,
                                    Active
                                ) VALUES (?, ?, NULL, NULL, ?, 0, NOW(), ?, NOW(), NOW(), ?, ?, 1)`,
                                [depoId, tripInsertId, specialCreditUsed, newDepoLimit, CB, CB]
                            );

                            // Update depo.special_credit_limit
                            console.log('Updating dep table for special_credit_limit: ' + newSpecialCreditLimit);
                            await connection.execute(
                                `UPDATE depo SET special_credit_limit = ?, MD = NOW() WHERE id = ?`,
                                [newSpecialCreditLimit, depoId]
                            );

                            console.log(`Special Credit used for trip ${tripInsertId}, depo ${depoId}: Debit=${specialCreditUsed}, NewDepoLimit=${newDepoLimit}, NewSpecialCreditLimit=${newSpecialCreditLimit}`);
                        }

                        // 3) Use regular credit limit for remaining due (only for credit type)
                        if (creditUsed > 0) {
                            const [depoBalanceRows] = await connection.execute(
                                `SELECT Balance FROM depo WHERE id = ? AND active = 1`,
                                [depoId]
                            );
                            const currentDepoBalance = depoBalanceRows.length > 0 ? parseFloat(depoBalanceRows[0].Balance || 0) : 0;
                            const newDepoBalance = currentDepoBalance - creditUsed;

                            await connection.execute(
                                `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                                [newDepoBalance, depoId]
                            );

                            const [poolRows] = await connection.execute(
                                `SELECT DepoLimit FROM pool WHERE DepoID = ? AND active = 1 ORDER BY ID DESC LIMIT 1`,
                                [depoId]
                            );
                            const previousDepoLimit = poolRows.length > 0 ? parseFloat(poolRows[0].DepoLimit || 0) : currentDepoBalance;
                            const newDepoLimit = previousDepoLimit - creditUsed;

                            await connection.execute(
                                `INSERT INTO pool (
                                    DepoID,
                                    TripID,
                                    Debit,
                                    Credit,
                                    DepoLimit,
                                    payment_id,
                                    recovery_id,
                                    CD,
                                    CB,
                                    MD,
                                    active
                                ) VALUES (?, ?, ?, 0, ?, NULL, NULL, NOW(), ?, NOW(), 1)`,
                                [depoId, tripInsertId, creditUsed, newDepoLimit, CB]
                            );

                            console.log(`Pool debit for trip ${tripInsertId}, depo ${depoId}: Debit=${creditUsed}`);
                        }
                    }

                    console.log(`Processed ${Object.keys(depoPurchaseData).length} depo purchase record(s) for trip ${tripInsertId}`);
                } catch (poolErr) {
                    console.error(`CRITICAL ERROR creating pool/special credit entries for trip ${tripInsertId}:`, poolErr.message);
                    throw new Error(`Failed to create pool/special credit entries: ${poolErr.message}`);
                }

                // Update trips.paid
                if (tripInsertId) {
                    try {
                        const [tripDeposSum] = await connection.execute(
                            `SELECT COALESCE(SUM(paid_amount), 0) as total_paid
                         FROM trip_depos
                         WHERE trip_id = ? AND Active = 1`,
                            [tripInsertId]
                        );
                        const totalPaidForTrip = parseFloat(tripDeposSum[0]?.total_paid || 0);
                        await connection.execute(
                            `UPDATE trips SET paid = ?, total_amount = ? WHERE ID = ?`,
                            [totalPaidForTrip, productsTotalAmount, tripInsertId]
                        );
                        console.log(`Updated trip ${tripInsertId} paid = ${totalPaidForTrip}, total_amount = ${productsTotalAmount}`);
                    } catch (updateErr) {
                        console.error('Error updating trip paid/total_amount:', updateErr.message);
                    }
                }
            }

            // Update transactions with trip_id
            if (tripInsertId && transactionIDsForTrip.length > 0) {
                for (const transactionId of transactionIDsForTrip) {
                    try {
                        await connection.execute(
                            `UPDATE transactions 
                             SET trip_id = ? 
                             WHERE ID = ? AND active = 1`,
                            [tripInsertId, transactionId]
                        );
                    } catch (err) {
                        console.error(`Error updating transaction ${transactionId} trip_id:`, err.message);
                    }
                }
            }

            await connection.commit();
            connection.release();

            console.log('Trip added successfully with ID:', tripInsertId);
            res.json({
                message: 'Trip added successfully',
                id: tripInsertId
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error adding trip:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message,
            sqlMessage: err.sqlMessage,
            code: err.code,
            errno: err.errno
        });
    }
};
// Add new trip
exports._addTrip = async (req, res) => {
    try {
        console.log('Received trip data:', req.body);

        const {
            trip_no,
            start_date,
            vehicle_id,
            depo_id, // May be null now (depo is per product)
            fuel, // May be null (products stored in trip_products)
            cpl, // May be null (products stored in trip_products)
            products, // Array of products
            spl,
            amount_collected,
            paid,
            payment_method,
            account_head,
            bank_id,
            account_id,
            payment_mode,
            reference_no,
            status,
            completed_at
        } = req.body;

        // Validate required fields
        if (!start_date || !vehicle_id) {
            console.log('Validation failed:', {
                start_date: !!start_date,
                vehicle_id: !!vehicle_id
            });
            return res.status(400).json({ message: 'Start date and vehicle are required' });
        }

        // Validate products array
        if (!products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ message: 'At least one product is required' });
        }

        // Validate each product
        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            if (!product.depo_id || !product.product_type || !product.quantity_ltr || product.invoice_rate === undefined || product.invoice_rate === null) {
                return res.status(400).json({
                    message: `Product ${i + 1} is missing required fields (depo_id, product_type, quantity_ltr, or invoice_rate)`
                });
            }

            // Validate purchase_type
            if (!product.purchase_type || !['cash', 'specialcredit', 'credit'].includes(product.purchase_type)) {
                return res.status(400).json({
                    message: `Product ${i + 1} must have a valid purchase_type (cash, specialcredit, or credit)`
                });
            }

            // Validate Mobile/Lube Oil specific fields
            if (product.product_type === 'Mobile/Lube Oil') {
                if (!product.container_type) {
                    return res.status(400).json({
                        message: `Product ${i + 1}: Container Type is required for Mobile/Lube Oil`
                    });
                }
                if (product.container_type === 'Cotton') {
                    if (!product.container_liters || !product.no_of_containers) {
                        return res.status(400).json({
                            message: `Product ${i + 1}: Container Size and No. of Containers are required for Cotton`
                        });
                    }
                }
            }
        }

        // Validate payment fields per product (account_head is now per product, not at trip level)
        const hasCashOrAdvanceProducts = products && products.some(p => p.purchase_type === 'cash' || p.purchase_type === 'advance');

        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            if (product.purchase_type === 'cash' || product.purchase_type === 'advance') {
                product.account_head = 'Advance Balance';
                if (!product.account_head) {
                    return res.status(400).json({
                        message: `Product ${i + 1}: Account Head is required for Cash Payment purchase types`
                    });
                }
                if (product.account_head === 'bank') {
                    if (!product.bank_id) {
                        return res.status(400).json({
                            message: `Product ${i + 1}: Bank is required when Account Head is Bank`
                        });
                    }
                    if (!product.account_id) {
                        return res.status(400).json({
                            message: `Product ${i + 1}: Account is required when Account Head is Bank`
                        });
                    }
                    if (!product.payment_mode) {
                        return res.status(400).json({
                            message: `Product ${i + 1}: Payment Mode is required when Account Head is Bank`
                        });
                    }
                }
            }
        }

        // Get connection for transaction (will be used for all operations)
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Get CB (Created By) once for the entire function
            const CB = resolveAuditUser(req.body, 'Admin');

            // Check depo balance for each depo separately
            // Only check balance for products with credit purchase_type
            // Group products by depo_id to check balance per depo
            let depoCosts = {}; // { depo_id: total_cost for credit products }
            let depoBalances = {}; // { depo_id: balance }
            let depoNames = {}; // { depo_id: name }

            if (products && products.length > 0) {
                // Calculate total cost per depo for credit products only (using invoice_rate - discount)
                products.forEach(product => {
                    // Only check balance for credit products
                    if (product.purchase_type === 'credit') {
                        const depoId = product.depo_id;
                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const cost = parseFloat(product.quantity_ltr) * rateAfterDiscount;
                        if (!depoCosts[depoId]) {
                            depoCosts[depoId] = 0;
                        }
                        depoCosts[depoId] += cost;
                    }
                });

                // Check balance for each depo with credit products
                for (const depoId of Object.keys(depoCosts)) {
                    const [depoRows] = await connection.execute(
                        `SELECT 
                            d.Balance,
                            d.name,
                            (
                                SELECT COALESCE(ab.Balance, 0)
                                FROM advance_balance ab
                                WHERE ab.DepoID = d.id AND ab.Active = 1
                                ORDER BY ab.ID DESC
                                LIMIT 1
                            ) as advance_balance
                         FROM depo d
                         WHERE d.id = ? AND d.active = 1`,
                        [depoId]
                    );

                    if (depoRows.length === 0) {
                        await connection.rollback();
                        connection.release();
                        return res.status(400).json({
                            message: `Depo with ID ${depoId} not found or inactive.`
                        });
                    }

                    const depoBalance = parseFloat(depoRows[0].Balance || 0);
                    const advanceBalance = parseFloat(depoRows[0].advance_balance || 0);
                    const depoName = depoRows[0].name || `Depo ${depoId}`;
                    depoBalances[depoId] = depoBalance;
                    depoNames[depoId] = depoName;
                    const totalCost = depoCosts[depoId];

                    // Calculate total available: advance_balance + (credit_limit - used_credit)
                    // For now, used_credit is the amount already used from Balance
                    // So available credit = Balance (remaining credit limit)
                    const totalAvailable = advanceBalance + depoBalance;

                    // Check if total available (advance + credit) is sufficient for credit products
                    if (totalCost > totalAvailable) {
                        await connection.rollback();
                        connection.release();
                        return res.status(400).json({
                            message: `Total cost (Rs. ${totalCost.toFixed(2)}) for credit products exceeds available funds (Rs. ${totalAvailable.toFixed(2)}) for depo "${depoName}". ` +
                                `Available: Advance (Rs. ${advanceBalance.toFixed(2)}) + Credit (Rs. ${depoBalance.toFixed(2)}). ` +
                                `Please reduce quantities or increase the depo balance.`
                        });
                    }
                }
            }

            // NOTE: Pool entries are now created based on trip_depos table after trip is inserted
            // This old code is disabled to prevent duplicate pool entries
            // Pool entries will be created in the trip_depos section based on payable_amount
            const poolEntryIds = [];
            req.poolEntryIdsForTrip = poolEntryIds;

            // Calculate total paid amount from products with cash/advance purchase types
            let totalPaidAmount = 0;
            if (products && products.length > 0) {
                products.forEach(product => {
                    const purchaseType = product.purchase_type || 'credit';
                    if (purchaseType === 'cash' || purchaseType === 'advance') {
                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const productAmount = (parseFloat(product.quantity_ltr) || 0) * rateAfterDiscount;

                        if (purchaseType === 'cash') {
                            // Full payment: paid_amount = total amount
                            totalPaidAmount += productAmount;
                        } else if (purchaseType === 'advance') {
                            // Partial payment: use paid_amount from product if provided, otherwise use total amount
                            const productPaidAmount = parseFloat(product.paid_amount) || productAmount;
                            totalPaidAmount += productPaidAmount;
                        }
                    }
                });
            }

            // Arrays to store transaction IDs and cash_in_hand IDs (declared outside if block for accessibility)
            const transactionIDsForTrip = []; // Array to store all transaction IDs created
            const cashInHandIdsForTransaction = []; // Array to store cash_in_hand IDs
            // Track advance_balance table entry IDs that need to be linked to the newly created TripID
            // (key: depoId, value: advance_balance.ID)
            let advanceBalanceEntryIds = {};

            // Handle payment transactions per product (account_head is now per product)
            // Process payments for each product with cash or advance purchase type
            if (hasCashOrAdvanceProducts && totalPaidAmount > 0) {
                // Group products by account_head to process payments efficiently
                const productsByAccountHead = {};
                products.forEach((product, index) => {
                    if (product.purchase_type === 'cash' || product.purchase_type === 'advance') {
                        const accountHead = 'Advance Balance';//product.account_head;
                        if (!productsByAccountHead[accountHead]) {
                            productsByAccountHead[accountHead] = [];
                        }
                        productsByAccountHead[accountHead].push({ product, index });
                    }
                });

                // Process payments grouped by account_head
                for (const [accountHead, productGroup] of Object.entries(productsByAccountHead)) {
                    // Calculate total amount for this account head group
                    let groupTotal = 0;
                    productGroup.forEach(({ product }) => {
                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const productAmount = (parseFloat(product.quantity_ltr) || 0) * rateAfterDiscount;

                        if (product.purchase_type === 'cash') {
                            groupTotal += productAmount;
                        } else if (product.purchase_type === 'advance') {
                            groupTotal += parseFloat(product.paid_amount) || productAmount;
                        }
                    });

                    if (accountHead === 'bank') {
                        // Get account_id from first product in group (all should have same account_id)
                        const accountId = productGroup[0].product.account_id;
                        const bankId = productGroup[0].product.bank_id;
                        const paymentMode = productGroup[0].product.payment_mode;
                        const referenceNo = productGroup[0].product.reference_no;

                        // 1. Check account balance
                        const [accountRows] = await connection.execute(
                            'SELECT Balance, BankID FROM accounts WHERE ID = ? AND active = 1',
                            [accountId]
                        );

                        if (accountRows.length === 0) {
                            await connection.rollback();
                            connection.release();
                            return res.status(404).json({ message: 'Account not found or inactive' });
                        }

                        const currentBalance = parseFloat(accountRows[0].Balance) || 0;

                        if (currentBalance < groupTotal) {
                            await connection.rollback();
                            connection.release();
                            return res.status(400).json({
                                message: `Insufficient balance. Available balance: ${currentBalance.toFixed(2)}, Required: ${groupTotal.toFixed(2)}`
                            });
                        }

                        // 2. Insert into transactions table
                        const hasAdvance = productGroup.some(({ product }) => product.purchase_type === 'advance');
                        const hasCash = productGroup.some(({ product }) => product.purchase_type === 'cash');
                        let purpose = 'Payment';
                        if (hasAdvance && hasCash) {
                            purpose = 'Mixed Payment';
                        } else if (hasAdvance) {
                            purpose = 'Advance Payment';
                        } else if (hasCash) {
                            purpose = 'Full Payment';
                        }

                        const transactionQuery = `
                            INSERT INTO transactions (
                                AccountID, 
                                Purpose, 
                                Debit, 
                                Credit, 
                                Date, 
                                PaymentMode, 
                                ReferenceNo,
                                trip_id,
                                active
                            ) VALUES (?, ?, ?, 0, NOW(), ?, ?, NULL, 1)
                        `;

                        const [transactionResult] = await connection.execute(transactionQuery, [
                            accountId,
                            purpose,
                            groupTotal,
                            paymentMode || null,
                            referenceNo || null
                        ]);

                        transactionIDsForTrip.push(transactionResult.insertId);

                        // 3. Update Accounts table - subtract amount from balance
                        const updateAccountQuery = `
                            UPDATE accounts 
                            SET Balance = Balance - ?, 
                                MD = NOW()
                            WHERE ID = ? AND active = 1
                        `;

                        const [updateResult] = await connection.execute(updateAccountQuery, [
                            groupTotal,
                            accountId
                        ]);

                        if (updateResult.affectedRows === 0) {
                            await connection.rollback();
                            connection.release();
                            return res.status(404).json({ message: 'Account not found or inactive' });
                        }
                    }
                    else if (accountHead === 'Advance Balance') {
                        // Advance Balance payment - payment is handled through depo advance_balance
                        // Create transaction entry with account_head='Advance Balance', cash_in_hand_id=null, account_id=null
                        const hasAdvance = productGroup.some(({ product }) => product.purchase_type === 'advance');
                        const hasCash = productGroup.some(({ product }) => product.purchase_type === 'cash');
                        let purpose = 'Payment from Advance Balance';
                        if (hasAdvance && hasCash) {
                            purpose = 'Mixed Payment from Advance Balance';
                        } else if (hasAdvance) {
                            purpose = 'Advance Payment from Advance Balance';
                        } else if (hasCash) {
                            purpose = 'Full Payment from Advance Balance';
                        }

                        const transactionQuery = `
                            INSERT INTO transactions (
                                cash_in_hand_id,
                                AccountID,
                                Purpose, 
                                Debit, 
                                Credit, 
                                PaymentMode,
                                ReferenceNo,
                                Date,
                                trip_id,
                                active
                            ) VALUES (NULL, NULL, ?, ?, 0, NULL, NULL, NOW(), NULL, 1)
                        `;

                        const [transactionResult] = await connection.execute(transactionQuery, [
                            purpose,
                            groupTotal
                        ]);

                        transactionIDsForTrip.push(transactionResult.insertId);
                        console.log(`Created transaction for Advance Balance payment: Amount=${groupTotal}, TransactionID=${transactionResult.insertId}`);
                    } else if (accountHead === 'cash_in_hand') {
                        // Cash in Hand payment - when paying out, use debit
                        // 1. Get current cash in hand balance from last active entry
                        // If we've already inserted cash_in_hand entries in this transaction, use the last one's balance
                        // Otherwise, get from database
                        let currentCashBalance = 0;

                        if (cashInHandIdsForTransaction.length > 0) {
                            // Get balance from the last inserted cash_in_hand entry in this transaction
                            const [lastInsertedRow] = await connection.execute(
                                `SELECT balance FROM cash_in_hand WHERE id = ?`,
                                [cashInHandIdsForTransaction[cashInHandIdsForTransaction.length - 1]]
                            );
                            currentCashBalance = lastInsertedRow.length > 0
                                ? parseFloat(lastInsertedRow[0]?.balance || 0)
                                : 0;
                        } else {
                            // First cash_in_hand entry in this transaction - get from database
                            const [lastBalanceRows] = await connection.execute(
                                `SELECT balance FROM cash_in_hand 
                                 WHERE Active = 1 
                                 ORDER BY created_at DESC, id DESC 
                                 LIMIT 1`
                            );
                            currentCashBalance = lastBalanceRows.length > 0
                                ? parseFloat(lastBalanceRows[0]?.balance || 0)
                                : 0;
                        }

                        if (currentCashBalance < groupTotal) {
                            await connection.rollback();
                            connection.release();
                            return res.status(400).json({
                                message: `Insufficient cash in hand. Available balance: ${currentCashBalance.toFixed(2)}, Required: ${groupTotal.toFixed(2)}`
                            });
                        }

                        // 2. Calculate new balance from last entry's balance
                        const newBalance = currentCashBalance - groupTotal; // Debit subtracts from balance

                        // 3. Insert into cash_in_hand table with debit (cash paid out)
                        const insertCashInHandQuery = `
                            INSERT INTO cash_in_hand (
                                debit,
                                credit,
                                balance,
                                purpose,
                                created_at
                            ) VALUES (?, 0, ?, 'Trip payment', NOW())
                        `;

                        const [cashInHandResult] = await connection.execute(insertCashInHandQuery, [
                            groupTotal, // Debit amount (cash paid out)
                            newBalance
                        ]);

                        const cashInHandIdForTransaction = cashInHandResult.insertId;
                        cashInHandIdsForTransaction.push(cashInHandIdForTransaction);

                        // 4. Insert into transactions table
                        const hasAdvance = productGroup.some(({ product }) => product.purchase_type === 'advance');
                        const hasCash = productGroup.some(({ product }) => product.purchase_type === 'cash');
                        let purpose = 'Payment for Trip';
                        if (hasAdvance && hasCash) {
                            purpose = 'Mixed Payment';
                        } else if (hasAdvance) {
                            purpose = 'Advance Payment';
                        } else if (hasCash) {
                            purpose = 'Full Payment';
                        }

                        const transactionQuery = `
                            INSERT INTO transactions (
                                cash_in_hand_id,
                                Purpose, 
                                Debit, 
                                Credit, 
                                PaymentMode,
                                Date,
                                trip_id,
                                active
                            ) VALUES (?, ?, ?, 0, 'Cash', NOW(), NULL, 1)
                        `;

                        const [transactionResult] = await connection.execute(transactionQuery, [
                            cashInHandIdForTransaction,
                            purpose,
                            groupTotal
                        ]);

                        transactionIDsForTrip.push(transactionResult.insertId);
                    }
                }
            }

            // Ensure status is a valid string - NEVER null or undefined
            let tripStatus = 'Pending'; // Default value
            if (status !== null && status !== undefined && status !== '') {
                tripStatus = String(status).trim();
            }
            const validStatuses = ['Pending', 'In Progress', 'Completed', 'Cancelled'];
            let finalStatus = validStatuses.includes(tripStatus) ? tripStatus : 'Pending';

            // Ensure finalStatus is never null, undefined, or empty
            if (!finalStatus || finalStatus === '') {
                finalStatus = 'Pending';
            }

            // Generate trip_no if not provided (fallback if trigger doesn't work)
            let finalTripNo = trip_no;
            if (!finalTripNo || finalTripNo === '') {
                try {
                    // Get the highest trip number
                    const [maxTrip] = await connection.execute(
                        `SELECT MAX(CAST(SUBSTRING(trip_no, 6) AS UNSIGNED)) as max_num 
                     FROM trips 
                     WHERE trip_no LIKE 'TRIP-%'`
                    );
                    const nextNum = (maxTrip[0]?.max_num || 0) + 1;
                    finalTripNo = `TRIP-${String(nextNum).padStart(6, '0')}`;
                    console.log('Generated trip_no:', finalTripNo);
                } catch (err) {
                    console.error('Error generating trip_no:', err);
                    // Fallback: use timestamp-based trip number
                    finalTripNo = `TRIP-${Date.now().toString().slice(-6)}`;
                }
            }

            // Update transaction purposes with trip_no and purchase type
            // This applies to both bank and cash_in_hand transactions
            if (finalTripNo && transactionIDsForTrip.length > 0) {
                // Determine purchase type display name from products
                const hasAdvance = products && products.some(p => p.purchase_type === 'advance');
                const hasCash = products && products.some(p => p.purchase_type === 'cash');
                let purchaseTypeDisplay = 'Payment';
                if (hasAdvance && hasCash) {
                    purchaseTypeDisplay = 'Mixed Payment';
                } else if (hasAdvance) {
                    purchaseTypeDisplay = 'Advance Payment';
                } else if (hasCash) {
                    purchaseTypeDisplay = 'Full Payment';
                }

                // Update all transaction purposes: "Purchase Type - Trip No"
                const updateTransactionPurpose = `
                UPDATE transactions 
                SET Purpose = ? 
                WHERE ID = ?
            `;
                for (const transactionId of transactionIDsForTrip) {
                    await connection.execute(updateTransactionPurpose, [
                        `${purchaseTypeDisplay} - ${finalTripNo}`,
                        transactionId
                    ]);
                }
            }

            // If we created cash_in_hand entries earlier, update them with the actual trip_no
            if (cashInHandIdsForTransaction.length > 0 && finalTripNo) {
                // Determine purchase type display name from products
                const hasAdvance = products && products.some(p => p.purchase_type === 'advance');
                const hasCash = products && products.some(p => p.purchase_type === 'cash');
                let purchaseTypeDisplay = 'Payment';
                if (hasAdvance && hasCash) {
                    purchaseTypeDisplay = 'Mixed Payment';
                } else if (hasAdvance) {
                    purchaseTypeDisplay = 'Advance Payment';
                } else if (hasCash) {
                    purchaseTypeDisplay = 'Full Payment';
                }

                const updateCashInHandPurpose = `
                UPDATE cash_in_hand 
                SET purpose = ? 
                WHERE id = ?
            `;
                for (const cashInHandId of cashInHandIdsForTransaction) {
                    await connection.execute(updateCashInHandPurpose, [
                        `${purchaseTypeDisplay} - ${finalTripNo}`,
                        cashInHandId
                    ]);
                }
            }

            // Pre-calculate total purchase amount for all products (used in multiple places)
            // purchase_amount = (invoice_rate - discount) * quantity_ltr
            let productsTotalAmount = 0;
            if (products && products.length > 0) {
                productsTotalAmount = products.reduce((sum, p) => {
                    const qty = parseFloat(p.quantity_ltr) || 0;
                    const invoiceRate = parseFloat(p.invoice_rate) || 0;
                    const discount = parseFloat(p.discount) || 0;
                    const rateAfterDiscount = invoiceRate - discount;
                    return sum + (qty * rateAfterDiscount);
                }, 0);
            }

            // NOTE: Pool entries for advance products are now created based on trip_depos table after trip is inserted
            // This old code is disabled to prevent duplicate pool entries
            // Pool entries will be created in the trip_depos section based on payable_amount
            // Validation and balance checks are handled in the trip_depos section

            // Build query for trip insert
            // PurchaseType is not stored in trips table, it's stored in trip_depos table per depo
            // paid = sum of paid amounts from products with cash/advance purchase types
            const query = `
                INSERT INTO trips (
                    trip_no, start_date, vehicle_id, amount_collected, paid, 
                    status, completed_at, total_amount, CB, CD, MD, active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
            `;
            const queryParams = [
                finalTripNo,
                start_date,
                vehicle_id,
                amount_collected || 0,
                totalPaidAmount,  // paid = sum of payments from cash/advance products
                finalStatus,
                completed_at || null,
                productsTotalAmount,  // total_amount = sum of purchase_amount from all products
                CB
            ];

            console.log('Add Trip - Status received:', status, 'Type:', typeof status);
            console.log('Add Trip - Processed status:', tripStatus, 'Final status:', finalStatus);
            console.log('Add Trip - Full request body:', JSON.stringify(req.body, null, 2));
            console.log('Add Trip - Query parameters:', JSON.stringify(queryParams, null, 2));
            console.log('Add Trip - Query parameters count:', queryParams.length);

            const [result] = await connection.execute(query, queryParams);

            console.log('Add Trip - Insert result:', result);
            console.log('Add Trip - affectedRows:', result.affectedRows);
            console.log('Add Trip - insertId:', result.insertId);

            // Handle case where insertId might be 0 (some MySQL configurations)
            let tripInsertId = result.insertId;
            if (!tripInsertId || tripInsertId === 0) {
                // Try to get the last insert ID using MySQL function
                try {
                    const [lastIdRows] = await connection.execute('SELECT LAST_INSERT_ID() as id');
                    tripInsertId = lastIdRows[0]?.id || null;
                    console.log('Add Trip - Retrieved LAST_INSERT_ID():', tripInsertId);
                } catch (err) {
                    console.error('Error getting LAST_INSERT_ID():', err.message);
                    // If that fails, try to get the ID by querying the trip_no
                    try {
                        const [tripRows] = await connection.execute(
                            'SELECT id FROM trips WHERE trip_no = ? ORDER BY id DESC LIMIT 1',
                            [finalTripNo]
                        );
                        if (tripRows.length > 0) {
                            tripInsertId = tripRows[0].id;
                            console.log('Add Trip - Retrieved trip ID from trip_no:', tripInsertId);
                        }
                    } catch (err2) {
                        console.error('Error getting trip ID from trip_no:', err2.message);
                    }
                }
            }

            if (!tripInsertId || tripInsertId === 0) {
                await connection.rollback();
                connection.release();
                return res.status(500).json({
                    message: 'Failed to get trip ID after insertion. Trip may not have been created properly.'
                });
            }

            console.log('Add Trip - Final tripInsertId:', tripInsertId);

            // Update advance_balance entries with TripID
            if (advanceBalanceEntryIds && Object.keys(advanceBalanceEntryIds).length > 0) {
                for (const [depoId, entryId] of Object.entries(advanceBalanceEntryIds)) {
                    await connection.execute(
                        `UPDATE advance_balance SET TripID = ?, MD = NOW() WHERE ID = ?`,
                        [tripInsertId, entryId]
                    );
                    console.log(`Updated advance_balance entry ${entryId} with TripID=${tripInsertId} for depo ${depoId}`);
                }
            }

            // Insert transaction for credit (loan) products only
            const creditProducts = products && products.filter(p => p.purchase_type === 'credit');
            if (tripInsertId && creditProducts && creditProducts.length > 0) {
                try {
                    // Calculate total amount for credit products
                    const creditTotalAmount = creditProducts.reduce((sum, p) => {
                        const qty = parseFloat(p.quantity_ltr) || 0;
                        const invoiceRate = parseFloat(p.invoice_rate) || 0;
                        const discount = parseFloat(p.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        return sum + (qty * rateAfterDiscount);
                    }, 0);

                    // Get unique depo names for credit products
                    const depoIds = [...new Set(creditProducts.map(p => p.depo_id))];
                    const depoNames = [];
                    for (const depoId of depoIds) {
                        const [depoNameRows] = await connection.execute(
                            `SELECT name FROM depo WHERE id = ?`,
                            [depoId]
                        );
                        if (depoNameRows.length > 0) {
                            depoNames.push(depoNameRows[0].name);
                        }
                    }
                    const depoNameStr = depoNames.length > 0 ? depoNames.join(', ') : 'Multiple Depots';

                    const creditTransactionQuery = `
                        INSERT INTO transactions (
                            trip_id,
                            cash_in_hand_id,
                            AccountID,
                            Purpose,
                            Debit,
                            Credit,
                            Date,
                            PaymentMode,
                            ReferenceNo,
                            Balance,
                            active
                        ) VALUES (?, NULL, NULL, ?, 0, ?, NOW(), NULL, NULL, ?, 1)
                    `;

                    const [creditTransactionResult] = await connection.execute(creditTransactionQuery, [
                        tripInsertId,
                        `Credit from ${depoNameStr}`,
                        creditTotalAmount,  // Credit = Total Amount for credit products
                        creditTotalAmount   // Balance = Total Amount
                    ]);

                    console.log(`Inserted credit transaction for trip ${tripInsertId}: Amount=${creditTotalAmount}, TransactionID=${creditTransactionResult.insertId}`);
                } catch (err) {
                    console.error('Error inserting credit transaction:', err.message);
                    console.error('Error stack:', err.stack);
                    // Don't rollback here, just log the error - the trip was already created
                }
            }

            // Insert products into trip_products table
            // Store product IDs as we insert them (declare outside if block for scope)
            let insertedProductIds = [];

            if (tripInsertId && products && products.length > 0) {
                try {
                    const insertProductQuery = `
                        INSERT INTO trip_products (
                            trip_id, comp_id, depo_id, pickup_id, product_type, quantity_ltr, invoice_rate, discount,
                            container_type, container_liters, no_of_containers,
                            CB, CD, MD, Active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                    `;

                    // Initialize array for this trip
                    insertedProductIds = [];

                    for (const product of products) {
                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const purchaseAmount = (parseFloat(product.quantity_ltr) || 0) * rateAfterDiscount;

                        // Get company_id from depo_company relationship
                        let companyId = null;
                        try {
                            const [companyRows] = await connection.execute(
                                `SELECT company_id FROM depo_company WHERE depo_id = ? AND active = 1 LIMIT 1`,
                                [product.depo_id]
                            );
                            if (companyRows.length > 0) {
                                companyId = companyRows[0].company_id;
                            }
                        } catch (err) {
                            console.log('Note: Could not get company_id for depo:', err.message);
                        }

                        const [result] = await connection.execute(insertProductQuery, [
                            tripInsertId,
                            companyId,  // comp_id (company_id)
                            product.depo_id,
                            product.pick_up_location_id || null,  // pickup_id
                            product.product_type,
                            parseFloat(product.quantity_ltr),
                            invoiceRate,
                            discount,
                            product.container_type || null,
                            product.container_liters || null,
                            product.no_of_containers || null,
                            CB
                        ]);

                        // Store the inserted product ID
                        insertedProductIds.push(result.insertId);
                        console.log(`Inserted product with ID ${result.insertId}: ${product.product_type} for depo ${product.depo_id}`);
                    }

                    console.log(`Inserted ${products.length} product(s) for trip ${tripInsertId}. Product IDs: ${insertedProductIds.join(', ')}`);
                } catch (err) {
                    console.error('Error inserting products:', err.message);
                    console.error('Error stack:', err.stack);
                    throw err; // Re-throw to trigger rollback
                }
            }

            // Insert into trip_depos table (one entry per product with product_id)
            // Define depoPurchaseData outside try block so it's accessible for pool entry creation
            let depoPurchaseData = {};

            if (tripInsertId && products && products.length > 0 && insertedProductIds && insertedProductIds.length > 0) {
                try {
                    // Create trip_depos entries for each product (not aggregated)
                    // Also build depoPurchaseData for pool entry creation (still aggregated by depo + purchase_type)
                    depoPurchaseData = {};
                    const insertTripDeposQuery = `
                        INSERT INTO trip_depos (
                            trip_id, depo_id, product_id, purchase_type, paid_amount, payable_amount,
                            CB, CD, MD, Active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
                    `;

                    // Match products with their inserted IDs (they're in the same order)
                    for (let i = 0; i < products.length && i < insertedProductIds.length; i++) {
                        const product = products[i];
                        const productId = insertedProductIds[i];

                        const depoId = product.depo_id;
                        const purchaseType = product.purchase_type || 'credit';

                        const invoiceRate = parseFloat(product.invoice_rate) || 0;
                        const discount = parseFloat(product.discount) || 0;
                        const rateAfterDiscount = invoiceRate - discount;
                        const purchaseAmount = (parseFloat(product.quantity_ltr) || 0) * rateAfterDiscount;

                        let paidAmount = parseFloat(product.paid_amount) || 0;
                        let payableAmount = 0;

                        // Set paid_amount and payable_amount based on purchase type
                        if (purchaseType === 'cash') {
                            paidAmount = purchaseAmount;
                            payableAmount = purchaseAmount;
                        } else if (purchaseType === 'advance') {
                            if (paidAmount === 0 || !paidAmount) {
                                paidAmount = purchaseAmount;
                            }
                            payableAmount = purchaseAmount;
                        } else {
                            paidAmount = 0;
                            payableAmount = purchaseAmount;
                        }

                        // Safety: paid_amount must never exceed payable_amount
                        if (paidAmount > payableAmount) {
                            paidAmount = payableAmount;
                        }

                        // Insert trip_depos entry for this specific product with its product_id
                        // NOTE: advance usage is tracked in the advance_balance table (not trip_depos.advance_balance)
                        console.log(`Inserting trip_depos: trip_id=${tripInsertId}, depo_id=${depoId}, product_id=${productId}, purchase_type=${purchaseType}, paid_amount=${paidAmount}, payable_amount=${payableAmount}`);
                        await connection.execute(insertTripDeposQuery, [
                            tripInsertId,
                            depoId,
                            productId, // Store the product_id from trip_products
                            purchaseType,
                            paidAmount,
                            payableAmount,
                            CB
                        ]);

                        // Also build depoPurchaseData for pool entry creation (aggregated by depo + purchase_type)
                        const key = `${depoId}_${purchaseType}`;
                        if (!depoPurchaseData[key]) {
                            depoPurchaseData[key] = {
                                depo_id: depoId,
                                purchase_type: purchaseType,
                                paid_amount: 0,
                                payable_amount: 0
                            };
                        }
                        depoPurchaseData[key].paid_amount += paidAmount;
                        depoPurchaseData[key].payable_amount += payableAmount;
                    }

                    console.log(`Successfully inserted ${products.length} trip_depos entries (one per product) for trip ${tripInsertId}`);
                } catch (err) {
                    console.error('Error inserting trip_depos:', err.message);
                    console.error('Error stack:', err.stack);
                    throw err; // Re-throw to trigger rollback
                }

                // Create pool entries separately with its own error handling
                // Pool entries are created only after trip_depos insertion succeeds
                // If pool entry creation fails, the transaction will be rolled back
                // Only create pool entries for credit and advance purchases (NOT for cash/full payment)
                try {
                    // Compute (1) advance consumption and (2) credit usage from depoPurchaseData.
                    // Frontend auto-select rules:
                    // - If Advance Balance >= Purchase Amount => purchase_type=cash (fully paid from advance balance)
                    // - If 0 < Advance Balance < Purchase Amount => purchase_type=advance (partially paid from advance balance)
                    // - If Advance Balance = 0 => purchase_type=credit (unpaid; uses credit limit)
                    const advanceConsumedByDepo = {}; // sum(paid_amount) for cash/advance
                    const creditUsedByDepo = {};      // sum((payable_amount - paid_amount)) for credit/advance

                    for (const depoData of Object.values(depoPurchaseData)) {
                        const depoId = depoData.depo_id;
                        const purchaseType = depoData.purchase_type || 'credit';
                        const payableAmount = parseFloat(depoData.payable_amount || 0) || 0;
                        const paidAmount = parseFloat(depoData.paid_amount || 0) || 0;
                        const safePaid = Math.min(paidAmount, payableAmount);
                        const remainingDue = Math.max(0, payableAmount - safePaid);

                        if (purchaseType === 'cash' || purchaseType === 'advance') {
                            if (!advanceConsumedByDepo[depoId]) advanceConsumedByDepo[depoId] = 0;
                            advanceConsumedByDepo[depoId] += safePaid;
                        }

                        // Any remaining due after paid_amount should hit credit limit (pool debit + depo.Balance reduction)
                        if (remainingDue > 0) {
                            if (!creditUsedByDepo[depoId]) creditUsedByDepo[depoId] = 0;
                            creditUsedByDepo[depoId] += remainingDue;
                        }
                    }

                    const allDepoIds = Array.from(new Set([
                        ...Object.keys(advanceConsumedByDepo).map(k => parseInt(k, 10)),
                        ...Object.keys(creditUsedByDepo).map(k => parseInt(k, 10))
                    ])).filter(n => !isNaN(n));

                    console.log(`addTrip pool/advance processing: depos=${allDepoIds.join(', ') || 'N/A'}`);

                    for (const depoId of allDepoIds) {
                        const advanceConsumed = parseFloat(advanceConsumedByDepo[depoId] || 0) || 0;
                        const creditUsed = parseFloat(creditUsedByDepo[depoId] || 0) || 0;

                        // 1) Consume advance (insert Debit entry in advance_balance with TripID)
                        if (advanceConsumed > 0) {
                            const [lastAdvanceRows] = await connection.execute(
                                `SELECT Balance FROM advance_balance
                                 WHERE DepoID = ? AND Active = 1
                                 ORDER BY ID DESC LIMIT 1`,
                                [depoId]
                            );
                            const currentAdvanceBalance = lastAdvanceRows.length > 0
                                ? parseFloat(lastAdvanceRows[0].Balance || 0)
                                : 0;
                            const newAdvanceBalance = Math.max(0, currentAdvanceBalance - advanceConsumed);

                            await connection.execute(
                                `INSERT INTO advance_balance (
                                    DepoID, TripID, recovery_id, payment_id, Debit, Credit, Balance, Date, MD, CD, CB, Active
                                ) VALUES (?, ?, NULL, NULL, ?, 0, ?, NOW(), NOW(), NOW(), ?, 1)`,
                                [depoId, tripInsertId, advanceConsumed, newAdvanceBalance, CB]
                            );

                            console.log(`Consumed advance for trip ${tripInsertId}, depo ${depoId}: Debit=${advanceConsumed}, NewAdvanceBalance=${newAdvanceBalance}`);
                        }

                        // 2) Use credit limit for remaining due (pool debit + depo.Balance reduction)
                        if (creditUsed > 0) {
                            const [depoBalanceRows] = await connection.execute(
                                `SELECT Balance FROM depo WHERE id = ? AND active = 1`,
                                [depoId]
                            );
                            const currentDepoBalance = depoBalanceRows.length > 0 ? parseFloat(depoBalanceRows[0].Balance || 0) : 0;
                            const newDepoBalance = currentDepoBalance - creditUsed;

                            // Update depo.Balance (credit limit remaining)
                            await connection.execute(
                                `UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?`,
                                [newDepoBalance, depoId]
                            );

                            // Previous DepoLimit from pool (running credit limit)
                            const [poolRows] = await connection.execute(
                                `SELECT DepoLimit FROM pool WHERE DepoID = ? AND active = 1 ORDER BY ID DESC LIMIT 1`,
                                [depoId]
                            );
                            const previousDepoLimit = poolRows.length > 0 ? parseFloat(poolRows[0].DepoLimit || 0) : currentDepoBalance;
                            const newDepoLimit = previousDepoLimit - creditUsed;

                            const poolQuery = `
                                INSERT INTO pool (
                                    DepoID,
                                    TripID,
                                    Debit,
                                    Credit,
                                    DepoLimit,
                                    payment_id,
                                    recovery_id,
                                    CD,
                                    CB,
                                    MD,
                                    active
                                ) VALUES (?, ?, ?, 0, ?, NULL, NULL, NOW(), ?, NOW(), 1)
                            `;

                            await connection.execute(poolQuery, [
                                depoId,
                                tripInsertId,
                                creditUsed,
                                newDepoLimit,
                                CB
                            ]);

                            console.log(`Pool debit for trip ${tripInsertId}, depo ${depoId}: Debit=${creditUsed}, PreviousDepoLimit=${previousDepoLimit}, NewDepoLimit=${newDepoLimit}`);
                        }
                    }

                    console.log(`Inserted ${Object.keys(depoPurchaseData).length} depo purchase record(s) for trip ${tripInsertId}`);
                } catch (poolErr) {
                    console.error(`CRITICAL ERROR creating pool entries for trip ${tripInsertId}:`, poolErr.message);
                    console.error('Error details:', JSON.stringify(poolErr, null, 2));
                    console.error('Error stack:', poolErr.stack);
                    // Re-throw the error so transaction can be rolled back
                    throw new Error(`Failed to create pool entries: ${poolErr.message}`);
                }

                // Update trips.paid to sum of all trip_depos.paid_amount for this trip
                if (tripInsertId) {
                    try {
                        const [tripDeposSum] = await connection.execute(
                            `SELECT COALESCE(SUM(paid_amount), 0) as total_paid
                         FROM trip_depos
                         WHERE trip_id = ? AND Active = 1`,
                            [tripInsertId]
                        );
                        const totalPaidForTrip = parseFloat(tripDeposSum[0]?.total_paid || 0);
                        await connection.execute(
                            `UPDATE trips SET paid = ?, total_amount = ? WHERE ID = ?`,
                            [totalPaidForTrip, productsTotalAmount, tripInsertId]
                        );
                        console.log(`Updated trip ${tripInsertId} paid = ${totalPaidForTrip}, total_amount = ${productsTotalAmount}`);
                    } catch (updateErr) {
                        console.error('Error updating trip paid/total_amount:', updateErr.message);
                        // Don't throw - trip was created, just log the error
                    }
                }
            } else {
                // If no trip_depos records, just update total_amount with productsTotalAmount
                if (tripInsertId) {
                    try {
                        await connection.execute(
                            `UPDATE trips SET total_amount = ? WHERE ID = ?`,
                            [productsTotalAmount, tripInsertId]
                        );
                        console.log(`Updated trip ${tripInsertId} total_amount = ${productsTotalAmount}`);
                    } catch (err) {
                        console.error('Error updating trip total_amount:', err.message);
                        console.error('Error stack:', err.stack);
                        throw err; // Re-throw to trigger rollback
                    }
                }
            }

            // Update transactions with trip_id for cash/advance payments
            if (tripInsertId && transactionIDsForTrip.length > 0) {
                for (const transactionId of transactionIDsForTrip) {
                    try {
                        // First verify the transaction exists
                        const [verifyRows] = await connection.execute(
                            `SELECT ID, trip_id FROM transactions WHERE ID = ? AND active = 1`,
                            [transactionId]
                        );

                        if (verifyRows.length === 0) {
                            console.error(`Transaction ${transactionId} not found or inactive`);
                        } else {
                            const [updateResult] = await connection.execute(
                                `UPDATE transactions 
                                 SET trip_id = ? 
                                 WHERE ID = ? AND active = 1`,
                                [tripInsertId, transactionId]
                            );
                            if (updateResult.affectedRows > 0) {
                                console.log(`Successfully updated transaction ${transactionId} with trip_id ${tripInsertId}`);
                            } else {
                                console.error(`Failed to update transaction ${transactionId} with trip_id ${tripInsertId}. No rows affected.`);
                            }
                        }
                    } catch (err) {
                        console.error(`Error updating transaction ${transactionId} trip_id:`, err.message);
                        // Don't rollback here, just log the error - the trip was already created
                    }
                }
            } else {
                if (!tripInsertId) {
                    console.error('tripInsertId is null or undefined');
                }
                if (transactionIDsForTrip.length === 0) {
                    console.log('No transaction IDs - this is expected for credit trips');
                }
            }

            // Update pool records with TripID for credit/advance products
            // Only update the specific pool entries created for this trip, not the initial balance entry
            const hasCreditOrAdvanceProducts = products && products.some(p => p.purchase_type === 'credit' || p.purchase_type === 'advance');
            if (tripInsertId && hasCreditOrAdvanceProducts) {
                try {
                    if (req.poolEntryIdsForTrip && req.poolEntryIdsForTrip.length > 0) {
                        // Update all pool entries created for this trip
                        for (const poolEntryId of req.poolEntryIdsForTrip) {
                            // Get depo_id for this pool entry
                            const [poolRows] = await connection.execute(
                                `SELECT DepoID FROM pool WHERE ID = ?`,
                                [poolEntryId]
                            );

                            if (poolRows.length > 0) {
                                const poolDepoId = poolRows[0].DepoID;
                                await connection.execute(
                                    `UPDATE pool 
                                     SET TripID = ? 
                                     WHERE ID = ? AND TripID IS NULL AND active = 1`,
                                    [tripInsertId, poolEntryId]
                                );
                                console.log(`Updated pool entry ${poolEntryId} with TripID ${tripInsertId} for depo ${poolDepoId}`);
                            }
                        }
                        console.log(`Updated ${req.poolEntryIdsForTrip.length} pool entry(ies) with TripID ${tripInsertId}`);
                    }
                } catch (err) {
                    console.log('Error updating pool TripID:', err.message);
                }
            }

            // Commit transaction
            await connection.commit();
            connection.release();

            console.log('Trip added successfully with ID:', result.insertId);
            res.json({
                message: 'Trip added successfully',
                id: result.insertId
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        console.error('Error adding trip:', err);
        console.error('Error details:', {
            code: err.code,
            sqlMessage: err.sqlMessage,
            sqlState: err.sqlState,
            errno: err.errno,
            sql: err.sql
        });
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({
                message: 'Trips table does not exist. Please create the table first.',
                error: err.message,
                sqlMessage: err.sqlMessage
            });
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message,
                sqlMessage: err.sqlMessage,
                code: err.code,
                errno: err.errno
            });
        }
    }
};

// Get today's POL sales (all customers sold fuel today)
exports.getTodayPolSales = async (req, res) => {
    try {
        const query = `
            SELECT 
                ps.id,
                ps.trip_id,
                ps.trip_product_id,
                ps.client_id,
                ps.Qty,
                ps.capacity,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.date,
                ps.container_type,
                c.name as client_name,
                pp.name as petrol_pump_name,
                t.trip_no,
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
            LEFT JOIN petrol_pumps pp ON COALESCE(ps.pump_id, ps.client_id) = pp.id AND pp.active = 1
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            WHERE ps.Active = 1
            ORDER BY ps.date DESC, ps.id DESC
        `;

        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching today\'s POL sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message
            });
        }
    }
};

// Update trip
exports.updateTrip = async (req, res) => {
    try {
        console.log('Received update trip data:', req.body);

        const {
            id,
            trip_no,
            start_date,
            vehicle_id,
            depo_id,
            fuel,
            cpl,
            spl,
            amount_collected,
            paid,
            payment_method,
            status,
            completed_at
        } = req.body;

        if (!id) {
            console.log('Update failed: Trip ID is missing');
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        // Validate required fields
        if (!start_date || !vehicle_id || !depo_id) {
            console.log('Update validation failed:', {
                start_date: !!start_date,
                vehicle_id: !!vehicle_id,
                depo_id: !!depo_id
            });
            return res.status(400).json({ message: 'Start date, vehicle, and depo are required' });
        }

        const query = `
            UPDATE trips SET
                trip_no = ?,
                start_date = ?,
                vehicle_id = ?,
                depo_id = ?,
                fuel = ?,
                cpl = ?,
                spl = ?,
                amount_collected = ?,
                paid = ?,
                status = ?,
                completed_at = ?,
                updated_at = NOW()
            WHERE id = ?
        `;

        // Ensure status is a valid string - NEVER null or undefined
        let tripStatus = 'Pending'; // Default value
        if (status !== null && status !== undefined && status !== '') {
            tripStatus = String(status).trim();
        }
        const validStatuses = ['Pending', 'In Progress', 'Completed', 'Cancelled'];
        const finalStatus = validStatuses.includes(tripStatus) ? tripStatus : 'Pending';

        // Ensure finalStatus is never null, undefined, or empty
        if (!finalStatus || finalStatus === '') {
            tripStatus = 'Pending';
        }

        console.log('Update Trip - Status received:', status, 'Type:', typeof status);
        console.log('Update Trip - Processed status:', tripStatus, 'Final status:', finalStatus);
        console.log('Update Trip - Full request body:', JSON.stringify(req.body, null, 2));

        const queryParams = [
            trip_no || null,
            start_date,
            vehicle_id,
            depo_id,
            fuel || null,
            cpl || null,
            spl || null,
            amount_collected || 0,
            paid || 0,
            finalStatus || 'Pending',
            completed_at || null,
            id
        ];

        console.log('Update Trip - Query parameters count:', queryParams.length);
        console.log('Update Trip - Status parameter:', queryParams[9]);

        const [result] = await db.execute(query, queryParams);

        console.log('Update Trip - Update result:', result);

        if (result.affectedRows === 0) {
            console.log('Update failed: No rows affected. Trip ID:', id);
            return res.status(404).json({ message: 'Trip not found' });
        }

        console.log('Trip updated successfully. ID:', id, 'Affected rows:', result.affectedRows);
        res.json({ message: 'Trip updated successfully' });
    } catch (err) {
        console.error('Error updating trip:', err);
        console.error('Error details:', {
            code: err.code,
            sqlMessage: err.sqlMessage,
            sqlState: err.sqlState,
            errno: err.errno
        });
        res.status(500).json({
            message: 'Server Error',
            error: err.message,
            sqlMessage: err.sqlMessage
        });
    }
};

exports.deleteTrip = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { id } = req.body;
        const auditUser = resolveAuditUser(req.body, 'System');

        if (!id) {
            //  RELEASE CONNECTION BEFORE RETURNING EARLY
            connection.release();
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        await connection.beginTransaction();

        // ============ STEP 1: Check if trip exists ============
        const [tripRows] = await connection.execute(
            'SELECT id, trip_no, total_amount, paid, amount_collected FROM trips WHERE id = ? AND Active = 1',
            [id]
        );

        if (tripRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Trip not found or already deleted' });
        }

        const trip = tripRows[0];
        console.log(`Starting soft delete for trip ${id} (${trip.trip_no})`);

        // ============ STEP 2-5: Get trip_products, trip_depos, pol_sale, recoveries ============
        const [tripProducts] = await connection.execute(`SELECT id FROM trip_products WHERE trip_id = ? AND Active = 1`, [id]);
        const [tripDepos] = await connection.execute(`SELECT id FROM trip_depos WHERE trip_id = ? AND Active = 1`, [id]);
        const [polSales] = await connection.execute(`SELECT id FROM pol_sale WHERE trip_id = ? AND Active = 1`, [id]);
        const [recoveries] = await connection.execute('SELECT ID, amount, clientid, pump_id FROM recoveries WHERE trip_id = ? AND Active = 1', [id]);
        const recoveryIds = recoveries.map(r => r.ID);

        // ============ STEP 6: Add recoveries to recoveries_advance table ============
        if (recoveryIds.length > 0) {
            const entryDate = new Date().toISOString().split('T')[0];
            for (const recovery of recoveries) {
                const amount = parseFloat(recovery.amount || 0);
                const clientId = recovery.clientid;
                const pumpId = recovery.pump_id;
                if (amount > 0) {
                    // Skip if pool or special_credit_limit has tripid IS NULL
                    const [poolCheck] = await connection.execute(`SELECT COUNT(*) as count FROM pool WHERE recovery_id = ? AND tripid IS NULL AND Active = 1`, [recovery.ID]);
                    const [sclCheck] = await connection.execute(`SELECT COUNT(*) as count FROM special_credit_limit WHERE recovery_id = ? AND tripid IS NULL AND Active = 1`, [recovery.ID]);
                    if (poolCheck[0].count > 0 || sclCheck[0].count > 0) {
                        console.log(`⏭️ Skipping recovery ${recovery.ID} from recoveries_advance addition`);
                        continue;
                    }

                    let customerField = null;
                    let customerId = null;
                    if (clientId) {
                        const [customerCheck] = await connection.execute(`SELECT id FROM customers WHERE id = ? AND Active = 1`, [clientId]);
                        if (customerCheck.length > 0) {
                            customerField = 'ws_customer_id';
                            customerId = clientId;
                        }
                    } else if (pumpId) {
                        customerField = 'pump_id';
                        customerId = pumpId;
                    }

                    if (customerField && customerId) {
                        const [balanceRows] = await connection.execute(`SELECT balance FROM recoveries_advance WHERE ${customerField} = ? AND Active = 1 ORDER BY ID DESC LIMIT 1`, [customerId]);
                        const currentBalance = balanceRows.length > 0 ? parseFloat(balanceRows[0].balance || 0) : 0;
                        const newBalance = currentBalance + amount;
                        await connection.execute(
                            `INSERT INTO recoveries_advance (${customerField}, entrydate, amount, debit, credit, balance, CB, MB, Active,trip_id) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, ?)`,
                            [customerId, entryDate, amount, amount, newBalance, auditUser, auditUser, id]
                        );
                        console.log(`✅ Added ${amount} to recoveries_advance for ${customerField}: ${customerId}, New Balance: ${newBalance}`);
                    }
                }
            }
        }

        // ============ STEP 7: Handle Pool entries ============
        const [poolEntries] = await connection.execute(`SELECT ID, DepoID, Debit, Credit FROM pool WHERE TripID = ? AND active = 1`, [id]);
        if (poolEntries.length > 0) {
            const depoPoolTotals = {};
            for (const entry of poolEntries) {
                const depoId = entry.DepoID;
                if (!depoPoolTotals[depoId]) depoPoolTotals[depoId] = { totalDebit: 0, totalCredit: 0 };
                depoPoolTotals[depoId].totalDebit += parseFloat(entry.Debit || 0);
                depoPoolTotals[depoId].totalCredit += parseFloat(entry.Credit || 0);
            }
            for (const [depoId, totals] of Object.entries(depoPoolTotals)) {
                const adjustment = totals.totalDebit - totals.totalCredit;
                if (adjustment !== 0) {
                    await connection.execute(`UPDATE depo SET Balance = Balance + ?, MD = NOW() WHERE id = ?`, [adjustment, depoId]);
                }
            }
            const poolIds = poolEntries.map(p => p.ID);
            const placeholders = poolIds.map(() => '?').join(',');
            await connection.execute(`UPDATE pool SET active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND active = 1`, poolIds);
            console.log(`✅ Soft deleted ${poolEntries.length} pool record(s)`);
        }

        // ============ STEP 8: Handle Special Credit Limit entries ============
        const [spCreditEntries] = await connection.execute(`SELECT ID, DepoID, Debit, Credit FROM special_credit_limit WHERE TripID = ? AND active = 1`, [id]);
        if (spCreditEntries.length > 0) {
            const depoSpCreditTotals = {};
            for (const entry of spCreditEntries) {
                const depoId = entry.DepoID;
                if (!depoSpCreditTotals[depoId]) depoSpCreditTotals[depoId] = { totalDebit: 0, totalCredit: 0 };
                depoSpCreditTotals[depoId].totalDebit += parseFloat(entry.Debit || 0);
                depoSpCreditTotals[depoId].totalCredit += parseFloat(entry.Credit || 0);
            }
            for (const [depoId, totals] of Object.entries(depoSpCreditTotals)) {
                const adjustment = totals.totalDebit - totals.totalCredit;
                if (adjustment !== 0) {
                    await connection.execute(`UPDATE depo SET special_credit_limit = special_credit_limit + ?, MD = NOW() WHERE id = ?`, [adjustment, depoId]);
                }
            }
            const spCreditIds = spCreditEntries.map(s => s.ID);
            const placeholders = spCreditIds.map(() => '?').join(',');
            await connection.execute(`UPDATE special_credit_limit SET active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND active = 1`, spCreditIds);
            console.log(`✅ Soft deleted ${spCreditEntries.length} special_credit_limit record(s)`);
        }

        // ============ STEP 9: Handle Advance Balance entries ============
        const [advanceBalances] = await connection.execute(`SELECT ID, DepoID FROM advance_balance WHERE TripID = ? AND Active = 1`, [id]);
        if (advanceBalances.length > 0) {
            const depoIds = [...new Set(advanceBalances.map(a => a.DepoID))];
            for (const depoId of depoIds) {
                await recalculateAdvanceBalances(connection, parseInt(depoId));
            }
            const advanceIds = advanceBalances.map(a => a.ID);
            const placeholders = advanceIds.map(() => '?').join(',');
            await connection.execute(`UPDATE advance_balance SET Active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND Active = 1`, advanceIds);
            console.log(`✅ Soft deleted ${advanceBalances.length} advance_balance record(s)`);
        }

        // ============ STEP 10-11: Reverse transactions effects on cash_in_hand and accounts ============
        const [transactions] = await connection.execute(`SELECT ID, AccountID, cash_in_hand_id, Credit, Debit FROM transactions WHERE trip_id = ? AND active = 1`, [id]);
        const cashInHandIds = [];
        const accountIds = [];
        if (transactions.length > 0) {
            for (const transaction of transactions) {
                const credit = parseFloat(transaction.Credit || 0);
                const debit = parseFloat(transaction.Debit || 0);
                if (transaction.cash_in_hand_id) {
                    cashInHandIds.push(transaction.cash_in_hand_id);
                    const [cashRows] = await connection.execute(`SELECT balance FROM cash_in_hand WHERE id = ? AND active = 1`, [transaction.cash_in_hand_id]);
                    if (cashRows.length > 0) {
                        let currentBalance = parseFloat(cashRows[0].balance || 0);
                        let newBalance = currentBalance;
                        if (credit > 0) newBalance = currentBalance - credit;
                        else if (debit > 0) newBalance = currentBalance + debit;
                        await connection.execute(`UPDATE cash_in_hand SET balance = ?, MD = NOW() WHERE id = ? AND active = 1`, [newBalance, transaction.cash_in_hand_id]);
                    }
                }
                if (transaction.AccountID) {
                    accountIds.push(transaction.AccountID);
                    const [accRows] = await connection.execute(`SELECT Balance FROM accounts WHERE ID = ? AND Active = 1`, [transaction.AccountID]);
                    if (accRows.length > 0) {
                        let currentBalance = parseFloat(accRows[0].Balance || 0);
                        let newBalance = currentBalance;
                        if (credit > 0) newBalance = currentBalance - credit;
                        else if (debit > 0) newBalance = currentBalance + debit;
                        await connection.execute(`UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ? AND Active = 1`, [newBalance, transaction.AccountID]);
                    }
                }
            }
        }

        // ============ STEP 12-15: Soft delete pol_sale, recoveries, trip_products, trip_depos ============
        if (polSales.length > 0) { await connection.execute('UPDATE pol_sale SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1', [id]); }
        if (recoveryIds.length > 0) { await connection.execute('UPDATE recoveries SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1', [id]); }
        if (tripProducts.length > 0) {
            const pIds = tripProducts.map(p => p.id);
            const placeholders = pIds.map(() => '?').join(',');
            await connection.execute(`UPDATE trip_products SET Active = 0, MD = NOW() WHERE id IN (${placeholders}) AND Active = 1`, pIds);
        }
        if (tripDepos.length > 0) {
            const dIds = tripDepos.map(d => d.id);
            const placeholders = dIds.map(() => '?').join(',');
            await connection.execute(`UPDATE trip_depos SET Active = 0, MD = NOW() WHERE id IN (${placeholders}) AND Active = 1`, dIds);
        }

        // ============ STEP 16-17: Soft delete cash_in_hand and transactions ============
        if (cashInHandIds.length > 0) {
            const placeholders = cashInHandIds.map(() => '?').join(',');
            await connection.execute(`UPDATE cash_in_hand SET active = 0, MD = NOW() WHERE id IN (${placeholders}) AND active = 1`, cashInHandIds);
            await recalculateAllBalances(connection);
        }
        if (transactions.length > 0) {
            const tIds = transactions.map(t => t.ID);
            const placeholders = tIds.map(() => '?').join(',');
            await connection.execute(`UPDATE transactions SET active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND active = 1`, tIds);
        }

        // ============ STEP 18-19: Soft delete payments ============
        const [payments] = await connection.execute(`SELECT ID FROM payments WHERE trip_id = ? AND Active = 1`, [id]);
        if (payments.length > 0) {
            const pIds = payments.map(p => p.ID);
            const placeholders = pIds.map(() => '?').join(',');
            await connection.execute(`UPDATE payments SET Active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND Active = 1`, pIds);
        }

        // ============ STEP 20: Soft delete trip ============
        await connection.execute('UPDATE trips SET Active = 0, MD = NOW() WHERE id = ? AND Active = 1', [id]);

        // ============ COMMIT ============
        await connection.commit();

        console.log(`✅ Successfully soft deleted trip ${id} (${trip.trip_no})`);
        res.json({
            message: 'Trip and related records soft deleted successfully',
            deleted: {
                trip: true,
                trip_products: tripProducts.length,
                trip_depos: tripDepos.length,
                pol_sale: polSales.length,
                recoveries: recoveryIds.length,
                payments: payments.length,
                transactions: transactions.length,
                pool: poolEntries.length,
                special_credit_limit: spCreditEntries.length,
                advance_balance: advanceBalances.length,
                cash_in_hand: cashInHandIds.length,
                accounts: accountIds.length
            }
        });

    } catch (err) {
        await connection.rollback();
        console.error('Error deleting trip:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message,
            sqlMessage: err.sqlMessage
        });
    } finally {
        // ✅ GUARANTEED RELEASE: This runs whether successful OR error
        if (connection) {
            try {
                connection.release();
                console.log(`🔓 Connection released successfully.`);
            } catch (releaseErr) {
                console.error('Error releasing connection:', releaseErr.message);
            }
        }
    }
};
//Connection leaks issues
exports._deleteTrip = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { id } = req.body;
        const auditUser = resolveAuditUser(req.body, 'System');

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        await connection.beginTransaction();

        // ============ STEP 1: Check if trip exists ============
        const [tripRows] = await connection.execute(
            'SELECT id, trip_no, total_amount, paid, amount_collected FROM trips WHERE id = ? AND Active = 1',
            [id]
        );

        if (tripRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Trip not found or already deleted' });
        }

        const trip = tripRows[0];
        console.log(`Starting soft delete for trip ${id} (${trip.trip_no})`);

        // ============ STEP 2: Get trip_products ============
        const [tripProducts] = await connection.execute(
            `SELECT id, trip_id, product_type, quantity_ltr 
             FROM trip_products WHERE trip_id = ? AND Active = 1`,
            [id]
        );

        if (tripProducts.length > 0) {
            console.log(`Found ${tripProducts.length} trip_products record(s) for trip ${id}`);
        } else {
            console.log(`No trip_products found for trip ${id}`);
        }

        // ============ STEP 3: Get trip_depos ============
        const [tripDepos] = await connection.execute(
            `SELECT id, depo_id, paid_amount, payable_amount, purchase_type, product_id 
             FROM trip_depos WHERE trip_id = ? AND Active = 1`,
            [id]
        );

        if (tripDepos.length > 0) {
            console.log(`Found ${tripDepos.length} trip_depos record(s) for trip ${id}`);
        } else {
            console.log(`No trip_depos found for trip ${id}`);
        }

        // ============ STEP 4: Get pol_sale records ============
        const [polSales] = await connection.execute(
            `SELECT id, client_id, pump_id, total_amount 
             FROM pol_sale WHERE trip_id = ? AND Active = 1`,
            [id]
        );

        if (polSales.length > 0) {
            console.log(`Found ${polSales.length} pol_sale record(s) for trip ${id}`);
        } else {
            console.log(`No pol_sale records found for trip ${id}`);
        }

        // ============ STEP 6: Reverse settlements for this trip ============
        const [tripSettlements] = await connection.execute(
            `SELECT * FROM settlements WHERE recovery_id IN (
        SELECT ID FROM recoveries WHERE trip_id = ?
    ) AND Active = 1`,
            [id]
        );

        if (tripSettlements.length > 0) {
            console.log(`Found ${tripSettlements.length} settlement(s) to reverse for trip ${id}`);

            for (const settlement of tripSettlements) {
                // Option A: Soft delete the settlement (if you want to keep original records)
                await connection.execute(
                    `UPDATE settlements 
                        SET Active = 0, 
                            MD = NOW(),
                            notes = CONCAT(IFNULL(notes, ''), ' | Reversed due to trip #', ?, ' reversal on ', NOW())
                        WHERE id = ? AND Active = 1`,
                    [id, settlement.id]
                );
                console.log(`✅ Soft deleted settlement #${settlement.id}`);

                /* // Option B: Create reversal entry with negative amount (recommended for accounting)
                await connection.execute(
                    `INSERT INTO settlements (
                recovery_id,
                client_id,
                pump_id,
                depo_id,
                amount,
                settlement_type,
                reference_no,
                notes,
                settlement_date,
                CD,
                MD,
                Active,
                MB,
                CB
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1, ?, ?)`,
                    [
                        settlement.recovery_id,
                        settlement.client_id,
                        settlement.pump_id,
                        settlement.depo_id,
                        -settlement.amount, // Negative amount to reverse
                        'REVERSAL',
                        settlement.reference_no ? `REV-${settlement.reference_no}` : null,
                        `Reversal of settlement #${settlement.id} - Trip #${id} reversal on ${new Date().toISOString().split('T')[0]}`,
                        new Date().toISOString().split('T')[0],
                        auditUser,
                        auditUser
                    ]
                ); 
                console.log(`✅ Created reversal entry for settlement #${settlement.id} (${-settlement.amount})`);*/
            }
        } else {
            console.log(`No settlements found for trip ${id}`);
        }
        // ============ STEP 5: Get recoveries for this trip ============
        const [recoveries] = await connection.execute(
            'SELECT ID, amount, clientid, pump_id, trip_id, Date FROM recoveries WHERE trip_id = ? AND Active = 1',
            [id]
        );
        const recoveryIds = recoveries.map(r => r.ID);

        if (recoveryIds.length > 0) {
            console.log(`Found ${recoveryIds.length} recovery record(s) for trip ${id}`);

            // ============ STEP 6: Add recoveries to recoveries_advance table ============
            const entryDate = new Date().toISOString().split('T')[0];
            for (const recovery of recoveries) {
                const amount = parseFloat(recovery.amount || 0);
                const clientId = recovery.clientid;
                const pumpId = recovery.pump_id;
                const recoveryDate = recovery.Date || entryDate;

                if (amount > 0) {
                    // ============ CHECK: Skip if recovery has pool or special_credit_limit with tripid IS NULL ============
                    let skipRecovery = false;

                    // Check pool table for this recovery_id with tripid IS NULL
                    const [poolCheck] = await connection.execute(
                        `SELECT COUNT(*) as count FROM pool WHERE recovery_id = ? AND tripid IS NULL AND Active = 1`,
                        [recovery.ID]
                    );

                    if (poolCheck[0].count > 0) {
                        console.log(`⚠️ Skipping recovery ${recovery.ID} - has ${poolCheck[0].count} pool record(s) with tripid IS NULL`);
                        skipRecovery = true;
                    }

                    // If not skipped yet, check special_credit_limit table
                    if (!skipRecovery) {
                        const [sclCheck] = await connection.execute(
                            `SELECT COUNT(*) as count FROM special_credit_limit WHERE recovery_id = ? AND tripid IS NULL AND Active = 1`,
                            [recovery.ID]
                        );

                        if (sclCheck[0].count > 0) {
                            console.log(`⚠️ Skipping recovery ${recovery.ID} - has ${sclCheck[0].count} special_credit_limit record(s) with tripid IS NULL`);
                            skipRecovery = true;
                        }
                    }

                    // Skip this recovery if conditions are met
                    if (skipRecovery) {
                        console.log(`⏭️ Skipping recovery ${recovery.ID} from recoveries_advance addition`);
                        continue;
                    }
                    // ============ END OF CHECK ============
                    let customerField = null;
                    let customerId = null;

                    // Determine which field to use
                    if (clientId) {
                        // Check if this client exists in customers table (Supplier)
                        const [customerCheck] = await connection.execute(
                            `SELECT id FROM customers WHERE id = ? AND Active = 1`,
                            [clientId]
                        );
                        if (customerCheck.length > 0) {
                            customerField = 'ws_customer_id';
                            customerId = clientId;
                        }
                    } else if (pumpId) {
                        // Petrol pump (self)
                        customerField = 'pump_id';
                        customerId = pumpId;
                    }

                    if (customerField && customerId) {
                        // Get current balance from recoveries_advance
                        const [balanceRows] = await connection.execute(
                            `SELECT balance FROM recoveries_advance 
                             WHERE ${customerField} = ? AND Active = 1 
                             ORDER BY ID DESC LIMIT 1`,
                            [customerId]
                        );
                        const currentBalance = balanceRows.length > 0 ? parseFloat(balanceRows[0].balance || 0) : 0;
                        const newBalance = currentBalance + amount;

                        // Format the recovery date
                        let formattedDate = entryDate;
                        if (recoveryDate) {
                            const dateObj = new Date(recoveryDate);
                            if (!isNaN(dateObj.getTime())) {
                                formattedDate = dateObj.toISOString().split('T')[0];
                            }
                        }

                        // Insert into recoveries_advance
                        await connection.execute(
                            `INSERT INTO recoveries_advance (
                                ${customerField},
                                entrydate,
                                amount,
                                debit,
                                credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1)`,
                            [
                                customerId,
                                formattedDate,
                                amount,
                                amount,
                                newBalance,
                                auditUser,
                                auditUser
                            ]
                        );
                        console.log(`✅ Added ${amount} to recoveries_advance for ${customerField}: ${customerId}, New Balance: ${newBalance}`);
                    } else {
                        console.log(`⚠️ Warning: Could not determine customer type for recovery ${recovery.ID}`);
                    }
                }
            }
        } else {
            console.log(`No recoveries found for trip ${id}`);
        }

        // ============ STEP 7: Handle Pool entries for this trip ============
        const [poolEntries] = await connection.execute(
            `SELECT ID, DepoID, Debit, Credit, DepoLimit 
             FROM pool WHERE TripID = ? AND active = 1`,
            [id]
        );

        if (poolEntries.length > 0) {
            console.log(`Found ${poolEntries.length} pool record(s) for trip ${id}`);

            const depoPoolTotals = {};
            for (const entry of poolEntries) {
                const depoId = entry.DepoID;
                if (!depoPoolTotals[depoId]) {
                    depoPoolTotals[depoId] = { totalDebit: 0, totalCredit: 0 };
                }
                depoPoolTotals[depoId].totalDebit += parseFloat(entry.Debit || 0);
                depoPoolTotals[depoId].totalCredit += parseFloat(entry.Credit || 0);
            }

            for (const [depoId, totals] of Object.entries(depoPoolTotals)) {
                const adjustment = totals.totalDebit - totals.totalCredit;
                if (adjustment !== 0) {
                    await connection.execute(
                        `UPDATE depo SET Balance = Balance + ?, MD = NOW() WHERE id = ?`,
                        [adjustment, depoId]
                    );
                    console.log(`✅ Adjusted depo ${depoId} Balance by +${adjustment} (pool reversal)`);
                }
            }

            const poolIds = poolEntries.map(p => p.ID);
            const placeholders = poolIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE pool SET active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND active = 1`,
                poolIds
            );
            console.log(`✅ Soft deleted ${poolEntries.length} pool record(s)`);
        } else {
            console.log(`No pool entries found for trip ${id}`);
        }

        // ============ STEP 8: Handle Special Credit Limit entries ============
        const [spCreditEntries] = await connection.execute(
            `SELECT ID, DepoID, Debit, Credit, DepoLimit 
             FROM special_credit_limit WHERE TripID = ? AND active = 1`,
            [id]
        );

        if (spCreditEntries.length > 0) {
            console.log(`Found ${spCreditEntries.length} special_credit_limit record(s) for trip ${id}`);

            const depoSpCreditTotals = {};
            for (const entry of spCreditEntries) {
                const depoId = entry.DepoID;
                if (!depoSpCreditTotals[depoId]) {
                    depoSpCreditTotals[depoId] = { totalDebit: 0, totalCredit: 0 };
                }
                depoSpCreditTotals[depoId].totalDebit += parseFloat(entry.Debit || 0);
                depoSpCreditTotals[depoId].totalCredit += parseFloat(entry.Credit || 0);
            }

            for (const [depoId, totals] of Object.entries(depoSpCreditTotals)) {
                const adjustment = totals.totalDebit - totals.totalCredit;
                if (adjustment !== 0) {
                    await connection.execute(
                        `UPDATE depo SET special_credit_limit = special_credit_limit + ?, MD = NOW() WHERE id = ?`,
                        [adjustment, depoId]
                    );
                    console.log(`✅ Adjusted depo ${depoId} special_credit_limit by +${adjustment} (special credit reversal)`);
                }
            }

            const spCreditIds = spCreditEntries.map(s => s.ID);
            const placeholders = spCreditIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE special_credit_limit SET active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND active = 1`,
                spCreditIds
            );
            console.log(`✅ Soft deleted ${spCreditEntries.length} special_credit_limit record(s)`);
        } else {
            console.log(`No special_credit_limit entries found for trip ${id}`);
        }

        // ============ STEP 9: Handle Advance Balance entries ============
        const [advanceBalances] = await connection.execute(
            `SELECT ID, DepoID, Debit, Credit, Balance 
             FROM advance_balance WHERE TripID = ? AND Active = 1`,
            [id]
        );

        if (advanceBalances.length > 0) {
            console.log(`Found ${advanceBalances.length} advance_balance record(s) for trip ${id}`);

            const depoAdvanceTotals = {};
            for (const entry of advanceBalances) {
                const depoId = entry.DepoID;
                if (!depoAdvanceTotals[depoId]) {
                    depoAdvanceTotals[depoId] = { totalDebit: 0, totalCredit: 0 };
                }
                depoAdvanceTotals[depoId].totalDebit += parseFloat(entry.Debit || 0);
                depoAdvanceTotals[depoId].totalCredit += parseFloat(entry.Credit || 0);
            }

            for (const depoId of Object.keys(depoAdvanceTotals)) {
                await recalculateAdvanceBalances(connection, parseInt(depoId));
                console.log(`✅ Recalculated advance_balance for depo ${depoId}`);
            }

            const advanceIds = advanceBalances.map(a => a.ID);
            const placeholders = advanceIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE advance_balance SET Active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND Active = 1`,
                advanceIds
            );
            console.log(`✅ Soft deleted ${advanceBalances.length} advance_balance record(s)`);
        } else {
            console.log(`No advance_balance entries found for trip ${id}`);
        }

        // ============ STEP 10: Get transactions for this trip ============
        const [transactions] = await connection.execute(
            `SELECT ID, AccountID, cash_in_hand_id, Credit, Debit, active 
             FROM transactions WHERE trip_id = ? AND active = 1`,
            [id]
        );

        if (transactions.length > 0) {
            console.log(`Found ${transactions.length} transaction(s) for trip ${id}`);
        } else {
            console.log(`No transactions found for trip ${id}`);
        }

        // ============ STEP 11: Reverse transactions effects on cash_in_hand and accounts ============
        const cashInHandIds = [];
        const accountIds = [];

        if (transactions.length > 0) {
            for (const transaction of transactions) {
                const credit = parseFloat(transaction.Credit || 0);
                const debit = parseFloat(transaction.Debit || 0);

                // ============ Reverse cash_in_hand effect ============
                if (transaction.cash_in_hand_id) {
                    cashInHandIds.push(transaction.cash_in_hand_id);

                    // In cash_in_hand table:
                    // - Credit increases balance (money coming in)
                    // - Debit decreases balance (money going out)
                    // To reverse: Reverse the effect on balance
                    // If there was a Credit, we need to Debit it back (subtract)
                    // If there was a Debit, we need to Credit it back (add)

                    // Get the cash_in_hand record
                    const [cashRows] = await connection.execute(
                        `SELECT balance FROM cash_in_hand WHERE id = ? AND active = 1`,
                        [transaction.cash_in_hand_id]
                    );

                    if (cashRows.length > 0) {
                        let currentBalance = parseFloat(cashRows[0].balance || 0);
                        let newBalance = currentBalance;

                        // Reverse the transaction effect
                        // If transaction had Credit (money came in), we need to subtract it
                        // If transaction had Debit (money went out), we need to add it back
                        if (credit > 0) {
                            newBalance = currentBalance - credit;
                        } else if (debit > 0) {
                            newBalance = currentBalance + debit;
                        }

                        // Update cash_in_hand balance
                        await connection.execute(
                            `UPDATE cash_in_hand SET balance = ?, MD = NOW() WHERE id = ? AND active = 1`,
                            [newBalance, transaction.cash_in_hand_id]
                        );
                        console.log(`✅ Reversed cash_in_hand ${transaction.cash_in_hand_id}: ${currentBalance} -> ${newBalance} (Credit: ${credit}, Debit: ${debit})`);
                    }
                }

                // ============ Reverse accounts effect ============
                if (transaction.AccountID) {
                    accountIds.push(transaction.AccountID);

                    // In accounts table:
                    // - Credit increases balance (money coming in)
                    // - Debit decreases balance (money going out)
                    // To reverse: Reverse the effect on balance

                    const [accRows] = await connection.execute(
                        `SELECT Balance FROM accounts WHERE ID = ? AND Active = 1`,
                        [transaction.AccountID]
                    );

                    if (accRows.length > 0) {
                        let currentBalance = parseFloat(accRows[0].Balance || 0);
                        let newBalance = currentBalance;

                        // Reverse the transaction effect
                        if (credit > 0) {
                            newBalance = currentBalance - credit;
                        } else if (debit > 0) {
                            newBalance = currentBalance + debit;
                        }

                        // Update account balance
                        await connection.execute(
                            `UPDATE accounts SET Balance = ?, MD = NOW() WHERE ID = ? AND Active = 1`,
                            [newBalance, transaction.AccountID]
                        );
                        console.log(`✅ Reversed account ${transaction.AccountID}: ${currentBalance} -> ${newBalance} (Credit: ${credit}, Debit: ${debit})`);
                    }
                }
            }
        }

        // ============ STEP 12: Soft delete pol_sale ============
        if (polSales.length > 0) {
            await connection.execute(
                'UPDATE pol_sale SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1',
                [id]
            );
            console.log(`✅ Soft deleted ${polSales.length} pol_sale record(s) (customer dues reversed)`);
        }

        // ============ STEP 13: Soft delete recoveries ============
        if (recoveryIds.length > 0) {
            await connection.execute(
                'UPDATE recoveries SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1',
                [id]
            );
            console.log(`✅ Soft deleted ${recoveryIds.length} recovery record(s)`);
        }

        // ============ STEP 14: Soft delete trip_products ============
        if (tripProducts.length > 0) {
            const productIds = tripProducts.map(p => p.id);
            const placeholders = productIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE trip_products SET Active = 0, MD = NOW() WHERE id IN (${placeholders}) AND Active = 1`,
                productIds
            );
            console.log(`✅ Soft deleted ${tripProducts.length} trip_products record(s)`);
        }

        // ============ STEP 15: Soft delete trip_depos ============
        if (tripDepos.length > 0) {
            const depoIds = tripDepos.map(d => d.id);
            const placeholders = depoIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE trip_depos SET Active = 0, MD = NOW() WHERE id IN (${placeholders}) AND Active = 1`,
                depoIds
            );
            console.log(`✅ Soft deleted ${tripDepos.length} trip_depos record(s)`);
        }

        // ============ STEP 16: Soft delete cash_in_hand records ============
        if (cashInHandIds.length > 0) {
            const placeholders = cashInHandIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE cash_in_hand SET active = 0, MD = NOW() WHERE id IN (${placeholders}) AND active = 1`,
                cashInHandIds
            );
            console.log(`✅ Soft deleted ${cashInHandIds.length} cash_in_hand record(s)`);

            // Recalculate all cash_in_hand balances
            await recalculateAllBalances(connection);
            console.log(`✅ Recalculated all cash_in_hand balances`);
        }

        // ============ STEP 17: Soft delete transactions ============
        if (transactions.length > 0) {
            const transactionIds = transactions.map(t => t.ID);
            const placeholders = transactionIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE transactions SET active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND active = 1`,
                transactionIds
            );
            console.log(`✅ Soft deleted ${transactions.length} transaction(s)`);
        }

        // ============ STEP 18: Get payments for this trip ============
        let payments = [];
        [payments] = await connection.execute(
            `SELECT ID, depoid, amount, transactionID, trip_id
             FROM payments 
             WHERE trip_id = ? AND Active = 1`,
            [id]
        );

        if (payments.length > 0) {
            console.log(`Found ${payments.length} payment(s) for trip ${id}`);
        } else {
            console.log(`No payments found for trip ${id}`);
        }

        // ============ STEP 19: Soft delete payments ============
        if (payments.length > 0) {
            const paymentIds = payments.map(p => p.ID);
            const placeholders = paymentIds.map(() => '?').join(',');
            await connection.execute(
                `UPDATE payments SET Active = 0, MD = NOW() WHERE ID IN (${placeholders}) AND Active = 1`,
                paymentIds
            );
            console.log(`✅ Soft deleted ${payments.length} payment record(s)`);
        }

        // ============ STEP 20: Soft delete trip ============
        await connection.execute(
            'UPDATE trips SET Active = 0, MD = NOW() WHERE id = ? AND Active = 1',
            [id]
        );
        console.log(`✅ Soft deleted trip ${id}`);

        // ============ COMMIT ============
        await connection.commit();
        connection.release();

        console.log(`✅ Successfully soft deleted trip ${id} (${trip.trip_no})`);
        res.json({
            message: 'Trip and related records soft deleted successfully',
            deleted: {
                trip: true,
                trip_products: tripProducts.length,
                trip_depos: tripDepos.length,
                pol_sale: polSales.length,
                recoveries: recoveryIds.length,
                payments: payments.length,
                transactions: transactions.length,
                pool: poolEntries.length,
                special_credit_limit: spCreditEntries.length,
                advance_balance: advanceBalances.length,
                cash_in_hand: cashInHandIds.length,
                accounts: accountIds.length
            }
        });

    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error deleting trip:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message,
            sqlMessage: err.sqlMessage
        });
    }
};
// Get remaining amount for a depo (payable_amount - paid_amount)
exports.getDepoRemainingAmount = async (req, res) => {
    try {
        const depoId = req.query.depoId;

        if (!depoId) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        // Get depo info (Balance and previous_payables come from depo table; advance comes from advance_balance table)
        const [depoRows] = await db.execute(
            `SELECT Balance, previous_payables, special_credit_limit FROM depo WHERE id = ? AND active = 1`,
            [depoId]
        );

        if (depoRows.length === 0) {
            return res.status(404).json({ message: 'Depo not found' });
        }

        const depoBalance = parseFloat(depoRows[0].Balance || 0);
        const previousPayables = parseFloat(depoRows[0].previous_payables || 0) || 0;

        // Advance balance is stored in advance_balance table (latest Balance)
        const [advanceRows] = await db.execute(
            `SELECT COALESCE(Balance, 0) as advance_balance
             FROM advance_balance
             WHERE DepoID = ? AND Active = 1
             ORDER BY ID DESC
             LIMIT 1`,
            [depoId]
        );
        const advanceBalance = parseFloat(advanceRows[0]?.advance_balance || 0);

        // ============================================
        // 1. Get Regular Credit Limit (from pool table)
        // ============================================
        // Pool table is updated when recoveries/payments are added, so it's always current
        const [latestPoolRows] = await db.execute(
            `SELECT DepoLimit, ID
             FROM pool
             WHERE DepoID = ? AND active = 1
             ORDER BY ID DESC
             LIMIT 1`,
            [depoId]
        );

        // Use pool DepoLimit as source of truth, fallback to depo.Balance if no pool entries exist
        const currentPoolLimit = latestPoolRows.length > 0
            ? parseFloat(latestPoolRows[0].DepoLimit || 0)
            : depoBalance;

        // Log for debugging if there's a mismatch between pool and depo table
        if (latestPoolRows.length > 0) {
            const poolDepoLimit = parseFloat(latestPoolRows[0].DepoLimit || 0);
            if (Math.abs(depoBalance - poolDepoLimit) > 0.01) {
                console.log(`Warning: depo.Balance (${depoBalance}) != pool DepoLimit (${poolDepoLimit}) for depo ${depoId}. Using pool DepoLimit.`);
            }
        }

        // Calculate remaining amount from trip_depos (amount owed from trips)
        const [remainingBalanceRows] = await db.execute(
            `SELECT COALESCE(SUM(payable_amount - COALESCE(paid_amount, 0)), 0) as remaining_balance
            FROM trip_depos
            WHERE depo_id = ?
            AND (purchase_type = 'credit' OR purchase_type = 'specialcredit')
            AND Active = 1
            AND (payable_amount - COALESCE(paid_amount, 0)) > 0`,
            [depoId]
        );

        const tripRemainingAmount = parseFloat(remainingBalanceRows[0]?.remaining_balance || 0);

        // Total remaining amount = previous_payables + trip payables
        // Since payments are applied to previous_payables first, then to trips,
        // the total payable is: current previous_payables + trip payables
        //const remainingAmount = previousPayables + tripRemainingAmount;
        const remainingAmount = tripRemainingAmount;

        // Total available funds for new product purchases:
        // - credit side: currentPoolLimit
        // - advance side: advanceBalance
        const totalAvailable = advanceBalance + currentPoolLimit;

        console.log(`Depo ${depoId}: PreviousPayables=${previousPayables}, TripRemainingAmount=${tripRemainingAmount}, TotalRemainingAmount=${remainingAmount}, AdvanceBalance=${advanceBalance}, CreditBalance=${currentPoolLimit}, TotalAvailable=${totalAvailable}`);

        // ============================================
        // 1. Get Special Credit Limit (from specialcredit limit table)
        // ============================================
        const [latestSpCreditRows] = await db.execute(
            `SELECT DepoLimit, ID
             FROM special_credit_limit
             WHERE DepoID = ? AND active = 1
             ORDER BY ID DESC
             LIMIT 1`,
            [depoId]
        );

        const currentSpCreditLimit = latestSpCreditRows.length > 0
            ? parseFloat(latestSpCreditRows[0].DepoLimit || 0)
            : 0;


        // Calculate remaining amount from trip_depos (amount owed from trips)
        const [spcreditremainingBalanceRows] = await db.execute(
            `SELECT COALESCE(SUM(payable_amount - COALESCE(paid_amount, 0)), 0) as remaining_balance
             FROM trip_depos
             WHERE depo_id = ?  And purchase_type='special credit'
               AND Active = 1
               AND (payable_amount - COALESCE(paid_amount, 0)) > 0`,
            [depoId]
        );

        const spcredittripRemainingAmount = parseFloat(spcreditremainingBalanceRows[0]?.remaining_balance || 0);

        // Total remaining amount = previous_payables + trip payables
        // Since payments are applied to previous_payables first, then to trips,
        // the total payable is: current previous_payables + trip payables
        //const specialCreditRemaining = tripRemainingAmount;

        // Total available funds for new product purchases:
        // - credit side: currentPoolLimit
        // - advance side: advanceBalance
        //const totalAvailable = advanceBalance + currentPoolLimit;


        res.json({
            remainingAmount: remainingAmount,
            spCreditRemainingAmount: spcredittripRemainingAmount,
            previousPayables: previousPayables,
            tripRemainingAmount: tripRemainingAmount,
            advanceBalance: advanceBalance,
            // IMPORTANT: This is the "current credit limit" (latest pool DepoLimit), matching Pool History UI
            creditBalance: currentPoolLimit,
            spcreditBalance: currentSpCreditLimit,
            totalAvailable: totalAvailable
        });
    } catch (err) {
        console.error('Error fetching depo remaining amount:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message
        });
    }
};

// Get clients for dropdown (using customers table)
exports.getClients = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT id, name, phone, address FROM customers WHERE active = 1 ORDER BY name');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching clients:', err);
        console.error('Error details:', {
            code: err.code,
            sqlMessage: err.sqlMessage,
            sqlState: err.sqlState
        });
        // Return empty array if table doesn't exist, otherwise return error
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message,
                sqlMessage: err.sqlMessage
            });
        }
    }
};

// Get today's POL sales (all customers sold fuel today)
exports.getTodayPolSales = async (req, res) => {
    try {
        const query = `
            SELECT 
                ps.id,
                ps.trip_id,
                ps.trip_product_id,
                ps.client_id,
                ps.Qty,
                ps.capacity,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.date,
                ps.container_type,
                c.name as client_name,
                pp.name as petrol_pump_name,
                t.trip_no,
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
            LEFT JOIN petrol_pumps pp ON COALESCE(ps.pump_id, ps.client_id) = pp.id AND pp.active = 1
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            WHERE ps.Active = 1
            ORDER BY ps.date DESC, ps.id DESC
        `;

        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching today\'s POL sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message
            });
        }
    }
};

// Get license holders for dropdown
exports.getLicenseHolders = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT id, name, petrol_pump_id, contact_number, email, address, license_number, is_active FROM licensees ORDER BY name');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching license holders:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Add license holder
exports.addLicenseHolder = async (req, res) => {
    try {
        const {
            name,
            petrol_pump_id,
            contact_number,
            email,
            address,
            license_number,
            is_active
        } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'License holder name is required' });
        }
        if (!petrol_pump_id) {
            return res.status(400).json({ message: 'Petrol pump id is required' });
        }

        const [result] = await db.execute(
            'INSERT INTO licensees (name, petrol_pump_id, contact_number, email, address, license_number, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                name,
                petrol_pump_id,
                contact_number || null,
                email || null,
                address || null,
                license_number || null,
                typeof is_active === 'number' ? is_active : (is_active ? 1 : 0)
            ]
        );

        res.json({
            message: 'License holder added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding license holder:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'licenseholders table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update license holder
exports.updateLicenseHolder = async (req, res) => {
    try {
        const {
            id,
            name,
            petrol_pump_id,
            contact_number,
            email,
            address,
            license_number,
            is_active
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'License holder ID is required' });
        }
        if (!name) {
            return res.status(400).json({ message: 'License holder name is required' });
        }
        if (!petrol_pump_id) {
            return res.status(400).json({ message: 'Petrol pump id is required' });
        }

        const [result] = await db.execute(
            'UPDATE licensees SET name = ?, petrol_pump_id = ?, contact_number = ?, email = ?, address = ?, license_number = ?, is_active = ? WHERE id = ?',
            [
                name,
                petrol_pump_id,
                contact_number || null,
                email || null,
                address || null,
                license_number || null,
                typeof is_active === 'number' ? is_active : (is_active ? 1 : 0),
                id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'License holder not found' });
        }

        res.json({ message: 'License holder updated successfully' });
    } catch (err) {
        console.error('Error updating license holder:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete license holder
exports.deleteLicenseHolder = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'License holder ID is required' });
        }

        const [result] = await db.execute(
            'DELETE FROM licensees WHERE id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'License holder not found' });
        }

        res.json({ message: 'License holder deleted successfully' });
    } catch (err) {
        console.error('Error deleting license holder:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get vehicles for dropdown
exports.getVehicles = async (req, res) => {
    try {
        const query = `
            SELECT 
                v.id,
                v.number,
                v.type,
                v.capacity,
                v.driver_id,
                d.name as driver_name,
                v.Active as is_active
            FROM vehicles v
            LEFT JOIN drivers d ON v.driver_id = d.id
            WHERE v.Active = 1
            ORDER BY v.number
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching vehicles:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Add vehicle
exports.addVehicle = async (req, res) => {
    try {
        const {
            number,
            type,
            capacity,
            driver_id,
            is_active
        } = req.body;

        if (!number) {
            return res.status(400).json({ message: 'Vehicle number is required' });
        }

        const CB = resolveAuditUser(req.body, 'System');

        const [result] = await db.execute(
            'INSERT INTO vehicles (number, type, capacity, driver_id, Active, CB, CD, MD) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())',
            [
                number,
                type || null,
                capacity || null,
                driver_id || null,
                typeof is_active === 'number' ? is_active : (is_active ? 1 : 0),
                CB
            ]
        );

        res.json({
            message: 'Vehicle added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding vehicle:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'vehicles table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update vehicle
exports.updateVehicle = async (req, res) => {
    try {
        const {
            id,
            number,
            type,
            capacity,
            driver_id,
            is_active
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Vehicle ID is required' });
        }
        if (!number) {
            return res.status(400).json({ message: 'Vehicle number is required' });
        }

        const [result] = await db.execute(
            'UPDATE vehicles SET number = ?, type = ?, capacity = ?, driver_id = ?, Active = ?, MD = NOW() WHERE id = ?',
            [
                number,
                type || null,
                capacity || null,
                driver_id || null,
                typeof is_active === 'number' ? is_active : (is_active ? 1 : 0),
                id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        res.json({ message: 'Vehicle updated successfully' });
    } catch (err) {
        console.error('Error updating vehicle:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete vehicle
exports.deleteVehicle = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Vehicle ID is required' });
        }

        const [result] = await db.execute(
            'DELETE FROM vehicles WHERE id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        res.json({ message: 'Vehicle deleted successfully' });
    } catch (err) {
        console.error('Error deleting vehicle:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get drivers for dropdown
exports.getDrivers = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT id, name, phone, license_number, address, is_active FROM drivers ORDER BY name');
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

// Get petrol pumps for dropdown (deprecated - use getDepos instead)
exports.getPetrolPumps = async (req, res) => {
    try {
        // Using depo table as per new schema
        const [rows] = await db.execute('SELECT id, name, phone_no, address FROM depo ORDER BY name');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching depos:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get total sold fuel for a trip
exports.getSoldFuelForTrip = async (req, res) => {
    try {
        const trip_id = req.query.trip_id;

        if (!trip_id) {
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        // Get total fuel sold for this trip
        const query = `
            SELECT COALESCE(SUM(fuel), 0) as total_sold
            FROM pol_sale
            WHERE trip_id = ? AND Active = 1
        `;

        const [rows] = await db.execute(query, [trip_id]);
        const totalSold = rows[0]?.total_sold || 0;

        // Get trip fuel capacity
        const tripQuery = `SELECT fuel FROM trips WHERE id = ?`;
        const [tripRows] = await db.execute(tripQuery, [trip_id]);
        const tripFuel = tripRows[0]?.fuel || 0;

        const availableFuel = Number(tripFuel) - Number(totalSold);

        res.json({
            trip_id: parseInt(trip_id),
            total_fuel: Number(tripFuel),
            sold_fuel: Number(totalSold),
            available_fuel: availableFuel > 0 ? availableFuel : 0
        });
    } catch (err) {
        console.error('Error fetching sold fuel:', err);
        res.status(500).json({
            message: 'Server Error',
            error: err.message
        });
    }
};

// Get trip products for a trip (for sale form)
exports.getTripProducts = async (req, res) => {
    try {
        const trip_id = req.query.trip_id;
        if (!trip_id) {
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        const query = `
            SELECT 
                tp.id,
                tp.trip_id,
                tp.depo_id,
                d.name as depo_name,
                tp.product_type,
                tp.quantity_ltr,
                COALESCE(tp.qty_sold, 0) as qty_sold,
                (tp.quantity_ltr - COALESCE(tp.qty_sold, 0)) as available_quantity,
                tp.invoice_rate,
                tp.discount,
                tp.container_type,
                tp.container_liters,
                tp.no_of_containers
            FROM trip_products tp
            LEFT JOIN depo d ON tp.depo_id = d.id
            WHERE tp.trip_id = ? AND tp.active = 1
            ORDER BY tp.product_type, d.name
        `;

        const [rows] = await db.execute(query, [trip_id]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching trip products:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get trip product details with depo and purchase type for child rows
exports.getTripProductDetails = async (req, res) => {
    try {
        const trip_id = req.query.trip_id;
        if (!trip_id) {
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        // CORRECT APPROACH: Join on product_id to match each product with its specific payment entry
        // This eliminates the cartesian product issue - each product only matches its own payment entries
        const query = `
            SELECT 
                tp.id,
                tp.trip_id,
                tp.depo_id,
                d.name as depo_name,
                c.name as company_name,
                tp.pickup_id,
                pul.name as pick_up_location_name,
                tp.product_type,
                tp.quantity_ltr,
                tp.invoice_rate,
                tp.discount,
                tp.purchase_amount,
                td.purchase_type,
                COALESCE(td.paid_amount, 0) as paid_amount,
                COALESCE(td.payable_amount, 0) as payable_amount,
                (COALESCE(td.payable_amount, 0) - COALESCE(td.paid_amount, 0)) as remaining_amount
            FROM trip_products tp
            INNER JOIN depo d ON tp.depo_id = d.id AND d.active = 1
            LEFT JOIN depo_company dc ON dc.depo_id = d.id AND dc.active = 1
            LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
            LEFT JOIN pick_up_location pul ON tp.pickup_id = pul.id AND pul.active = 1
            INNER JOIN trip_depos td ON td.trip_id = tp.trip_id 
                AND td.depo_id = tp.depo_id 
                AND td.product_id = tp.id
                AND td.Active = 1
            WHERE tp.trip_id = ? AND tp.active = 1
            ORDER BY tp.product_type, 
                     CASE td.purchase_type 
                         WHEN 'cash' THEN 1 
                         WHEN 'credit' THEN 2 
                         WHEN 'advance' THEN 3 
                         ELSE 4 
                     END,
                     tp.id
        `;

        const [rows] = await db.execute(query, [trip_id]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching trip product details:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add sale
exports.addSale = async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        //console.log('Received sale data:', req.body);

        const {
            trip_id,
            trip_product_id,
            client_id,
            customer_type_id,
            Qty,
            capacity,
            no_of_containers,
            fuel,
            rate,
            Discount,
            total_amount,
            date,
            container_type
        } = req.body;

        // Validate required fields
        if (!trip_id || !trip_product_id || !client_id || !fuel || !rate || !date || !total_amount) {
            return res.status(400).json({
                message: 'Missing required fields: trip_id, trip_product_id, client_id, fuel, rate, total_amount, and date are required'
            });
        }

        // Get trip product details
        const [tripProductRows] = await connection.execute(
            'SELECT *, COALESCE(qty_sold, 0) as qty_sold FROM trip_products WHERE id = ? AND active = 1',
            [trip_product_id]
        );

        if (tripProductRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Trip product not found or inactive' });
        }

        const tripProduct = tripProductRows[0];

        // Check available quantity for this trip product using qty_sold
        const currentQtySold = Number(tripProduct.qty_sold || 0);
        const availableQuantity = Number(tripProduct.quantity_ltr) - currentQtySold;
        const requestedFuel = Number(fuel);

        // Validate quantity availability
        if (requestedFuel > availableQuantity) {
            await connection.rollback();
            return res.status(400).json({
                message: `Insufficient quantity available. Available: ${availableQuantity.toFixed(2)} liters, Requested: ${requestedFuel.toFixed(2)} liters`,
                available_quantity: availableQuantity,
                requested_fuel: requestedFuel
            });
        }

        // Validate Qty is not zero
        const qty = Number(Qty) || 0;
        if (qty <= 0) {
            await connection.rollback();
            return res.status(400).json({
                message: 'Quantity (Qty) must be greater than zero'
            });
        }

        // For Mobile/Lube Oil, validate Qty doesn't exceed available
        if (tripProduct.product_type === 'Mobile/Lube Oil') {
            if (container_type === 'Cotton') {
                // For Cotton, Qty is number of cottons
                const availableCottons = Math.floor(availableQuantity / (Number(tripProduct.container_liters) || 1));
                if (qty > availableCottons) {
                    await connection.rollback();
                    return res.status(400).json({
                        message: `Insufficient cottons available. Available: ${availableCottons}, Requested: ${qty}`
                    });
                }
            } else {
                // For non-Cotton container types, only enforce available quantity limits.
                if (qty > availableQuantity) {
                    await connection.rollback();
                    return res.status(400).json({
                        message: `Insufficient quantity available. Available: ${availableQuantity.toFixed(2)} liters, Requested: ${qty.toFixed(2)} liters`
                    });
                }
            }
        }

        // Determine if this sale is for a self customer (petrol pump) so we can route IDs correctly.
        let isSelfCustomer = false;
        if (customer_type_id) {
            const [ctRowsForInsert] = await connection.execute(
                `SELECT type_name FROM customer_types WHERE id = ? AND (active = 1 OR active IS NULL) LIMIT 1`,
                [customer_type_id]
            );
            isSelfCustomer =
                ctRowsForInsert.length > 0 &&
                (ctRowsForInsert[0].type_name || '').toLowerCase() === 'self';
        }

        const saleClientId = isSelfCustomer ? null : client_id;
        const salePumpId = isSelfCustomer ? client_id : null;

        // Insert into pol_sale table with separated customer/pump keys.
        const insertQuery = `
            INSERT INTO pol_sale (
                trip_id, trip_product_id, client_id, pump_id, Qty, container_type, capacity, fuel, rate, 
                Discount, total_amount, date, Active, CD, MD, CB
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW(), ?)
        `;

        // Get CB (Created By) from request body, default to 'System' if not provided
        const CB = resolveAuditUser(req.body, 'System');

        const queryParams = [
            trip_id,
            trip_product_id,
            saleClientId,
            salePumpId,
            qty,
            container_type || null,
            Number(capacity) || null,
            requestedFuel,
            Number(rate),
            Number(Discount) || 0,
            Number(total_amount),
            date,
            CB
        ];

        //console.log('Add Sale - Query parameters:', JSON.stringify(queryParams, null, 2));

        // Insert the sale into pol_sale and capture the insertId
        const [result] = await connection.execute(insertQuery, queryParams);

        console.log('Sale added successfully with ID:', result.insertId);

        // Update trip_products qty_sold (add sold amount to qty_sold)
        const newQtySold = currentQtySold + requestedFuel;
        await connection.execute(
            `UPDATE trip_products 
             SET qty_sold = ?, MD = NOW()
             WHERE id = ? AND active = 1`,
            [newQtySold, trip_product_id]
        );

        // ================================================================
        //  NEW STEP: Deduct from recoveries_advance FIRST (Self/Petrol Pump)
        // ================================================================
        let adv_RecoveryAmount = parseFloat(total_amount);
        let auditUser = resolveAuditUser(req.body, 'System');
        let cust_type = '';
        const customerName = await _getCustomerName(connection, client_id);
        const purpose = `Recovery from ${customerName} from advance balance.`;
        if (customer_type_id) {
            const [ctRowsForInsert] = await connection.execute(
                `SELECT type_name FROM customer_types WHERE id = ? AND (active = 1 OR active IS NULL) LIMIT 1`,
                [customer_type_id]
            );
            if (ctRowsForInsert.length > 0) {
                cust_type = (ctRowsForInsert[0].type_name || '').toLowerCase();
            }

        }
        if (cust_type.toLowerCase() === 'self') {

            const [advanceRows] = await connection.execute(
                `SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS total_advance
                     FROM recoveries_advance
                     WHERE pump_id = ? AND Active = 1
                     AND (ws_customer_id IS NULL OR ws_customer_id = 0)
                     AND (fs_customer_id IS NULL OR fs_customer_id = 0)`,
                [client_id]
            );

            let clientAdvanceBalance = parseFloat(advanceRows[0]?.total_advance || 0);
            let amountDeductedFromAdvance = 0;

            if (clientAdvanceBalance > 0 && adv_RecoveryAmount > 0) {
                if (adv_RecoveryAmount <= clientAdvanceBalance) {
                    // Entire recovery amount is covered by advance balance
                    amountDeductedFromAdvance = adv_RecoveryAmount;
                    const newAdvanceBalance = clientAdvanceBalance - adv_RecoveryAmount;

                    // Insert Debit entry into recoveries_advance
                    await connection.execute(
                        `INSERT INTO recoveries_advance (
                                pump_id,
                                trip_id,
                                entrydate,
                                Debit,
                                Credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?,?, ?, ?, 0, ?, ?, ?, 1)`,
                        [
                            client_id,
                            trip_id,
                            date,
                            amountDeductedFromAdvance,
                            newAdvanceBalance,
                            auditUser,
                            auditUser
                        ]
                    );

                    adv_RecoveryAmount = 0;
                    console.log(`Deducted ${amountDeductedFromAdvance} from recoveries_advance. New Advance Balance: ${newAdvanceBalance}`);
                } else {
                    // Amount is greater than advance balance - empty the advance entirely
                    amountDeductedFromAdvance = clientAdvanceBalance;
                    const newAdvanceBalance = 0;

                    await connection.execute(
                        `INSERT INTO recoveries_advance (
                                pump_id,
                                trip_id,
                                entrydate,
                                Debit,
                                Credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?, ?,?, ?, 0, ?, ?, ?, 1)`,
                        [
                            client_id,
                            trip_id,
                            date,
                            amountDeductedFromAdvance,
                            newAdvanceBalance,
                            auditUser,
                            auditUser
                        ]
                    );

                    adv_RecoveryAmount = adv_RecoveryAmount - clientAdvanceBalance;
                    console.log(`Deducted all recoveries_advance (${amountDeductedFromAdvance}). Remaining: ${adv_RecoveryAmount}`);
                }

                // ================================================================
                //  Add amount from advance_recovery into Cash in Hand 
                // ================================================================

                const [lastBalanceRows] = await connection.execute(`
                           SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
                            FROM cash_in_hand
                            WHERE Active = 1
                        `);

                const currentBalance = lastBalanceRows.length > 0
                    ? parseFloat(lastBalanceRows[0]?.balance || 0)
                    : 0;
                const newBalance = currentBalance + total_amount;

                const cashInHandQuery = `
                            INSERT INTO cash_in_hand (
                                debit,
                                credit,
                                balance,
                                purpose,
                                created_at,
                                CB
                            ) VALUES (0, ?, ?, ?, ?, ?)
                        `;

                const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                    total_amount,
                    newBalance,
                    purpose,
                    date,
                    auditUser
                ]);

                const cashInHandId = cashInHandResult.insertId;

                // Insert into transactions with cash_in_hand_id
                const transactionQuery = `
                            INSERT INTO transactions (
                                cash_in_hand_id,
                                AccountID,
                                Purpose,
                                Debit,
                                Credit,
                                Date,
                                PaymentMode,
                                trip_id,
                                CB,
                                CD,
                                MD,
                                active
                            ) VALUES (?, NULL, ?, 0, ?, ?, 'Cash', ?, ?, NOW(), NOW(), 1)
                        `;

                const [transactionResult] = await connection.execute(transactionQuery, [
                    cashInHandId,
                    purpose,
                    total_amount,
                    date,
                    trip_id,
                    auditUser
                ]);

                transactionID = transactionResult.insertId;
                // Insert into recoveries for previous dues (common for all payment methods)
                const recoveryQuery = `
                        INSERT INTO recoveries (
                            transactionid,
                            clientid,
                            trip_id,
                            amount,
                            payment_head,
                            reference,
                            CD,
                            CB,
                            MD,
                            Active,
                            Date
                        ) VALUES (?, ?, ? , ?, ?, ?, NOW(), ?, NOW(), 1,?)
                        `;

                await connection.execute(recoveryQuery, [
                    transactionID,
                    client_id,
                    trip_id,
                    total_amount,
                    'Cash in Hand',
                    null,
                    auditUser,
                    date
                ]);

                console.log(`Recovery from customer advance balance ${total_amount} recorded in Cash In Hand and recoveries table`);
            }
            // ================================================================
        }
        if (cust_type.toLowerCase() === 'customer') {
            const [advanceRows] = await connection.execute(
                `SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS total_advance
                     FROM recoveries_advance
                     WHERE ws_customer_id = ? AND Active = 1
                     AND (pump_id IS NULL OR pump_id = 0)
                     AND (fs_customer_id IS NULL OR fs_customer_id = 0)`,
                [client_id]
            );

            let clientAdvanceBalance = parseFloat(advanceRows[0]?.total_advance || 0);
            let amountDeductedFromAdvance = 0;

            if (clientAdvanceBalance > 0 && adv_RecoveryAmount > 0) {
                if (adv_RecoveryAmount <= clientAdvanceBalance) {
                    // Entire recovery amount is covered by advance balance
                    amountDeductedFromAdvance = adv_RecoveryAmount;
                    const newAdvanceBalance = clientAdvanceBalance - adv_RecoveryAmount;

                    // Insert Debit entry into recoveries_advance
                    await connection.execute(
                        `INSERT INTO recoveries_advance (
                                ws_customer_id,
                                trip_id,
                                entrydate,
                                Debit,
                                Credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?,?, ?, ?, 0, ?, ?, ?, 1)`,
                        [
                            client_id,
                            trip_id,
                            date,
                            amountDeductedFromAdvance,
                            newAdvanceBalance,
                            auditUser,
                            auditUser
                        ]
                    );

                    adv_RecoveryAmount = 0;
                    console.log(`Deducted ${amountDeductedFromAdvance} from recoveries_advance. New Advance Balance: ${newAdvanceBalance}`);
                } else {
                    // Amount is greater than advance balance - empty the advance entirely
                    amountDeductedFromAdvance = clientAdvanceBalance;
                    const newAdvanceBalance = 0;

                    await connection.execute(
                        `INSERT INTO recoveries_advance (
                                ws_customer_id,
                                trip_id,
                                entrydate,
                                Debit,
                                Credit,
                                balance,
                                CB,
                                MB,
                                Active
                            ) VALUES (?, ?,?, ?, 0, ?, ?, ?, 1)`,
                        [
                            client_id,
                            trip_id,
                            date,
                            amountDeductedFromAdvance,
                            newAdvanceBalance,
                            auditUser,
                            auditUser
                        ]
                    );

                    adv_RecoveryAmount = adv_RecoveryAmount - clientAdvanceBalance;
                    console.log(`Deducted all recoveries_advance (${amountDeductedFromAdvance}). Remaining: ${adv_RecoveryAmount}`);
                }

                // ================================================================
                //  Add amount from advance_recovery intoCash in Hand 
                // ================================================================

                const [lastBalanceRows] = await connection.execute(`
                           SELECT COALESCE(SUM(COALESCE(credit, 0) - COALESCE(debit, 0)), 0) as balance
                            FROM cash_in_hand
                            WHERE Active = 1
                        `);

                const currentBalance = lastBalanceRows.length > 0
                    ? parseFloat(lastBalanceRows[0]?.balance || 0)
                    : 0;
                const newBalance = currentBalance + total_amount;

                const cashInHandQuery = `
                            INSERT INTO cash_in_hand (
                                debit,
                                credit,
                                balance,
                                purpose,
                                created_at,
                                CB
                            ) VALUES (0, ?, ?, ?, ?, ?)
                        `;

                const [cashInHandResult] = await connection.execute(cashInHandQuery, [
                    total_amount,
                    newBalance,
                    purpose,
                    date,
                    auditUser
                ]);

                const cashInHandId = cashInHandResult.insertId;

                // Insert into transactions with cash_in_hand_id
                const transactionQuery = `
                            INSERT INTO transactions (
                                cash_in_hand_id,
                                AccountID,
                                Purpose,
                                Debit,
                                Credit,
                                Date,
                                PaymentMode,
                                trip_id,
                                CB,
                                CD,
                                MD,
                                active
                            ) VALUES (?, NULL, ?, 0, ?, ?, 'Cash', ?, ?, NOW(), NOW(), 1)
                        `;

                const [transactionResult] = await connection.execute(transactionQuery, [
                    cashInHandId,
                    purpose,
                    total_amount,
                    date,
                    trip_id,
                    auditUser
                ]);

                transactionID = transactionResult.insertId;
                // Insert into recoveries for previous dues (common for all payment methods)
                const recoveryQuery = `
                        INSERT INTO recoveries (
                            transactionid,
                            clientid,
                            trip_id,
                            amount,
                            payment_head,
                            reference,
                            CD,
                            CB,
                            MD,
                            Active,
                            Date
                        ) VALUES (?, ?, ? , ?, ?, ?, NOW(), ?, NOW(), 1,?)
                        `;

                await connection.execute(recoveryQuery, [
                    transactionID,
                    client_id,
                    trip_id,
                    total_amount,
                    'Cash in Hand',
                    null,
                    auditUser,
                    date
                ]);

                console.log(`Recovery from customer advance balance ${total_amount} recorded in Cash In Hand and recoveries table`);
            }
            // ================================================================
        }

        // When customer type is Self: receive stock into tank and track it in daily_tank_inventory
        try {
            let isSelf = isSelfCustomer;
            if (isSelf) {
                const pump_id = client_id;
                console.log(`[Tank Stock] Self sale: pump_id=${pump_id}, fuel=${requestedFuel}L`);

                const [[tripRow]] = await connection.execute(
                    `SELECT trip_no FROM trips WHERE id = ? LIMIT 1`,
                    [trip_id]
                );
                const tripReference = tripRow?.trip_no ? `Trip#${tripRow.trip_no}` : `Trip#${trip_id}`;

                const [fuelProductRows] = await connection.execute(
                    `SELECT product_type FROM trip_products WHERE id = ? AND active = 1`,
                    [trip_product_id]
                );
                if (fuelProductRows.length === 0) {
                    console.log(`[Tank Stock]  Trip product ${trip_product_id} not found`);
                } else {
                    const product_type = fuelProductRows[0].product_type;

                    // For Self customer mobile oil sales, keep purchase-side tracking in mobile_oil_purchase.
                    if ((product_type || '').toLowerCase() === 'mobile/lube oil') {
                        const normalizedContainerType = String(container_type || '').trim().toLowerCase();
                        const purchaseContainerType = ['carton', 'cotton', 'can', 'drum', 'dew'].includes(normalizedContainerType)
                            ? normalizedContainerType
                            : null;
                        // Prefer payload values; fallback to trip product container metadata for all container types.
                        const fallbackContainerLiters = Number(tripProduct.container_liters) || null;
                        const purchaseContainerLiters = Number(capacity) || fallbackContainerLiters || null;

                        let purchaseNoOfContainers = Number(no_of_containers) || null;
                        if (!purchaseNoOfContainers && purchaseContainerType) {
                            if (purchaseContainerType === 'carton' || purchaseContainerType === 'cotton') {
                                purchaseNoOfContainers = Number(qty) || null;
                            } else if (purchaseContainerLiters && purchaseContainerLiters > 0) {
                                purchaseNoOfContainers = Number((requestedFuel / purchaseContainerLiters).toFixed(3));
                            }
                        }

                        await connection.execute(
                            `INSERT INTO mobile_oil_purchase
                                (pump_id, liters_purchased, rate_per_liter, total_amount, container_type, container_liters, no_of_containers, cd, md, cb, mb, active)
                             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
                            [
                                pump_id,
                                requestedFuel,
                                Number(rate),
                                Number(total_amount),
                                purchaseContainerType,
                                purchaseContainerLiters,
                                purchaseNoOfContainers,
                                CB,
                                CB
                            ]
                        );
                    }

                    let fuelTypeName = product_type;
                    if (product_type === 'Mobile/Lube Oil') fuelTypeName = 'Mobile Oil';
                    if (product_type === 'PMG') fuelTypeName = 'Petrol';
                    if (product_type === 'HSD') fuelTypeName = 'Diesel';

                    // Track self-customer fuel movement in fuel_purchased ledger.
                    await connection.execute(
                        `INSERT INTO fuel_purchased
                            (fuel_type, purchase_reference, liters_purchased, CB, MB, Active)
                         VALUES (?, ?, ?, ?, ?, 1)`,
                        [
                            String(fuelTypeName || product_type || '').trim() || 'Unknown',
                            tripReference,
                            requestedFuel,
                            CB,
                            CB
                        ]
                    );

                    const normalizedFuelType = String(fuelTypeName || '').trim().toLowerCase();
                    let fuelAliases = [normalizedFuelType];
                    if (normalizedFuelType === 'petrol') fuelAliases = ['petrol', 'pmg', 'ms'];
                    if (normalizedFuelType === 'diesel') fuelAliases = ['diesel', 'hsd'];
                    if (normalizedFuelType === 'mobile oil') fuelAliases = ['mobile oil', 'mobile/lube oil', 'lube oil'];

                    const aliasPlaceholders = fuelAliases.map(() => '?').join(',');
                    const [tankRows] = await connection.execute(
                        `SELECT id, pump_id, fuel_type, capacity, current_level 
                         FROM fuel_tanks 
                         WHERE pump_id = ?
                           AND LOWER(TRIM(fuel_type)) IN (${aliasPlaceholders})
                           AND (Active = 1 OR Active IS NULL)
                         ORDER BY CASE WHEN LOWER(TRIM(fuel_type)) = ? THEN 0 ELSE 1 END, id ASC
                         LIMIT 1 FOR UPDATE`,
                        [pump_id, ...fuelAliases, normalizedFuelType]
                    );
                    if (tankRows.length === 0) {
                        throw new Error(`[Tank Stock] No fuel_tank found for pump_id=${pump_id}, fuel_type=${fuelTypeName}`);
                    } else {
                        const tank = tankRows[0];
                        const tank_id = tank.id;
                        const opening_level = parseFloat(tank.current_level || 0);
                        const closing_level = opening_level + requestedFuel;
                        const capacityVal = parseFloat(tank.capacity || 0);
                        /*  if (capacityVal > 0 && closing_level > capacityVal) {
                             throw new Error(`[Tank Stock] Tank capacity exceeded: ${closing_level}L > ${capacityVal}L`);
                         } else { */
                        const [tankUpdateResult] = await connection.execute(
                            `UPDATE fuel_tanks
                                 SET current_level = ?, MB = ?, MD = NOW()
                                 WHERE id = ? AND pump_id = ? AND (Active = 1 OR Active IS NULL)`,
                            [closing_level, CB, tank_id, pump_id]
                        );
                        if (!tankUpdateResult || tankUpdateResult.affectedRows === 0) {
                            // Instead of throwing, return error message to frontend
                            await connection.rollback();
                            return res.status(400).json({
                                message: `[Tank Stock] Failed to update fuel_tanks for pump_id=${pump_id}, tank_id=${tank_id}`
                            });
                        }
                        //No need to add row in daily_sales_entries and daily_tank_inventory for self-customer fuel purchase as it's not a sale, but we can log the stock update for traceability.
                        /* console.log(`[Tank Stock] ✓ fuel_tanks.current_level updated: ${opening_level}L + ${requestedFuel}L = ${closing_level}L`);

                        const saleDate = date || new Date().toISOString().split('T')[0];
                        let dailyEntryId;
                        const [dseRows] = await connection.execute(
                            `SELECT id FROM daily_sales_entries WHERE pump_id = ? AND entry_date = ? LIMIT 1`,
                            [pump_id, saleDate]
                        );
                        if (dseRows.length > 0) {
                            dailyEntryId = dseRows[0].id;
                        } else {
                            const [dseIns] = await connection.execute(
                                `INSERT INTO daily_sales_entries (pump_id, entry_date, status, submitted_at, CB, MB, cd, md, Active)
                                 VALUES (?, ?, 'submitted', NOW(), ?, ?, NOW(), NOW(), 1)`,
                                [pump_id, saleDate, CB, CB]
                            );
                            dailyEntryId = dseIns.insertId;
                        }

                        const [[existingInventory]] = await connection.execute(
                            `SELECT id, received_quantity, purchase_reference
                             FROM daily_tank_inventory
                             WHERE daily_entry_id = ? AND tank_id = ? AND (Active = 1 OR Active IS NULL)
                             LIMIT 1`,
                            [dailyEntryId, tank_id]
                        );

                        if (existingInventory && existingInventory.id) {
                            const currentReceived = parseFloat(existingInventory.received_quantity || 0);
                            const nextReceived = currentReceived + requestedFuel;
                            const prevRef = String(existingInventory.purchase_reference || '').trim();
                            const nextRef = prevRef
                                ? (prevRef.includes(tripReference) ? prevRef : `${prevRef}, ${tripReference}`)
                                : tripReference;

                            await connection.execute(
                                `UPDATE daily_tank_inventory
                                 SET received_quantity = ?,
                                     purchase_reference = ?,
                                     MB = ?,
                                     md = NOW()
                                 WHERE id = ?`,
                                [nextReceived, nextRef, CB, existingInventory.id]
                            );
                            console.log(`[Tank Stock] ✓ daily_tank_inventory updated: received_quantity=${nextReceived}, purchase_reference=${nextRef}`);
                        } else {
                            await connection.execute(
                                `INSERT INTO daily_tank_inventory (daily_entry_id, tank_id, opening_level, closing_level, received_quantity, sold_quantity, purchase_reference, cd, md, CB, MB, Active)
                                 VALUES (?, ?, ?, ?, ?, 0, ?, NOW(), NOW(), ?, ?, 1)`,
                                [dailyEntryId, tank_id, null, null, requestedFuel, tripReference, CB, CB]
                            );
                            console.log(`[Tank Stock] ✓ daily_tank_inventory created, purchase_reference=${tripReference}`);
                        } */
                        //}
                    }
                }
            }
        } catch (tankStockError) {
            console.error('[Tank Stock] ✗ ERROR:', tankStockError);
            throw tankStockError;
        }

        // Check if trip should be closed (all payments cleared and all fuel sold)
        const tripCloseResult = await checkAndCloseTrip(connection, trip_id);
        if (!tripCloseResult) {
            console.warn(`[Trip Status Warning] Trip ${trip_id} could not be evaluated/closed. Financial transaction will continue.`);
        }

        await connection.commit();

        res.json({
            message: 'Sale added successfully',
            id: result.insertId
        });
    } catch (err) {
        await connection.rollback();
        console.error('Error adding sale:', err);
        console.error('Error details:', {
            code: err.code,
            sqlMessage: err.sqlMessage,
            sqlState: err.sqlState,
            errno: err.errno
        });
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({
                message: 'pol_sale table does not exist. Please create the table first.',
                error: err.message,
                sqlMessage: err.sqlMessage
            });
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message,
                sqlMessage: err.sqlMessage,
                code: err.code
            });
        }
    } finally {
        connection.release();
    }
};

async function _getCustomerName(connection, clientId) {
    try {
        const [rows] = await connection.execute(
            'SELECT name FROM customers WHERE id = ?',
            [clientId]
        );
        return rows.length > 0 ? (rows[0].name || `Customer ${clientId}`) : `Customer ${clientId}`;
    } catch (err) {
        console.error('Error fetching customer name:', err);
        return `Customer ${clientId}`;
    }
}
async function _getPumpName(connection, clientId) {
    try {
        const [rows] = await connection.execute(
            'SELECT name FROM petrol_pumps WHERE id = ?',
            [clientId]
        );
        return rows.length > 0 ? (rows[0].name || `Pump ${clientId}`) : `Pump ${clientId}`;
    } catch (err) {
        console.error('Error fetching petrol pump name:', err);
        return `Pump ${clientId}`;
    }
}
// Get fuel_purchased rows for selected pump with unload progress.
exports.getFuelPurchasedForUnload = async (req, res) => {
    try {
        const pumpId = Number(req.query.pump_id || 0);
        if (!pumpId) {
            return res.status(400).json({ message: 'pump_id is required' });
        }

        const [rows] = await db.execute(
            `
   
SELECT
    fp.id,
     fp.fuel_type COLLATE utf8mb4_unicode_ci AS fuel_type,
    fp.purchase_reference,
    fp.liters_purchased,
    COALESCE(fu.total_unloaded, 0) AS liters_unloaded,
    GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) AS liters_remaining
FROM fuel_purchased fp
LEFT JOIN (
    SELECT fuel_purchase_id, COALESCE(SUM(liters_unloaded), 0) AS total_unloaded
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
        AND ps.pump_id = ?
  )

UNION ALL

-- Credit sales (now with proper unload calculation)
SELECT
    fp.id,
  cs.fuel_type COLLATE utf8mb4_unicode_ci AS fuel_type,
    fp.purchase_reference,
    fp.liters_purchased AS liters_purchased,
    COALESCE(fu.total_unloaded, 0) AS liters_unloaded,
    GREATEST(COALESCE(fp.liters_purchased, 0) - COALESCE(fu.total_unloaded, 0), 0) AS liters_remaining
FROM credit_sales cs
INNER JOIN fuel_purchased fp ON fp.id = cs.fuel_purchased_id
LEFT JOIN (
    SELECT fuel_purchase_id, COALESCE(SUM(liters_unloaded), 0) AS total_unloaded
    FROM fuel_unload
    WHERE Active = 1
    GROUP BY fuel_purchase_id
) fu ON fu.fuel_purchase_id = fp.id
WHERE cs.Active = 1
  AND cs.ws_customer_id = ?
  AND fp.Active = 1

ORDER BY id DESC`,
            [pumpId, pumpId]
        );

        return res.json(rows || []);
    } catch (err) {
        console.error('Error fetching fuel purchased for unload:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Unload fuel into selected tank and update stock level.
exports.unloadFuelToTank = async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const fuelPurchaseId = Number(req.body?.fuel_purchase_id || 0);
        const fuelTankId = Number(req.body?.fuel_tank_id || 0);
        const pumpId = Number(req.body?.pump_id || 0);
        const litersUnloaded = Number(req.body?.liters_unloaded || 0);
        const auditUser = resolveAuditUser(req.body, 'System');

        console.log('fuel purchased id' + fuelPurchaseId);


        if (!fuelPurchaseId || !fuelTankId || !pumpId || !(litersUnloaded > 0)) {
            await connection.rollback();
            return res.status(400).json({ message: 'fuel_purchase_id, fuel_tank_id, pump_id and liters_unloaded (> 0) are required' });
        }

        const [[purchaseRow]] = await connection.execute(
            `SELECT id, fuel_type, liters_purchased
             FROM fuel_purchased
             WHERE id = ? AND Active = 1
             LIMIT 1`,
            [fuelPurchaseId]
        );

        if (!purchaseRow) {
            await connection.rollback();
            return res.status(404).json({ message: 'fuel_purchased entry not found' });
        }

        const [[unloadedRow]] = await connection.execute(
            `SELECT COALESCE(SUM(liters_unloaded), 0) AS total_unloaded
             FROM fuel_unload
             WHERE fuel_purchase_id = ? AND Active = 1`,
            [fuelPurchaseId]
        );

        const litersPurchased = Number(purchaseRow.liters_purchased || 0);
        const totalUnloaded = Number(unloadedRow?.total_unloaded || 0);
        const remaining = Math.max(0, litersPurchased - totalUnloaded);

        if (litersUnloaded > remaining) {
            await connection.rollback();
            return res.status(400).json({ message: `Cannot unload ${litersUnloaded}L. Remaining is ${remaining.toFixed(2)}L` });
        }

        const [[tankRow]] = await connection.execute(
            `SELECT id, pump_id, fuel_type, current_level
             FROM fuel_tanks
             WHERE id = ? AND pump_id = ? AND (Active = 1 OR Active IS NULL)
             LIMIT 1 FOR UPDATE`,
            [fuelTankId, pumpId]
        );

        if (!tankRow) {
            await connection.rollback();
            return res.status(404).json({ message: 'Fuel tank not found for selected pump' });
        }

        const normalizeFuel = (value) => String(value || '').trim().toLowerCase();
        const purchaseFuel = normalizeFuel(purchaseRow.fuel_type);
        const tankFuel = normalizeFuel(tankRow.fuel_type);

        const fuelMatches = (
            (purchaseFuel.includes('petrol') && (tankFuel.includes('petrol') || tankFuel === 'pmg' || tankFuel === 'ms')) ||
            (purchaseFuel.includes('diesel') && (tankFuel.includes('diesel') || tankFuel === 'hsd')) ||
            (purchaseFuel.includes('mobile') && (tankFuel.includes('mobile') || tankFuel.includes('oil') || tankFuel.includes('lube')))
        );

        if (!fuelMatches) {
            await connection.rollback();
            return res.status(400).json({ message: `Selected tank fuel type (${tankRow.fuel_type}) does not match purchased fuel (${purchaseRow.fuel_type})` });
        }

        await connection.execute(
            `INSERT INTO fuel_unload (fuel_purchase_id, fuel_tank_id, liters_unloaded, CB, MB, Active)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [fuelPurchaseId, fuelTankId, litersUnloaded, auditUser, auditUser]
        );

        const currentLevel = Number(tankRow.current_level || 0);
        const nextLevel = currentLevel + litersUnloaded;

        await connection.execute(
            `UPDATE fuel_tanks
             SET current_level = ?, MB = ?, MD = NOW()
             WHERE id = ? AND pump_id = ?`,
            [nextLevel, auditUser, fuelTankId, pumpId]
        );

        await connection.commit();
        return res.json({
            success: true,
            message: 'Fuel unloaded successfully',
            liters_unloaded: litersUnloaded,
            tank_current_level: nextLevel,
            liters_remaining: Math.max(0, remaining - litersUnloaded)
        });
    } catch (err) {
        await connection.rollback();
        console.error('Error unloading fuel to tank:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    } finally {
        connection.release();
    }
};

// Get today's POL sales (all customers sold fuel today)
/* exports.getTodayPolSales = async (req, res) => {
    try {
        const query = `
            SELECT 
                ps.id,
                ps.trip_id,
                ps.trip_product_id,
                ps.client_id,
                ps.Qty,
                ps.capacity,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.date,
                ps.container_type,
                c.name as client_name,
                pp.name as petrol_pump_name,
                t.trip_no,
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
            LEFT JOIN petrol_pumps pp ON ps.client_id = pp.id AND pp.active = 1
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            WHERE ps.Active = 1
            ORDER BY ps.date DESC, ps.id DESC
        `;

        const [rows] = await db.execute(query);
        console.log('Fetched today\'s POL sales:', rows[0]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching today\'s POL sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message
            });
        }
    }
}; */

// Get trip distribution (clients who received fuel from this trip)
exports.getTripDistribution = async (req, res) => {
    try {
        const trip_id = req.query.trip_id;

        if (!trip_id) {
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        const query = `
            SELECT
                ps.id,
                ps.trip_id,
                ps.trip_product_id,
                ps.client_id,
                pp.id,
                ps.Qty,
                ps.capacity,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.date,
                ps.container_type,
                c.name as client_name,
                 pp.name as Pump_name,
                td.depo_id,
                d.name as depo_name
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
             LEFT JOIN petrol_pumps pp ON ps.pump_id = pp.id AND pp.active = 1
            LEFT JOIN trip_depos td ON ps.trip_id = td.trip_id
                AND ps.trip_product_id = td.product_id
                AND td.Active = 1
            LEFT JOIN depo d ON td.depo_id = d.id AND d.active = 1
            WHERE ps.trip_id = ? AND ps.Active = 1
            ORDER BY ps.date DESC, ps.id DESC
        `;

        const [rows] = await db.execute(query, [trip_id]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching trip distribution:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message
            });
        }
    }
};

// Get today's POL sales (all customers sold fuel today)
exports.getTodayPolSales = async (req, res) => {
    try {
        const query = `
            SELECT 
                ps.id,
                ps.trip_id,
                ps.trip_product_id,
                ps.client_id,
                ps.Qty,
                ps.capacity,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.date,
                ps.container_type,
                c.name as client_name,
                t.trip_no,
                tp.product_type as fuel_type,
                pp.name as petrol_pump_name
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
            LEFT JOIN trips t ON ps.trip_id = t.id AND t.active = 1
            LEFT JOIN trip_products tp ON ps.trip_product_id = tp.id AND tp.Active = 1
            LEFT JOIN petrol_pumps pp ON COALESCE(ps.pump_id, ps.client_id) = pp.id AND pp.active = 1
            WHERE ps.Active = 1
            ORDER BY ps.date DESC, ps.id DESC
        `;

        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching today\'s POL sales:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({
                message: 'Server Error',
                error: err.message
            });
        }
    }
};

