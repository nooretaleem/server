const db = require('../models/db');

function resolveAuditUser(req) {
    const b = req.body || {};
    return b.MB || b.CB || b.userName || b.username || b.UserName || b.createdBy || b.modifiedBy || 'System';
}

// Get all depos (only active ones)
exports.getDepos_old = async (req, res) => {
    try {
        const query = `
            SELECT 
                d.id,
                d.name,
                d.code,
                d.phone_no,
                d.address,
                d.Balance,
                d.previous_payables,
                (
                    SELECT COALESCE(ab.Balance, 0)
                    FROM advance_balance ab
                    WHERE ab.DepoID = d.id AND ab.Active = 1
                    ORDER BY ab.ID DESC
                    LIMIT 1
                ) as advance_balance,
                d.CD,
                d.CB,
                d.MD,
                d.active,
                dc.company_id,
                c.name as company_name
            FROM depo d
            LEFT JOIN depo_company dc ON d.id = dc.depo_id AND dc.active = 1
            LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
            WHERE d.active = 1
            ORDER BY d.name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching depos:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            // If depo_company table doesn't exist, try without join
            try {
                const fallbackQuery = `
                    SELECT 
                        id,
                        name,
                        code,
                        phone_no,
                        address,
                        Balance,
                        (
                            SELECT COALESCE(ab.Balance, 0)
                            FROM advance_balance ab
                            WHERE ab.DepoID = depo.id AND ab.Active = 1
                            ORDER BY ab.ID DESC
                            LIMIT 1
                        ) as advance_balance,
                        CD,
                        CB,
                        MD,
                        active,
                        NULL as company_id,
                        NULL as company_name
                    FROM depo
                    WHERE active = 1
                    ORDER BY name
                `;
                const [fallbackRows] = await db.execute(fallbackQuery);
                res.json(fallbackRows);
            } catch (fallbackErr) {
                res.status(500).json({ message: 'Server Error', error: err.message });
            }
        }
    }
};

exports.getDepos = async (req, res) => {
    let connection;

    try {
        connection = await db.getConnection();

        /* const query = `
      SELECT 
        d.id,
        d.name,
        d.code,
        d.phone_no,
        d.address,
        d.Balance,
        d.special_credit_limit,
        d.previous_payables,
        (
          SELECT COALESCE(ab.Balance, 0)
          FROM advance_balance ab
          WHERE ab.DepoID = d.id AND ab.Active = 1
          ORDER BY ab.ID DESC
          LIMIT 1
        ) as advance_balance,
        d.CD,
        d.CB,
        d.MD,
        d.active,
        dc.company_id,
        c.name as company_name
      FROM depo d
      LEFT JOIN depo_company dc ON d.id = dc.depo_id AND dc.active = 1
      LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
      WHERE d.active = 1
      ORDER BY d.name
    `; */

        const query = `
      SELECT 
        d.id,
        d.name,
        d.code,
        d.phone_no,
        d.address,
        d.Balance,
        d.special_credit_limit,
        d.previous_payables,
        (
          SELECT COALESCE(ab.Balance, 0)
          FROM advance_balance ab
          WHERE ab.DepoID = d.id AND ab.Active = 1
          ORDER BY ab.ID DESC
          LIMIT 1
        ) as advance_balance,
        -- ✅ Add Trip Payables (remaining amount from trip_depos)
        COALESCE((
          SELECT SUM(td.payable_amount - COALESCE(td.paid_amount, 0))
          FROM trip_depos td
          INNER JOIN trips t ON td.trip_id = t.id AND t.active = 1
          WHERE td.depo_id = d.id 
            AND td.Active = 1 
            AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
            AND td.purchase_type != 'cash'
        ), 0) as trip_payables,
        -- ✅ Total Payables = previous_payables + trip_payables
        COALESCE(d.previous_payables, 0) + COALESCE((
          SELECT SUM(td.payable_amount - COALESCE(td.paid_amount, 0))
          FROM trip_depos td
          INNER JOIN trips t ON td.trip_id = t.id AND t.active = 1
          WHERE td.depo_id = d.id 
            AND td.Active = 1 
            AND (td.payable_amount - COALESCE(td.paid_amount, 0)) > 0
            AND td.purchase_type != 'cash'
        ), 0) as total_payables,
        d.CD,
        d.CB,
        d.MD,
        d.active,
        dc.company_id,
        c.name as company_name
      FROM depo d
      LEFT JOIN depo_company dc ON d.id = dc.depo_id AND dc.active = 1
      LEFT JOIN company c ON c.id = dc.company_id AND c.active = 1
      WHERE d.active = 1
      ORDER BY d.name
    `;
        const [rows] = await connection.execute(query);
        return res.status(200).json(rows);

    } catch (err) {
        console.error('Error fetching depos:', err);

        // If table doesn't exist, return empty array
        if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.status(200).json([]);
        }

        // If depo_company table doesn't exist, try fallback query
        /*   if (err.code === 'ER_NO_SUCH_TABLE' && err.sqlMessage.includes('depo_company')) {
              try {
                  // ✅ Use the same connection for fallback
                  const fallbackQuery = `
            SELECT 
              id,
              name,
              code,
              phone_no,
              address,
              Balance,
              (
                SELECT COALESCE(ab.Balance, 0)
                FROM advance_balance ab
                WHERE ab.DepoID = depo.id AND ab.Active = 1
                ORDER BY ab.ID DESC
                LIMIT 1
              ) as advance_balance,
              CD,
              CB,
              MD,
              active,
              NULL as company_id,
              NULL as company_name
            FROM depo
            WHERE active = 1
            ORDER BY name
          `;
                  const [fallbackRows] = await connection.execute(fallbackQuery);
                  return res.status(200).json(fallbackRows);
              } catch (fallbackErr) {
                  console.error('Error in fallback query:', fallbackErr);
                  return res.status(500).json({
                      message: 'Server Error',
                      error: process.env.NODE_ENV === 'development' ? fallbackErr.message : undefined
                  });
              }
          } */

        return res.status(500).json({
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
// Get active depos for a specific company using depo_company mapping
exports.getDeposByCompany = async (req, res) => {
    try {
        const companyId = Number(req.query.company_id || 0);
        if (!companyId) {
            return res.status(400).json({ message: 'Company ID is required' });
        }

        const query = `
            SELECT
                d.id,
                d.name,
                d.code,
                d.phone_no,
                d.address,
                d.Balance,
                d.previous_payables,
                (
                    SELECT COALESCE(ab.Balance, 0)
                    FROM advance_balance ab
                    WHERE ab.DepoID = d.id AND ab.Active = 1
                    ORDER BY ab.ID DESC
                    LIMIT 1
                ) as advance_balance,
                d.CD,
                d.CB,
                d.MD,
                d.active,
                dc.company_id,
                c.name as company_name
            FROM depo_company dc
            INNER JOIN depo d ON d.id = dc.depo_id AND d.active = 1
            INNER JOIN company c ON c.id = dc.company_id AND c.active = 1
            WHERE dc.active = 1 AND dc.company_id = ?
            ORDER BY d.name
        `;

        const [rows] = await db.execute(query, [companyId]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching depos by company:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get single depo by ID
exports.getDepo = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        const query = `
            SELECT 
                d.*,
                d.previous_payables,
                dc.company_id
            FROM depo d
            LEFT JOIN depo_company dc ON d.id = dc.depo_id AND dc.active = 1
            WHERE d.id = ? AND d.active = 1
        `;
        const [rows] = await db.execute(query, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Depo not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching depo:', err);
        // If depo_company table doesn't exist, try without join
        try {
            const fallbackQuery = 'SELECT *, NULL as company_id FROM depo WHERE id = ? AND active = 1';
            const [fallbackRows] = await db.execute(fallbackQuery, [id]);
            if (fallbackRows.length === 0) {
                return res.status(404).json({ message: 'Depo not found' });
            }
            res.json(fallbackRows[0]);
        } catch (fallbackErr) {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Add new depo
exports.addDepo = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            name,
            code,
            phone_no,
            address,
            Balance,
            specialcreditlimit,
            previous_payables,
            company_id
        } = req.body;

        if (!name) {
            connection.release();
            return res.status(400).json({ message: 'Depo name is required' });
        }

        // Validate phone number if provided (should be numeric and minimum 11 digits)
        if (phone_no && (!/^[0-9]{11,}$/.test(phone_no))) {
            connection.release();
            return res.status(400).json({ message: 'Phone number must be numeric and at least 11 digits' });
        }
        // Validate code if provided (should be alpha numeric and minimum 4 characters)
        if (code && (!/^[a-zA-Z0-9]{4,}$/.test(code))) {
            connection.release();
            return res.status(400).json({ message: 'Depo Code must be alphanumeric and at least 4 characters' });
        }

        // Check if a dealer with the same name already exists for the same company
        if (company_id) {
            const checkDuplicateQuery = `
                SELECT d.id 
                FROM depo d
                INNER JOIN depo_company dc ON d.id = dc.depo_id AND dc.active = 1
                WHERE LOWER(TRIM(d.name)) = LOWER(TRIM(?)) 
                AND dc.company_id = ? 
                AND d.active = 1
            `;
            const [existingDealers] = await connection.execute(checkDuplicateQuery, [name, company_id]);

            if (existingDealers.length > 0) {
                connection.release();
                return res.status(400).json({
                    message: `A dealer with the name "${name}" already exists for this company. Please use a different name.`
                });
            }
        }

        // Get CB (Created By) from logged-in user
        const CB = resolveAuditUser(req);

        const balanceAmount = parseFloat(Balance) || 0;

        const _specialcreditlimit = parseFloat(specialcreditlimit) || 0;

        await connection.beginTransaction();

        // Get previous_payables, default to 0 if not provided
        const previousPayables = parseFloat(previous_payables || 0) || 0;

        // Insert into depo table with CB, MB, CD, MD, active
        const depoQuery = `
            INSERT INTO depo (name, code,phone_no, address, Balance, special_credit_limit, previous_payables, CB, MB, CD, MD, active) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
        `;

        const [depoResult] = await connection.execute(depoQuery, [
            name,
            code || null,
            phone_no || null,
            address || null,
            balanceAmount,
            _specialcreditlimit,
            previousPayables,
            CB,
            CB
        ]);

        const depoId = depoResult.insertId;

        // Insert into depo_company table if company_id is provided
        if (company_id) {
            try {
                const depoCompanyQuery = `
                    INSERT INTO depo_company (depo_id, company_id, CD, CB, MB, MD, active) 
                    VALUES (?, ?, NOW(), ?, ?, NOW(), 1)
                `;
                await connection.execute(depoCompanyQuery, [depoId, company_id, CB, CB]);
                console.log(`Depo-Company relationship created: depo_id=${depoId}, company_id=${company_id}`);
            } catch (err) {
                // If depo_company table doesn't exist or error, log but don't fail
                console.log('Note: Could not insert into depo_company:', err.message);
            }
        }

        // Insert into pool table with Credit value, TripID, payment_id and recovery_id as NULL
        if (balanceAmount > 0) {
            const poolQuery = `
                INSERT INTO pool (DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CD, CB, MB, MD, active) 
                VALUES (?, NULL, 0, ?, ?, NULL, NULL, NOW(), ?, ?, NOW(), 1)
            `;

            await connection.execute(poolQuery, [
                depoId,
                balanceAmount,
                balanceAmount,
                CB,
                CB
            ]);

            console.log(`Pool record created for new depo ${depoId}: Credit=${balanceAmount}, DepoLimit=${balanceAmount}`);
        }

        // Insert into special credit limit table with Credit value, TripID, payment_id and recovery_id as NULL
        if (_specialcreditlimit > 0) {
            const spclQuery = `
                INSERT INTO special_credit_limit (DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CD, CB, MB, MD, active)
                VALUES (?, NULL, 0, ?, ?, NULL, NULL, NOW(), ?, ?, NOW(), 1)
            `;

            await connection.execute(spclQuery, [
                depoId,
                _specialcreditlimit,
                _specialcreditlimit,
                CB,
                CB
            ]);

            console.log(`Special Credit Limit record created for new depo ${depoId}: Credit=${balanceAmount}, DepoLimit=${_specialcreditlimit}`);
        }

        await connection.commit();
        connection.release();

        res.json({
            message: 'Depo added successfully',
            id: depoId
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error adding depo:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'depo table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update depo
exports._updateDepo = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            id,
            name,
            code,
            phone_no,
            address,
            Balance,
            specialcreditlimit,
            previous_payables,
            company_id
        } = req.body;

        const MB = resolveAuditUser(req);

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Depo ID is required' });
        }
        if (!name) {
            connection.release();
            return res.status(400).json({ message: 'Depo name is required' });
        }

        // Validate code if provided (should be alphanumeric and minimum 4 characters)
        if (code !== undefined && code !== null && code !== '' && (!/^[a-zA-Z0-9]{4,}$/.test(code))) {
            connection.release();
            return res.status(400).json({ message: 'Depo Code must be alphanumeric and at least 4 characters' });
        }

        // Validate phone number if provided (should be numeric and minimum 11 digits)
        if (phone_no && (!/^[0-9]{11,}$/.test(phone_no))) {
            connection.release();
            return res.status(400).json({ message: 'Phone number must be numeric and at least 11 digits' });
        }

        // Check if a dealer with the same name already exists for the same company (excluding current dealer)
        if (company_id) {
            const checkDuplicateQuery = `
                SELECT d.id 
                FROM depo d
                INNER JOIN depo_company dc ON d.id = dc.depo_id AND dc.active = 1
                WHERE LOWER(TRIM(d.name)) = LOWER(TRIM(?)) 
                AND dc.company_id = ? 
                AND d.id != ?
                AND d.active = 1
            `;
            const [existingDealers] = await connection.execute(checkDuplicateQuery, [name, company_id, id]);

            if (existingDealers.length > 0) {
                connection.release();
                return res.status(400).json({
                    message: `A dealer with the name "${name}" already exists for this company. Please use a different name.`
                });
            }
        }

        // Check if depo is used in trips by checking trip_depos table with active=1
        let isDepoUsedInTrips = false;
        try {
            const [tripDeposRows] = await connection.execute('SELECT COUNT(*) as count FROM trip_depos WHERE depo_id = ? AND Active = 1', [id]);
            isDepoUsedInTrips = (tripDeposRows[0]?.count || 0) > 0;
        } catch (err) {
            console.log('trip_depos table check skipped:', err.message);
        }

        // Get current balance from database
        const [currentDepoRows] = await connection.execute('SELECT Balance,special_credit_limit FROM depo WHERE id = ?', [id]);
        if (currentDepoRows.length === 0) {
            connection.release();
            return res.status(404).json({ message: 'Depo not found' });
        }
        const currentBalance = parseFloat(currentDepoRows[0].Balance || 0);
        const requestedBalance = parseFloat(Balance) || 0;
        const currentspcreditBalance = parseFloat(currentDepoRows[0].special_credit_limit || 0);
        const requestedSpecialCreditLimit = parseFloat(specialcreditlimit) || 0;

        // If depo is used in trips, don't allow balance edit
        if (isDepoUsedInTrips && currentBalance !== requestedBalance) {
            connection.release();
            return res.status(400).json({
                message: 'Balance cannot be edited. This depo is currently used in trip(s). Other information can be edited.'
            });
        }

        await connection.beginTransaction();

        // Only update balance and pool if depo is NOT used in trips
        if (!isDepoUsedInTrips) {
            const balanceAmount = requestedBalance;
            const spcreditlimit = requestedSpecialCreditLimit;
            // Step 1: Get the initial balance row from pool table where payment_id IS NULL, recovery_id IS NULL, AND TripID IS NULL
            const [initialBalanceRows] = await connection.execute(
                `SELECT ID, DepoLimit FROM pool 
                 WHERE DepoID = ? AND payment_id IS NULL AND recovery_id IS NULL AND TripID IS NULL AND active = 1 
                 ORDER BY ID ASC LIMIT 1`,
                [id]
            );

            let initialBalanceRowId = null;

            if (initialBalanceRows.length > 0) {
                initialBalanceRowId = initialBalanceRows[0].ID;
                console.log(`Found initial balance row for depo ${id}: ID=${initialBalanceRowId}`);

                // Update the initial balance row's DepoLimit with UI value
                await connection.execute(
                    `UPDATE pool SET DepoLimit = ?, Credit = ?, MB = ?, MD = NOW() WHERE ID = ?`,
                    [balanceAmount, balanceAmount, MB, initialBalanceRowId]
                );
                console.log(`Updated initial balance row ${initialBalanceRowId} DepoLimit to ${balanceAmount}`);
            } else {
                // If no initial balance row exists, create one
                if (balanceAmount > 0) {
                    const [insertResult] = await connection.execute(
                        `INSERT INTO pool (DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CD, CB, MB, MD, active) 
                         VALUES (?, NULL, 0, ?, ?, NULL, NULL, NOW(), ?, ?, NOW(), 1)`,
                        [id, balanceAmount, balanceAmount, MB, MB]
                    );
                    initialBalanceRowId = insertResult.insertId;
                    console.log(`Created initial balance row for depo ${id}: ID=${initialBalanceRowId}, DepoLimit=${balanceAmount}`);
                }
            }

            // Step 2: Get all pool rows for this depo (excluding the initial balance row) in ascending order
            let poolRowsQuery = `
                SELECT ID, Debit, Credit, DepoLimit 
                FROM pool 
                WHERE DepoID = ? AND active = 1
            `;
            let poolRowsParams = [id];

            if (initialBalanceRowId) {
                poolRowsQuery += ` AND ID != ?`;
                poolRowsParams.push(initialBalanceRowId);
            }

            poolRowsQuery += ` ORDER BY ID ASC`;

            const [poolRows] = await connection.execute(poolRowsQuery, poolRowsParams);

            // Step 3: Recalculate DepoLimit for all pool rows (ascending from oldest to newest)
            // Start with the UI balance value (which is now the initial balance)
            // Formula: New DepoLimit = Previous DepoLimit - Debit + Credit
            // (Debit reduces balance, Credit increases balance)
            let runningBalance = balanceAmount;

            for (const row of poolRows) {
                const debit = parseFloat(row.Debit) || 0;
                const credit = parseFloat(row.Credit) || 0;

                // Calculate new balance: previous balance - debit + credit
                // Debit reduces depo limit, Credit increases depo limit
                runningBalance = runningBalance - debit + credit;

                // Update this row's DepoLimit
                await connection.execute(
                    `UPDATE pool SET DepoLimit = ?, MB = ?, MD = NOW() WHERE ID = ?`,
                    [runningBalance, MB, row.ID]
                );

                console.log(`Updated pool row ${row.ID}: Previous=${row.DepoLimit}, New=${runningBalance} (Debit=${debit}, Credit=${credit})`);
            }
        }



        // ============================================
        // STEP 1: Get or create initial balance row special credit lmit
        // ============================================

        // Get a connection from the pool
        //connection = await pool.getConnection();
        // Find the initial balance row where TripID, payment_id, recovery_id are all NULL

        const spclbalanceAmount = requestedSpecialCreditLimit;

        const [initialBalanceRows] = await connection.execute(
            `SELECT ID, DepoLimit, Credit, Debit 
             FROM special_credit_limit 
             WHERE DepoID = ? 
               AND TripID IS NULL 
               AND payment_id IS NULL 
               AND recovery_id IS NULL 
               AND Active = 1 
             ORDER BY ID ASC 
             LIMIT 1`,
            [id]
        );
        if (initialBalanceRows.length == 0) {

            // Create new initial balance row if none exists
            const [insertResult] = await connection.execute(
                `INSERT INTO special_credit_limit 
                 (DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, Date, CD, CB, MB, MD, Active) 
                 VALUES (?, NULL, 0, ?, ?, NULL, NULL, CURDATE(), NOW(), ?, ?, NOW(), 1)`,
                [id, spclbalanceAmount, spclbalanceAmount, MB, MB]
            );
            initialBalanceRowId = insertResult.insertId;
            console.log(`Created initial balance row for depo ${id}: ID=${initialBalanceRowId}, DepoLimit=${spclbalanceAmount}`);
        }
        else {

            // Only update special credit limit if depo is NOT used in trips
            if (!isDepoUsedInTrips) {

                try {


                    // Start transaction
                    await connection.beginTransaction();



                    let initialBalanceRowId = null;

                    const [_initialBalanceRows] = await connection.execute(
                        `SELECT ID, DepoLimit, Credit, Debit 
                        FROM special_credit_limit 
                        WHERE DepoID = ? 
                        AND TripID IS NULL 
                        AND payment_id IS NULL 
                        AND recovery_id IS NULL 
                        AND Active = 1 
                        ORDER BY ID ASC 
                        LIMIT 1`,
                        [id]
                    );
                    if (_initialBalanceRows.length > 0) {
                        // Update existing initial balance row
                        initialBalanceRowId = initialBalanceRows[0].ID;
                        console.log(`Found initial balance row for depo ${id}: ID=${initialBalanceRowId}`);

                        await connection.execute(
                            `UPDATE special_credit_limit 
                            SET DepoLimit = ?, 
                                Credit = ?, 
                                MB = ?, 
                                MD = NOW() 
                            WHERE ID = ?`,
                            [spclbalanceAmount, spclbalanceAmount, MB, initialBalanceRowId]
                        );
                        console.log(`Updated initial balance row ${initialBalanceRowId} DepoLimit to ${spclbalanceAmount}`);
                    }

                    // ============================================
                    // STEP 2: Get all other rows for this depo
                    // ============================================
                    const [poolRows] = await connection.execute(
                        `SELECT ID, Debit, Credit, DepoLimit, TripID, payment_id, recovery_id
                        FROM special_credit_limit 
                        WHERE DepoID = ? 
                        AND Active = 1 
                        AND ID != ?
                        ORDER BY ID ASC`,
                        [id, initialBalanceRowId]
                    );

                    // ============================================
                    // STEP 3: Recalculate running balances
                    // ============================================
                    let runningBalance = spclbalanceAmount;
                    let rowsUpdated = 0;

                    console.log(`Starting balance recalculation for depo ${id}: Initial balance = ${spclbalanceAmount}`);

                    for (const row of poolRows) {
                        const debit = parseFloat(row.Debit) || 0;
                        const credit = parseFloat(row.Credit) || 0;

                        // Calculate new running balance
                        const newBalance = runningBalance - debit + credit;

                        // Update this row's DepoLimit
                        await connection.execute(
                            `UPDATE special_credit_limit 
                            SET DepoLimit = ?, 
                                MB = ?, 
                                MD = NOW() 
                            WHERE ID = ?`,
                            [newBalance, MB, row.ID]
                        );

                        console.log(`Updated row ${row.ID}: Previous=${row.DepoLimit}, New=${newBalance} (Debit=${debit}, Credit=${credit})`);

                        runningBalance = newBalance;
                        rowsUpdated++;
                    }

                    // ============================================
                    // STEP 4: Commit transaction
                    // ============================================
                    await connection.commit();

                    console.log(`✅ Balance recalculation completed for depo ${id}`);
                    console.log(`   - Initial balance: ${spclbalanceAmount}`);
                    console.log(`   - Rows updated: ${rowsUpdated}`);
                    console.log(`   - Final balance: ${runningBalance}`);

                    return {
                        success: true,
                        depoId: id,
                        initialBalance: balanceAmount,
                        finalBalance: runningBalance,
                        rowsUpdated: rowsUpdated,
                        message: `Credit limit updated successfully for depo ${id}`
                    };

                } catch (error) {
                    // Rollback transaction on error
                    if (connection) {
                        await connection.rollback();
                    }
                    console.error('Error updating credit limit:', error);
                    throw error;
                } finally {
                    // Release connection back to pool
                    if (connection) {
                        connection.release();
                    }
                }
            }
        }


        // Get previous_payables, default to 0 if not provided
        const previousPayables = parseFloat(previous_payables || 0) || 0;

        // Step 4: Update depo table (only update balance if depo is not used in trips)
        const updateFields = ['name = ?', 'code = ?', 'phone_no = ?', 'address = ?', 'previous_payables = ?', 'MB = ?', 'MD = NOW()'];
        const updateValues = [name, code || null, phone_no || null, address || null, previousPayables, MB];

        if (!isDepoUsedInTrips) {
            updateFields.push('Balance = ?');
            updateValues.push(requestedBalance);
        }

        updateValues.push(id); // For WHERE clause

        const query = `UPDATE depo SET ${updateFields.join(', ')} WHERE id = ? AND active = 1`;

        const [result] = await connection.execute(query, updateValues);

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Depo not found' });
        }

        // Step 5: Update depo_company relationship if company_id is provided
        if (company_id !== undefined) {
            try {
                // Check if relationship exists
                const [existingRows] = await connection.execute(
                    'SELECT id FROM depo_company WHERE depo_id = ?',
                    [id]
                );

                if (existingRows.length > 0) {
                    // Update existing relationship
                    if (company_id) {
                        await connection.execute(
                            'UPDATE depo_company SET company_id = ?, MB = ?, MD = NOW() WHERE depo_id = ?',
                            [company_id, MB, id]
                        );
                    } else {
                        // Delete relationship if company_id is null/empty
                        await connection.execute(
                            'DELETE FROM depo_company WHERE depo_id = ?',
                            [id]
                        );
                    }
                } else if (company_id) {
                    // Create new relationship
                    await connection.execute(
                        'INSERT INTO depo_company (depo_id, company_id, CD, CB, MB, MD, active) VALUES (?, ?, NOW(), ?, ?, NOW(), 1)',
                        [id, company_id, MB, MB]
                    );
                }
                console.log(`Depo-Company relationship updated: depo_id=${id}, company_id=${company_id || 'null'}`);
            } catch (err) {
                // If depo_company table doesn't exist or error, log but don't fail
                console.log('Note: Could not update depo_company:', err.message);
            }
        }

        await connection.commit();
        connection.release();

        res.json({ message: 'Depo updated successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error updating depo:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};
exports.updateDepo = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            id,
            name,
            code,
            phone_no,
            address,
            Balance,
            specialcreditlimit,
            previous_payables,
            company_id
        } = req.body;

        const MB = resolveAuditUser(req);

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Depo ID is required' });
        }
        if (!name) {
            connection.release();
            return res.status(400).json({ message: 'Depo name is required' });
        }

        // Validate code if provided
        if (code !== undefined && code !== null && code !== '' && (!/^[a-zA-Z0-9]{4,}$/.test(code))) {
            connection.release();
            return res.status(400).json({ message: 'Depo Code must be alphanumeric and at least 4 characters' });
        }

        // Validate phone number if provided
        if (phone_no && (!/^[0-9]{11,}$/.test(phone_no))) {
            connection.release();
            return res.status(400).json({ message: 'Phone number must be numeric and at least 11 digits' });
        }

        // Check if a dealer with the same name already exists for the same company
        if (company_id) {
            const checkDuplicateQuery = `
                SELECT d.id 
                FROM depo d
                INNER JOIN depo_company dc ON d.id = dc.depo_id AND dc.active = 1
                WHERE LOWER(TRIM(d.name)) = LOWER(TRIM(?)) 
                AND dc.company_id = ? 
                AND d.id != ?
                AND d.active = 1
            `;
            const [existingDealers] = await connection.execute(checkDuplicateQuery, [name, company_id, id]);

            if (existingDealers.length > 0) {
                connection.release();
                return res.status(400).json({
                    message: `A dealer with the name "${name}" already exists for this company. Please use a different name.`
                });
            }
        }

        // Check if depo is used in trips
        let isDepoUsedInTrips = false;
        try {
            const [tripDeposRows] = await connection.execute('SELECT COUNT(*) as count FROM trip_depos WHERE depo_id = ? AND Active = 1', [id]);
            isDepoUsedInTrips = (tripDeposRows[0]?.count || 0) > 0;
        } catch (err) {
            console.log('trip_depos table check skipped:', err.message);
        }

        // Get current balance from database - CHECK FOR CORRECT COLUMN NAME
        let currentDepoRows = [];
        let specialCreditColumnName = 'special_credit_limit'; // Default column name
        let hasSpecialCreditColumn = false;

        try {
            // First, check what columns exist in the depo table
            const [columns] = await connection.execute(
                `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
                 WHERE TABLE_SCHEMA = DATABASE() 
                 AND TABLE_NAME = 'depo' 
                 AND COLUMN_NAME IN ('special_credit_limit', 'specialcreditlimit', 'special_credit')`
            );

            if (columns && columns.length > 0) {
                hasSpecialCreditColumn = true;
                specialCreditColumnName = columns[0].COLUMN_NAME;
                console.log(`Found special credit column: ${specialCreditColumnName}`);
            }
        } catch (err) {
            console.log('Could not check for special credit column:', err.message);
        }

        // Build the SELECT query dynamically
        let selectQuery = 'SELECT Balance';
        if (hasSpecialCreditColumn) {
            selectQuery += `, ${specialCreditColumnName}`;
        }
        selectQuery += ' FROM depo WHERE id = ?';

        const [depoRows] = await connection.execute(selectQuery, [id]);
        currentDepoRows = depoRows;

        if (currentDepoRows.length === 0) {
            connection.release();
            return res.status(404).json({ message: 'Depo not found' });
        }

        const currentBalance = parseFloat(currentDepoRows[0].Balance || 0);
        const requestedBalance = parseFloat(Balance) || 0;

        // Get current special credit limit
        let currentSpecialCreditBalance = 0;
        let requestedSpecialCreditLimit = parseFloat(specialcreditlimit) || 0;

        if (hasSpecialCreditColumn && currentDepoRows[0][specialCreditColumnName] !== undefined) {
            currentSpecialCreditBalance = parseFloat(currentDepoRows[0][specialCreditColumnName] || 0);
        }

        // If depo is used in trips, don't allow balance edit
        if (isDepoUsedInTrips && currentBalance !== requestedBalance) {
            connection.release();
            return res.status(400).json({
                message: 'Balance cannot be edited. This depo is currently used in trip(s). Other information can be edited.'
            });
        }

        await connection.beginTransaction();

        // ============================================
        // UPDATE REGULAR BALANCE (Pool table)
        // ============================================
        if (!isDepoUsedInTrips) {
            const balanceAmount = requestedBalance;

            // Step 1: Get the initial balance row from pool table
            const [initialBalanceRows] = await connection.execute(
                `SELECT ID, DepoLimit FROM pool 
                 WHERE DepoID = ? AND payment_id IS NULL AND recovery_id IS NULL AND TripID IS NULL AND active = 1 
                 ORDER BY ID ASC LIMIT 1`,
                [id]
            );

            let initialBalanceRowId = null;

            if (initialBalanceRows.length > 0) {
                initialBalanceRowId = initialBalanceRows[0].ID;
                await connection.execute(
                    `UPDATE pool SET DepoLimit = ?, Credit = ?, MB = ?, MD = NOW() WHERE ID = ?`,
                    [balanceAmount, balanceAmount, MB, initialBalanceRowId]
                );
                console.log(`Updated initial balance row ${initialBalanceRowId} DepoLimit to ${balanceAmount}`);
            } else {
                if (balanceAmount > 0) {
                    const [insertResult] = await connection.execute(
                        `INSERT INTO pool (DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CD, CB, MB, MD, active) 
                         VALUES (?, NULL, 0, ?, ?, NULL, NULL, NOW(), ?, ?, NOW(), 1)`,
                        [id, balanceAmount, balanceAmount, MB, MB]
                    );
                    initialBalanceRowId = insertResult.insertId;
                    console.log(`Created initial balance row for depo ${id}: ID=${initialBalanceRowId}`);
                }
            }

            // Recalculate all pool rows
            let poolRowsQuery = `
                SELECT ID, Debit, Credit, DepoLimit 
                FROM pool 
                WHERE DepoID = ? AND active = 1
            `;
            let poolRowsParams = [id];

            if (initialBalanceRowId) {
                poolRowsQuery += ` AND ID != ?`;
                poolRowsParams.push(initialBalanceRowId);
            }

            poolRowsQuery += ` ORDER BY ID ASC`;

            const [poolRows] = await connection.execute(poolRowsQuery, poolRowsParams);

            let runningBalance = balanceAmount;

            for (const row of poolRows) {
                const debit = parseFloat(row.Debit) || 0;
                const credit = parseFloat(row.Credit) || 0;
                runningBalance = runningBalance - debit + credit;

                await connection.execute(
                    `UPDATE pool SET DepoLimit = ?, MB = ?, MD = NOW() WHERE ID = ?`,
                    [runningBalance, MB, row.ID]
                );
                console.log(`Updated pool row ${row.ID}: New=${runningBalance}`);
            }
        }

        // ============================================
        // UPDATE SPECIAL CREDIT LIMIT (special_credit_limit table)
        // ============================================
        if (hasSpecialCreditColumn) {
            // First, check if the depo has any special credit entries
            const [specialCreditRows] = await connection.execute(
                `SELECT ID FROM special_credit_limit 
                 WHERE DepoID = ? AND active = 1 LIMIT 1`,
                [id]
            );

            if (specialCreditRows.length === 0 && requestedSpecialCreditLimit > 0) {
                // Create initial special credit limit entry
                await connection.execute(
                    `INSERT INTO special_credit_limit 
                     (DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, Date, CD, CB, MB, MD, Active) 
                     VALUES (?, NULL, 0, ?, ?, NULL, NULL, CURDATE(), NOW(), ?, ?, NOW(), 1)`,
                    [id, requestedSpecialCreditLimit, requestedSpecialCreditLimit, MB, MB]
                );
                console.log(`Created initial special credit limit for depo ${id}: ${requestedSpecialCreditLimit}`);
            } else if (specialCreditRows.length > 0) {
                // Get the initial balance row
                const [initialSpecialCreditRows] = await connection.execute(
                    `SELECT ID, DepoLimit FROM special_credit_limit 
                     WHERE DepoID = ? AND TripID IS NULL AND payment_id IS NULL AND recovery_id IS NULL AND Active = 1 
                     ORDER BY ID ASC LIMIT 1`,
                    [id]
                );

                if (initialSpecialCreditRows.length > 0 && !isDepoUsedInTrips) {
                    const initialRowId = initialSpecialCreditRows[0].ID;

                    // Update the initial balance
                    await connection.execute(
                        `UPDATE special_credit_limit 
                         SET DepoLimit = ?, Credit = ?, MB = ?, MD = NOW() 
                         WHERE ID = ?`,
                        [requestedSpecialCreditLimit, requestedSpecialCreditLimit, MB, initialRowId]
                    );
                    console.log(`Updated initial special credit row ${initialRowId} to ${requestedSpecialCreditLimit}`);

                    // Recalculate all other special credit rows
                    const [allSpecialCreditRows] = await connection.execute(
                        `SELECT ID, Debit, Credit, DepoLimit 
                         FROM special_credit_limit 
                         WHERE DepoID = ? AND Active = 1 AND ID != ?
                         ORDER BY ID ASC`,
                        [id, initialRowId]
                    );

                    let runningSpecialBalance = requestedSpecialCreditLimit;
                    for (const row of allSpecialCreditRows) {
                        const debit = parseFloat(row.Debit) || 0;
                        const credit = parseFloat(row.Credit) || 0;
                        runningSpecialBalance = runningSpecialBalance - debit + credit;

                        await connection.execute(
                            `UPDATE special_credit_limit 
                             SET DepoLimit = ?, MB = ?, MD = NOW() 
                             WHERE ID = ?`,
                            [runningSpecialBalance, MB, row.ID]
                        );
                        console.log(`Updated special credit row ${row.ID}: New=${runningSpecialBalance}`);
                    }
                }
            }

            // Update depo table's special credit column
            const updateQuery = `UPDATE depo SET ${specialCreditColumnName} = ?, MD = NOW() WHERE id = ?`;
            await connection.execute(updateQuery, [requestedSpecialCreditLimit, id]);
        }

        // ============================================
        // UPDATE DEPO TABLE
        // ============================================
        const previousPayables = parseFloat(previous_payables || 0) || 0;

        let updateFields = ['name = ?', 'code = ?', 'phone_no = ?', 'address = ?', 'previous_payables = ?', 'MB = ?', 'MD = NOW()'];
        let updateValues = [name, code || null, phone_no || null, address || null, previousPayables, MB];

        if (!isDepoUsedInTrips) {
            updateFields.push('Balance = ?');
            updateValues.push(requestedBalance);
        }

        updateValues.push(id);

        const query = `UPDATE depo SET ${updateFields.join(', ')} WHERE id = ? AND active = 1`;
        const [result] = await connection.execute(query, updateValues);

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Depo not found' });
        }

        // ============================================
        // UPDATE DEPO_COMPANY RELATIONSHIP
        // ============================================
        if (company_id !== undefined) {
            try {
                const [existingRows] = await connection.execute(
                    'SELECT id FROM depo_company WHERE depo_id = ?',
                    [id]
                );

                if (existingRows.length > 0) {
                    if (company_id) {
                        await connection.execute(
                            'UPDATE depo_company SET company_id = ?, MB = ?, MD = NOW() WHERE depo_id = ?',
                            [company_id, MB, id]
                        );
                    } else {
                        await connection.execute(
                            'DELETE FROM depo_company WHERE depo_id = ?',
                            [id]
                        );
                    }
                } else if (company_id) {
                    await connection.execute(
                        'INSERT INTO depo_company (depo_id, company_id, CD, CB, MB, MD, active) VALUES (?, ?, NOW(), ?, ?, NOW(), 1)',
                        [id, company_id, MB, MB]
                    );
                }
            } catch (err) {
                console.log('Note: Could not update depo_company:', err.message);
            }
        }

        await connection.commit();
        connection.release();

        res.json({ message: 'Depo updated successfully' });
    } catch (err) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackErr) {
                console.error('Error rolling back:', rollbackErr);
            }
            connection.release();
        }
        console.error('Error updating depo:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete depo (soft delete - set active=0)
exports.deleteDepo = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { id } = req.body;

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        const MB = resolveAuditUser(req);

        await connection.beginTransaction();

        // Check if depo exists and is active
        const [depoRows] = await connection.execute('SELECT id, active FROM depo WHERE id = ?', [id]);
        if (depoRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Depo not found' });
        }

        if (depoRows[0].active === 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ message: 'Depo is already deleted' });
        }

        // Soft delete: set active=0 and update MD
        const [result] = await connection.execute(
            'UPDATE depo SET active = 0, MB = ?, MD = NOW() WHERE id = ?',
            [MB, id]
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Depo not found' });
        }

        // Also soft delete depo_company relationships
        try {
            await connection.execute(
                'UPDATE depo_company SET active = 0, MB = ?, MD = NOW() WHERE depo_id = ?',
                [MB, id]
            );
        } catch (err) {
            // If depo_company table doesn't exist, ignore
            console.log('Note: Could not update depo_company:', err.message);
        }

        await connection.commit();
        connection.release();

        res.json({ message: 'Depo deleted successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error deleting depo:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Check if depo is used in trips by checking trip_depos table
exports.checkDepoUsedInTrips = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        try {
            // Check trip_depos table with active=1
            const [tripDeposRows] = await db.execute(
                'SELECT COUNT(*) as count FROM trip_depos WHERE depo_id = ? AND Active = 1',
                [id]
            );
            const isUsed = (tripDeposRows[0]?.count || 0) > 0;
            res.json({ isUsed });
        } catch (err) {
            // If trip_depos table doesn't exist, return false
            console.log('trip_depos table check failed:', err.message);
            res.json({ isUsed: false });
        }
    } catch (err) {
        console.error('Error checking if depo is used in trips:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

exports.getDepoCreditUsage = async (req, res) => {
    let connection;
    try {
        //console.log(' Fetching depo credit usage data...');

        connection = await db.getConnection();
        //console.log('✅ Database connection acquired');


        // ============================================
        // 1. Get Depo Credit Usage
        // ============================================
        let depoCreditUsage = [];
        try {
            const [rows] = await connection.query(`
                SELECT 
                    d.id as depo_id,
                    d.name as depo,
                    COALESCE(SUM(Credit), 0) as available,
                    COALESCE(SUM(Debit), 0) as used
                FROM depo d
                LEFT JOIN pool p ON p.DepoID = d.id AND p.active = 1
                WHERE d.active = 1
                GROUP BY d.id, d.name
            `);
            depoCreditUsage = rows || [];
        } catch (err) {
            //console.log(' Could not fetch depo credit usage:', err.message);
        }

        // ============================================
        // 2. Get Special Credit Limit
        // ============================================
        let specialCreditLimits = [];
        try {
            const [rows] = await connection.query(`
                 SELECT 
                    d.id as depo_id,
                    d.name as depo,
                    COALESCE(SUM(Credit), 0) as available,
                    COALESCE(SUM(Debit), 0) as used
                FROM depo d
                LEFT JOIN special_credit_limit sp ON sp.DepoID = d.id AND sp.active = 1
                WHERE d.active = 1
                GROUP BY d.id, d.name
            `);
            specialCreditLimits = rows || [];
        } catch (err) {
            console.error(' Could not fetch special credit limits:', err.message);
        }
        // ============================================
        // Build Response - Matching Frontend Expectations
        // ============================================
        const response = {

            depoCreditUsage: depoCreditUsage,
            specialCreditLimits: specialCreditLimits,

        };


        connection.release();
        res.json(response);

    } catch (err) {
        console.error('❌ Error in getDepoCreditUsage:', err);
        console.error('Error code:', err.code);
        console.error('Error message:', err.message);

        if (connection) {
            try { connection.release(); } catch (e) { }
        }

        // Return safe default values
        res.status(500).json({

            depoCreditUsage: []

        });
    }
};


