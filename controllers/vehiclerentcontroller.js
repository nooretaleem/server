const db = require('../models/db');

// Get all vehicle rents
exports.getVehicleRents = async (req, res) => {
    try {
        const query = `
            SELECT 
                vr.id,
                vr.trip_id,
                vr.vehicle_id,
                vr.distance_km,
                vr.rent_per_km,
                vr.total_rent,
                vr.payment_source,
                vr.created_at,
                vr.updated_at,
                t.trip_no,
                v.number as vehicle_number
            FROM vehicle_rent vr
            LEFT JOIN trips t ON vr.trip_id = t.id
            LEFT JOIN vehicles v ON vr.vehicle_id = v.id
            ORDER BY vr.created_at DESC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching vehicle rents:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get vehicle rent by ID
exports.getVehicleRentById = async (req, res) => {
    try {
        const id = req.params.id;
        if (!id) {
            return res.status(400).json({ message: 'Vehicle rent ID is required' });
        }

        const query = `
            SELECT 
                vr.*,
                t.trip_no,
                v.number as vehicle_number
            FROM vehicle_rent vr
            LEFT JOIN trips t ON vr.trip_id = t.id
            LEFT JOIN vehicles v ON vr.vehicle_id = v.id
            WHERE vr.id = ?
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Vehicle rent not found' });
        }
        
        const vehicleRent = rows[0];
        
        // Get transaction info to determine payment_source and account_id
        const tripNo = vehicleRent.trip_no || `Trip ${vehicleRent.trip_id}`;
        const purpose = `Vehicle Rent Payment - ${tripNo}`;
        
        const [transactionRows] = await db.execute(
            `SELECT AccountID, cash_in_hand_id, PaymentMode FROM transactions 
             WHERE Purpose = ? AND active = 1 ORDER BY ID DESC LIMIT 1`,
            [purpose]
        );
        
        if (transactionRows.length > 0) {
            const transaction = transactionRows[0];
            if (transaction.cash_in_hand_id) {
                vehicleRent.payment_source = 'cash';
            } else if (transaction.AccountID) {
                vehicleRent.payment_source = 'bank';
                vehicleRent.account_id = transaction.AccountID;
            }
        }
        
        res.json(vehicleRent);
    } catch (err) {
        console.error('Error fetching vehicle rent:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get vehicle rent by trip ID
exports.getVehicleRentByTripId = async (req, res) => {
    try {
        const tripId = req.query.tripId || req.params.tripId;
        if (!tripId) {
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        const query = `
            SELECT 
                vr.*,
                t.trip_no,
                v.number as vehicle_number
            FROM vehicle_rent vr
            LEFT JOIN trips t ON vr.trip_id = t.id
            LEFT JOIN vehicles v ON vr.vehicle_id = v.id
            WHERE vr.trip_id = ?
        `;
        const [rows] = await db.execute(query, [tripId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Vehicle rent not found for this trip' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching vehicle rent by trip ID:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new vehicle rent
exports.addVehicleRent = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            trip_id,
            vehicle_id,
            distance_km,
            rent_per_km,
            total_rent,
            payment_source,
            account_id
        } = req.body;

        if (!trip_id || !vehicle_id || !distance_km || !rent_per_km || !total_rent || !payment_source) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Validate account_id for bank payments
        if (payment_source === 'bank' && (!account_id || account_id === '' || account_id === null)) {
            return res.status(400).json({ message: 'Account ID is required for bank payment' });
        }

        await connection.beginTransaction();

        // 1. Insert into vehicle_rent table (without payment_source)
        const query = `
            INSERT INTO vehicle_rent 
            (trip_id, vehicle_id, distance_km, rent_per_km, total_rent, created_at, updated_at) 
            VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        `;

        const [result] = await connection.execute(query, [
            trip_id,
            vehicle_id,
            distance_km,
            rent_per_km,
            total_rent
        ]);

        const vehicleRentId = result.insertId;

        // 2. Get trip number for transaction purpose
        const [tripRows] = await connection.execute(
            'SELECT trip_no FROM trips WHERE id = ?',
            [trip_id]
        );
        const tripNo = tripRows[0]?.trip_no || `Trip ${trip_id}`;
        const purpose = `Vehicle Rent Payment - ${tripNo}`;

        // 3. Create transaction based on payment source
        if (payment_source === 'cash') {
            // Cash payment - credit cash in hand
            // Get current cash in hand balance
            const [balanceRows] = await connection.execute(`
                SELECT COALESCE(SUM(debit - COALESCE(credit, 0)), 0) as balance
                FROM cash_in_hand
            `);
            const currentBalance = parseFloat(balanceRows[0]?.balance || 0);
            const newBalance = currentBalance - total_rent; // Credit subtracts from balance

            // Insert into cash_in_hand
            const [cashInHandResult] = await connection.execute(`
                INSERT INTO cash_in_hand (credit, balance, purpose, created_at)
                VALUES (?, ?, ?, NOW())
            `, [total_rent, newBalance, purpose]);

            const cashInHandId = cashInHandResult.insertId;

            // Insert into transactions
            await connection.execute(`
                INSERT INTO transactions (
                    cash_in_hand_id, AccountID, Purpose, Debit, Credit, 
                    PaymentMode, Date, CD, MD, active
                ) VALUES (?, NULL, ?, 0, ?, 'Cash', NOW(), NOW(), NOW(), 1)
            `, [cashInHandId, purpose, total_rent]);

        } else if (payment_source === 'bank') {
            // Bank payment - credit account
            if (!account_id) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ message: 'Account ID is required for bank payment' });
            }

            // Get account info
            const [accountRows] = await connection.execute(
                'SELECT Balance FROM accounts WHERE ID = ? AND active = 1',
                [account_id]
            );

            if (accountRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Account not found or inactive' });
            }

            // Update account balance (credit subtracts from balance)
            await connection.execute(`
                UPDATE accounts 
                SET Balance = Balance - ?, MD = NOW()
                WHERE ID = ? AND active = 1
            `, [total_rent, account_id]);

            // Insert into transactions
            await connection.execute(`
                INSERT INTO transactions (
                    AccountID, cash_in_hand_id, Purpose, Debit, Credit,
                    PaymentMode, Date, CD, MD, active
                ) VALUES (?, NULL, ?, 0, ?, 'Bank', NOW(), NOW(), NOW(), 1)
            `, [account_id, purpose, total_rent]);
        }

        await connection.commit();
        connection.release();

        res.json({
            message: 'Vehicle rent added successfully',
            id: vehicleRentId
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error adding vehicle rent:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'vehicle_rent table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update vehicle rent
exports.updateVehicleRent = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            id,
            trip_id,
            vehicle_id,
            distance_km,
            rent_per_km,
            total_rent,
            payment_source,
            account_id
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Vehicle rent ID is required' });
        }

        if (!trip_id || !vehicle_id || !distance_km || !rent_per_km || !total_rent || !payment_source) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Validate account_id for bank payments
        if (payment_source === 'bank' && (!account_id || account_id === '' || account_id === null)) {
            return res.status(400).json({ message: 'Account ID is required for bank payment' });
        }

        await connection.beginTransaction();

        // 1. Get old vehicle rent data to reverse old transactions
        const [oldRentRows] = await connection.execute(
            'SELECT * FROM vehicle_rent WHERE id = ?',
            [id]
        );

        if (oldRentRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Vehicle rent not found' });
        }

        const oldRent = oldRentRows[0];

        // 2. Get old trip number for transaction reversal
        const [oldTripRows] = await connection.execute(
            'SELECT trip_no FROM trips WHERE id = ?',
            [oldRent.trip_id]
        );
        const oldTripNo = oldTripRows[0]?.trip_no || `Trip ${oldRent.trip_id}`;
        const oldPurpose = `Vehicle Rent Payment - ${oldTripNo}`;

        // 3. Find and reverse old transaction
        const [oldTransactionRows] = await connection.execute(
            `SELECT * FROM transactions WHERE Purpose = ? AND active = 1 ORDER BY ID DESC LIMIT 1`,
            [oldPurpose]
        );

        if (oldTransactionRows.length > 0) {
            const oldTransaction = oldTransactionRows[0];
            const oldAmount = parseFloat(oldTransaction.Credit || 0);

            // Reverse cash in hand transaction
            if (oldTransaction.cash_in_hand_id) {
                // Get current balance
                const [balanceRows] = await connection.execute(`
                    SELECT COALESCE(SUM(debit - COALESCE(credit, 0)), 0) as balance
                    FROM cash_in_hand
                `);
                const currentBalance = parseFloat(balanceRows[0]?.balance || 0);
                const newBalance = currentBalance + oldAmount; // Reverse credit (add back)

                // Insert reverse entry
                await connection.execute(`
                    INSERT INTO cash_in_hand (debit, balance, purpose, created_at)
                    VALUES (?, ?, ?, NOW())
                `, [oldAmount, newBalance, `Reversal: ${oldPurpose}`]);

                // Mark transaction as inactive
                await connection.execute(`
                    UPDATE transactions SET active = 0, MD = NOW() WHERE ID = ?
                `, [oldTransaction.ID]);
            }

            // Reverse bank account transaction
            if (oldTransaction.AccountID) {
                // Reverse account balance (add back the credit)
                await connection.execute(`
                    UPDATE accounts 
                    SET Balance = Balance + ?, MD = NOW()
                    WHERE ID = ? AND active = 1
                `, [oldAmount, oldTransaction.AccountID]);

                // Mark transaction as inactive
                await connection.execute(`
                    UPDATE transactions SET active = 0, MD = NOW() WHERE ID = ?
                `, [oldTransaction.ID]);
            }
        }

        // 4. Update vehicle_rent record
        await connection.execute(`
            UPDATE vehicle_rent SET 
                trip_id = ?,
                vehicle_id = ?,
                distance_km = ?,
                rent_per_km = ?,
                total_rent = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [trip_id, vehicle_id, distance_km, rent_per_km, total_rent, id]);

        // 5. Get new trip number for new transaction
        const [newTripRows] = await connection.execute(
            'SELECT trip_no FROM trips WHERE id = ?',
            [trip_id]
        );
        const newTripNo = newTripRows[0]?.trip_no || `Trip ${trip_id}`;
        const newPurpose = `Vehicle Rent Payment - ${newTripNo}`;

        // 6. Create new transaction based on payment source
        if (payment_source === 'cash') {
            // Cash payment - credit cash in hand
            const [balanceRows] = await connection.execute(`
                SELECT COALESCE(SUM(debit - COALESCE(credit, 0)), 0) as balance
                FROM cash_in_hand
            `);
            const currentBalance = parseFloat(balanceRows[0]?.balance || 0);
            const newBalance = currentBalance - total_rent; // Credit subtracts from balance

            // Insert into cash_in_hand
            const [cashInHandResult] = await connection.execute(`
                INSERT INTO cash_in_hand (credit, balance, purpose, created_at)
                VALUES (?, ?, ?, NOW())
            `, [total_rent, newBalance, newPurpose]);

            const cashInHandId = cashInHandResult.insertId;

            // Insert into transactions
            await connection.execute(`
                INSERT INTO transactions (
                    cash_in_hand_id, AccountID, Purpose, Debit, Credit, 
                    PaymentMode, Date, CD, MD, active
                ) VALUES (?, NULL, ?, 0, ?, 'Cash', NOW(), NOW(), NOW(), 1)
            `, [cashInHandId, newPurpose, total_rent]);

        } else if (payment_source === 'bank') {
            // Bank payment - credit account
            if (!account_id) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ message: 'Account ID is required for bank payment' });
            }

            // Get account info
            const [accountRows] = await connection.execute(
                'SELECT Balance FROM accounts WHERE ID = ? AND active = 1',
                [account_id]
            );

            if (accountRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ message: 'Account not found or inactive' });
            }

            // Update account balance (credit subtracts from balance)
            await connection.execute(`
                UPDATE accounts 
                SET Balance = Balance - ?, MD = NOW()
                WHERE ID = ? AND active = 1
            `, [total_rent, account_id]);

            // Insert into transactions
            await connection.execute(`
                INSERT INTO transactions (
                    AccountID, cash_in_hand_id, Purpose, Debit, Credit,
                    PaymentMode, Date, CD, MD, active
                ) VALUES (?, NULL, ?, 0, ?, 'Bank', NOW(), NOW(), NOW(), 1)
            `, [account_id, newPurpose, total_rent]);
        }

        await connection.commit();
        connection.release();

        res.json({ message: 'Vehicle rent updated successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error updating vehicle rent:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete vehicle rent
exports.deleteVehicleRent = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const id = req.params.id;
        if (!id) {
            return res.status(400).json({ message: 'Vehicle rent ID is required' });
        }

        await connection.beginTransaction();

        // 1. Get vehicle rent data to find and reverse transactions
        const [rentRows] = await connection.execute(
            'SELECT * FROM vehicle_rent WHERE id = ?',
            [id]
        );

        if (rentRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Vehicle rent not found' });
        }

        const rent = rentRows[0];

        // 2. Get trip number for transaction reversal
        const [tripRows] = await connection.execute(
            'SELECT trip_no FROM trips WHERE id = ?',
            [rent.trip_id]
        );
        const tripNo = tripRows[0]?.trip_no || `Trip ${rent.trip_id}`;
        const purpose = `Vehicle Rent Payment - ${tripNo}`;

        // 3. Find and reverse transaction
        const [transactionRows] = await connection.execute(
            `SELECT * FROM transactions WHERE Purpose = ? AND active = 1 ORDER BY ID DESC LIMIT 1`,
            [purpose]
        );

        if (transactionRows.length > 0) {
            const transaction = transactionRows[0];
            const amount = parseFloat(transaction.Credit || 0);

            // Reverse cash in hand transaction
            if (transaction.cash_in_hand_id) {
                // Get current balance
                const [balanceRows] = await connection.execute(`
                    SELECT COALESCE(SUM(debit - COALESCE(credit, 0)), 0) as balance
                    FROM cash_in_hand
                `);
                const currentBalance = parseFloat(balanceRows[0]?.balance || 0);
                const newBalance = currentBalance + amount; // Reverse credit (add back)

                // Insert reverse entry
                await connection.execute(`
                    INSERT INTO cash_in_hand (debit, balance, purpose, created_at)
                    VALUES (?, ?, ?, NOW())
                `, [amount, newBalance, `Reversal: ${purpose}`]);

                // Mark transaction as inactive
                await connection.execute(`
                    UPDATE transactions SET active = 0, MD = NOW() WHERE ID = ?
                `, [transaction.ID]);
            }

            // Reverse bank account transaction
            if (transaction.AccountID) {
                // Reverse account balance (add back the credit)
                await connection.execute(`
                    UPDATE accounts 
                    SET Balance = Balance + ?, MD = NOW()
                    WHERE ID = ? AND active = 1
                `, [amount, transaction.AccountID]);

                // Mark transaction as inactive
                await connection.execute(`
                    UPDATE transactions SET active = 0, MD = NOW() WHERE ID = ?
                `, [transaction.ID]);
            }
        }

        // 4. Delete vehicle rent record
        await connection.execute('DELETE FROM vehicle_rent WHERE id = ?', [id]);

        await connection.commit();
        connection.release();

        res.json({ message: 'Vehicle rent deleted and transactions reversed successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error deleting vehicle rent:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get vehicle rent transactions from transactions table
exports.getVehicleRentTransactions = async (req, res) => {
    try {
        const query = `
            SELECT 
                t.ID as transaction_id,
                t.Purpose,
                t.Credit,
                t.Debit,
                t.AccountID,
                t.cash_in_hand_id,
                t.Date,
                t.PaymentMode,
                t.ReferenceNo,
                CASE 
                    WHEN t.cash_in_hand_id IS NOT NULL THEN 'Cash in Hand'
                    WHEN t.AccountID IS NOT NULL THEN CONCAT(COALESCE(b.Name, ''), ' - ', COALESCE(a.AccountTitle, ''))
                    ELSE 'N/A'
                END as account_head,
                a.AccountNo,
                a.AccountTitle,
                b.Name as BankName
            FROM transactions t
            LEFT JOIN accounts a ON t.AccountID = a.ID
            LEFT JOIN bank b ON a.BankID = b.ID
            WHERE (t.Purpose LIKE '%Vehicle Rent Payment%' OR t.Purpose LIKE '%Vehicle Rent%' OR t.Purpose LIKE '%Tanker Rental%')
            AND t.active = 1
            ORDER BY t.ID DESC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching vehicle rent transactions:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

