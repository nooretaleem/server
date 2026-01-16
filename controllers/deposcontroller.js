const db = require('../models/db');

// Get all depos (only active ones)
exports.getDepos = async (req, res) => {
    try {
        const query = `
            SELECT 
                d.id,
                d.name,
                d.phone_no,
                d.address,
                d.Balance,
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
                        phone_no,
                        address,
                        Balance,
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
            phone_no,
            address,
            Balance,
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

        // Get CB (Created By) from request body, default to 'System' if not provided
        const CB = req.body.CB || 'System';

        const balanceAmount = parseFloat(Balance) || 0;

        await connection.beginTransaction();

        // Insert into depo table with CB, CD, MD, active
        const depoQuery = `
            INSERT INTO depo (name, phone_no, address, Balance, CB, CD, MD, active) 
            VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 1)
        `;

        const [depoResult] = await connection.execute(depoQuery, [
            name,
            phone_no || null,
            address || null,
            balanceAmount,
            CB
        ]);

        const depoId = depoResult.insertId;

        // Insert into depo_company table if company_id is provided
        if (company_id) {
            try {
                const depoCompanyQuery = `
                    INSERT INTO depo_company (depo_id, company_id, CD, CB, MD, active) 
                    VALUES (?, ?, NOW(), ?, NOW(), 1)
                `;
                await connection.execute(depoCompanyQuery, [depoId, company_id, CB]);
                console.log(`Depo-Company relationship created: depo_id=${depoId}, company_id=${company_id}`);
            } catch (err) {
                // If depo_company table doesn't exist or error, log but don't fail
                console.log('Note: Could not insert into depo_company:', err.message);
            }
        }

        // Insert into pool table with Credit value, TripID, payment_id and recovery_id as NULL
        if (balanceAmount > 0) {
            const poolQuery = `
                INSERT INTO pool (DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CD, CB, MD, active) 
                VALUES (?, NULL, 0, ?, ?, NULL, NULL, NOW(), ?, NOW(), 1)
            `;

            await connection.execute(poolQuery, [
                depoId,
                balanceAmount,  // Credit amount (initial balance)
                balanceAmount,  // DepoLimit = Balance (same as initial balance)
                CB
            ]);

            console.log(`Pool record created for new depo ${depoId}: Credit=${balanceAmount}, DepoLimit=${balanceAmount}`);
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
exports.updateDepo = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            id,
            name,
            phone_no,
            address,
            Balance,
            company_id,
            CB // Modified By (user ID or username)
        } = req.body;

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Depo ID is required' });
        }
        if (!name) {
            connection.release();
            return res.status(400).json({ message: 'Depo name is required' });
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
        const [currentDepoRows] = await connection.execute('SELECT Balance FROM depo WHERE id = ?', [id]);
        if (currentDepoRows.length === 0) {
            connection.release();
            return res.status(404).json({ message: 'Depo not found' });
        }
        const currentBalance = parseFloat(currentDepoRows[0].Balance || 0);
        const requestedBalance = parseFloat(Balance) || 0;

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
                    `UPDATE pool SET DepoLimit = ?, Credit = ? WHERE ID = ?`,
                    [balanceAmount, balanceAmount, initialBalanceRowId]
                );
                console.log(`Updated initial balance row ${initialBalanceRowId} DepoLimit to ${balanceAmount}`);
            } else {
                // If no initial balance row exists, create one
                if (balanceAmount > 0) {
                    const [insertResult] = await connection.execute(
                        `INSERT INTO pool (DepoID, TripID, Debit, Credit, DepoLimit, payment_id, recovery_id, CD, CB, MD, active) 
                         VALUES (?, NULL, 0, ?, ?, NULL, NULL, NOW(), ?, NOW(), 1)`,
                        [id, balanceAmount, balanceAmount, CB]
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
                    `UPDATE pool SET DepoLimit = ? WHERE ID = ?`,
                    [runningBalance, row.ID]
                );
                
                console.log(`Updated pool row ${row.ID}: Previous=${row.DepoLimit}, New=${runningBalance} (Debit=${debit}, Credit=${credit})`);
            }
        }

        // Step 4: Update depo table (only update balance if depo is not used in trips)
        const updateFields = ['name = ?', 'phone_no = ?', 'address = ?', 'MD = NOW()'];
        const updateValues = [name, phone_no || null, address || null];
        
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
                            'UPDATE depo_company SET company_id = ? WHERE depo_id = ?',
                            [company_id, id]
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
                        'INSERT INTO depo_company (depo_id, company_id, CD, CB, MD, active) VALUES (?, ?, NOW(), ?, NOW(), 1)',
                        [id, company_id, CB || null]
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

// Delete depo (soft delete - set active=0)
exports.deleteDepo = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { id } = req.body;

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Depo ID is required' });
        }

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
            'UPDATE depo SET active = 0, MD = NOW() WHERE id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Depo not found' });
        }

        // Also soft delete depo_company relationships
        try {
            await connection.execute(
                'UPDATE depo_company SET active = 0, MD = NOW() WHERE depo_id = ?',
                [id]
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

