const db = require('../models/db');

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
    } catch (err) {
        console.error(`Error checking/completing trip ${tripId}:`, err);
        // Don't throw error, just log it
    }
}

// Helper function to recalculate all balances in cash_in_hand table
async function recalculateAllBalances(connection) {
    try {
        // Get all records ordered by created_at and id where active = 1
        const [allRecords] = await connection.execute(`
            SELECT id, debit, credit
            FROM cash_in_hand
            WHERE Active = 1
            ORDER BY created_at ASC, id ASC
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

// Helper function to recalculate pool balances for a depo starting from a specific row ID
// If startFromRowId is provided, recalculate from the row before it forward
async function recalculatePoolBalancesFromRow(connection, depoId, startFromRowId = null) {
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
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
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

// Get single trip by ID
exports.getTrip = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        const query = `
            SELECT 
                t.id,
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

// Add new trip
exports.addTrip = async (req, res) => {
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
            if (!product.purchase_type || !['cash', 'advance', 'credit'].includes(product.purchase_type)) {
                return res.status(400).json({ 
                    message: `Product ${i + 1} must have a valid purchase_type (cash, advance, or credit)` 
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
                if (!product.account_head) {
                    return res.status(400).json({ 
                        message: `Product ${i + 1}: Account Head is required for Full Payment or Partial Payment purchase types` 
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
            const CB = req.body.CB || 'System'; // Created By (user ID or username), default to 'System' if not provided

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
                        `SELECT Balance, name FROM depo WHERE id = ? AND active = 1`,
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
                    const depoName = depoRows[0].name || `Depo ${depoId}`;
                    depoBalances[depoId] = depoBalance;
                    depoNames[depoId] = depoName;
                    const totalCost = depoCosts[depoId];

                    // Check if depo balance is sufficient for credit products
                    if (totalCost > depoBalance) {
                        await connection.rollback();
                        connection.release();
                        return res.status(400).json({ 
                            message: `Total cost (Rs. ${totalCost.toFixed(2)}) for credit products exceeds the depo balance (Rs. ${depoBalance.toFixed(2)}) for depo "${depoName}". ` +
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
            
            // Handle payment transactions per product (account_head is now per product)
            // Process payments for each product with cash or advance purchase type
            if (hasCashOrAdvanceProducts && totalPaidAmount > 0) {
                // Group products by account_head to process payments efficiently
                const productsByAccountHead = {};
                products.forEach((product, index) => {
                    if (product.purchase_type === 'cash' || product.purchase_type === 'advance') {
                        const accountHead = product.account_head;
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
                        
                        // Insert trip_depos entry for this specific product with its product_id
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
                    // Create pool entries directly from depoPurchaseData for credit and advance purchases only
                    // Full payment purchases don't need pool entries since they're fully paid and don't affect credit limit
                    // We need to group by depo_id to calculate total credit/advance amount per depo for pool entry
                    const depoPoolData = {};
                    
                    // Aggregate credit and advance purchases by depo_id for pool entries
                    for (const depoData of Object.values(depoPurchaseData)) {
                        console.log(`Processing depoPurchaseData for pool: depo_id=${depoData.depo_id}, purchase_type=${depoData.purchase_type}, payable_amount=${depoData.payable_amount}`);
                        
                        // Skip cash purchases - they don't affect credit limit
                        if (depoData.purchase_type === 'cash') {
                            console.log(`Skipping cash purchase for depo ${depoData.depo_id} - no pool entry needed`);
                            continue;
                        }
                        
                        const depoId = depoData.depo_id;
                        const payableAmount = parseFloat(depoData.payable_amount || 0);
                        
                        console.log(`Processing credit/advance purchase for pool: depo_id=${depoId}, purchase_type=${depoData.purchase_type}, payable_amount=${payableAmount}`);
                        
                        // Only process if there's a payable amount (credit or advance with remaining balance)
                        if (payableAmount > 0) {
                            if (!depoPoolData[depoId]) {
                                depoPoolData[depoId] = {
                                    depo_id: depoId,
                                    total_payable_amount: 0
                                };
                                console.log(`Initialized pool data for depo ${depoId}`);
                            }
                            // Sum up all payable amounts for this depo (credit + advance purchases)
                            depoPoolData[depoId].total_payable_amount += payableAmount;
                            console.log(`Added payable amount ${payableAmount} to depo ${depoId}. New total: ${depoPoolData[depoId].total_payable_amount}`);
                        } else {
                            console.log(`Skipping depo ${depoId} - payable_amount is 0 or invalid`);
                        }
                    }
                    
                    console.log(`Creating pool entries for ${Object.keys(depoPoolData).length} depo(s) with credit/advance purchases`);
                    if (Object.keys(depoPoolData).length === 0) {
                        console.log('WARNING: No pool entries will be created. Check if all purchases are cash type.');
                    }
                    
                    // Create pool entries for each depo that has credit/advance purchases
                    for (const poolData of Object.values(depoPoolData)) {
                        const depoId = poolData.depo_id;
                        const totalPayableAmount = poolData.total_payable_amount;
                        
                        if (totalPayableAmount > 0) {
                                // Get last depo limit from pool table (previous row's balance)
                            // Get the latest entry regardless of active status to get the current balance
                            // All pool entries are created with active=1
                            // We want the most recent transaction to get the current DepoLimit
                                const [poolRows] = await connection.execute(
                                `SELECT ID, DepoLimit FROM pool WHERE DepoID = ? ORDER BY ID DESC LIMIT 1`,
                                    [depoId]
                                );
                                
                            // Get current depo balance as fallback (initial balance from depo table)
                                const [depoBalanceRows] = await connection.execute(
                                    `SELECT Balance FROM depo WHERE id = ? AND active = 1`,
                                    [depoId]
                                );
                                const currentDepoBalance = depoBalanceRows.length > 0 ? parseFloat(depoBalanceRows[0].Balance || 0) : 0;
                                
                            // Use the latest pool entry's DepoLimit if available, otherwise use depo's initial Balance
                                const previousBalance = poolRows.length > 0 ? parseFloat(poolRows[0].DepoLimit || 0) : currentDepoBalance;
                                
                            console.log(`For depo ${depoId}: Previous pool balance=${previousBalance}, Current depo balance=${currentDepoBalance}`);
                            
                            // For credit/advance purchases, this is a DEBIT (money going out from depo to trip)
                            // Full payment (cash) purchases don't create pool entries - they're fully paid upfront
                                // New DepoLimit = Previous Balance - Total Payable Amount
                                const newDepoLimit = previousBalance - totalPayableAmount;
                                
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
                                    tripInsertId,  // TripID set
                                totalPayableAmount,  // Debit = total payable_amount for this depo (credit/advance only)
                                    newDepoLimit,  // New DepoLimit = Previous Balance - Total Payable
                                    CB
                                ]);
                                
                            console.log(`Successfully inserted pool record for trip ${tripInsertId}, depo ${depoId}: Debit=${totalPayableAmount}, Previous Balance=${previousBalance}, New DepoLimit=${newDepoLimit}`);
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
                t.trip_no,
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
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

// Delete trip
exports.deleteTrip = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { id } = req.body;

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Trip ID is required' });
        }

        await connection.beginTransaction();

        // Check if trip exists and is active
        const [tripRows] = await connection.execute(
            'SELECT id, trip_no FROM trips WHERE id = ? AND Active = 1',
            [id]
        );

        if (tripRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Trip not found or already deleted' });
        }

        const trip = tripRows[0];
        
        // Get depo_ids from trip_depos table for logging
        let depoIds = [];
        try {
            const [depoRows] = await connection.execute(
                'SELECT depo_id FROM trip_depos WHERE trip_id = ? AND Active = 1',
                [id]
            );
            depoIds = depoRows.map(r => r.depo_id);
        } catch (err) {
            console.log('Error getting depo_ids from trip_depos:', err.message);
        }
        
        console.log(`Starting soft delete for trip ${id} (${trip.trip_no}). DepoIDs: ${depoIds.join(', ') || 'N/A'}`);

        // Step 1: Soft delete trips table - set active=0
        await connection.execute(
            'UPDATE trips SET Active = 0, MD = NOW() WHERE id = ? AND Active = 1',
            [id]
        );
        console.log(`Soft deleted trip ${id}`);

        // Step 2: Soft delete trip_products - set active=0 for trip_id
        try {
            const [tripProductsResult] = await connection.execute(
                'UPDATE trip_products SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1',
                [id]
            );
            console.log(`Soft deleted ${tripProductsResult.affectedRows} trip_products record(s)`);
        } catch (err) {
            console.log('Error soft deleting trip_products:', err.message);
        }

        // Step 3: Soft delete pol_sale - set active=0 for trip_id (reduces customer due amount)
        try {
            const [polSaleResult] = await connection.execute(
                'UPDATE pol_sale SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1',
                [id]
            );
            console.log(`Soft deleted ${polSaleResult.affectedRows} pol_sale record(s) for trip_id ${id}`);
        } catch (err) {
            console.log('Error soft deleting pol_sale:', err.message);
        }

        // Step 4: Soft delete trip_depo - set active=0 for trip_id
        try {
            const [tripDepoResult] = await connection.execute(
                'UPDATE trip_depos SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1',
                [id]
            );
            console.log(`Soft deleted ${tripDepoResult.affectedRows} trip_depos record(s)`);
        } catch (err) {
            console.log('Error soft deleting trip_depos:', err.message);
        }

        // Step 5: Soft delete pool table where trip_id and payment_id/recovery_id are NULL
        // Then recalculate balance from previous row forward and update depo balance
        try {
            // Get all pool rows for this trip_id where payment_id and recovery_id are NULL (active = 1)
            const [poolRowsToSoftDelete] = await connection.execute(
                'SELECT ID, DepoID FROM pool WHERE TripID = ? AND payment_id IS NULL AND recovery_id IS NULL AND active = 1',
                [id]
            );

            if (poolRowsToSoftDelete.length > 0) {
                // Get the minimum ID to find the first row to start recalculation from
                const minId = Math.min(...poolRowsToSoftDelete.map(r => r.ID));
                const poolDepoIds = [...new Set(poolRowsToSoftDelete.map(r => r.DepoID))];

                // Soft delete these pool rows
                const [poolSoftDeleteResult] = await connection.execute(
                    'UPDATE pool SET active = 0, MD = NOW() WHERE TripID = ? AND payment_id IS NULL AND recovery_id IS NULL AND active = 1',
                    [id]
                );
                console.log(`Soft deleted ${poolSoftDeleteResult.affectedRows} pool record(s) for trip_id ${id}`);

                // Recalculate balances for each affected depo
                for (const poolDepoId of poolDepoIds) {
                    const finalBalance = await recalculatePoolBalancesFromRow(connection, poolDepoId, minId);
                    if (finalBalance !== null) {
                        await connection.execute(
                            'UPDATE depo SET Balance = ?, MD = NOW() WHERE id = ?',
                            [finalBalance, poolDepoId]
                        );
                        console.log(`Updated depo ${poolDepoId} balance to ${finalBalance}`);
                    }
                }
            }
        } catch (err) {
            console.log('Error handling pool soft delete for trip_id only:', err.message);
            console.error('Error stack:', err.stack);
        }

        // Step 6: Soft delete payments - set active=0 for trip_id
        try {
            const [paymentsResult] = await connection.execute(
                'UPDATE payments SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1',
                [id]
            );
            console.log(`Soft deleted ${paymentsResult.affectedRows} payment record(s)`);
        } catch (err) {
            console.log('Error soft deleting payments:', err.message);
        }

        // Step 7: Soft delete pool table where trip_id and payment_id (recovery_id should be NULL)
        // Recalculate balance and subtract sum of credits from depo balance
        try {
            // Get payment IDs for this trip
            const [paymentRows] = await connection.execute(
                'SELECT ID FROM payments WHERE trip_id = ? AND Active = 0',
                [id]
            );

            if (paymentRows.length > 0) {
                const paymentIds = paymentRows.map(p => p.ID);

                for (const paymentId of paymentIds) {
                    // Get pool rows for this trip_id and payment_id (where recovery_id is NULL, active = 1)
                    const [poolPaymentRows] = await connection.execute(
                        'SELECT ID, DepoID, Credit FROM pool WHERE TripID = ? AND payment_id = ? AND recovery_id IS NULL AND active = 1',
                        [id, paymentId]
                    );

                    if (poolPaymentRows.length > 0) {
                        const minPoolId = Math.min(...poolPaymentRows.map(r => r.ID));
                        const poolDepoIds = [...new Set(poolPaymentRows.map(r => r.DepoID))];
                        const totalCredits = poolPaymentRows.reduce((sum, r) => sum + (parseFloat(r.Credit) || 0), 0);

                        // Soft delete these pool rows
                        const [poolPaymentDeleteResult] = await connection.execute(
                            'UPDATE pool SET active = 0, MD = NOW() WHERE TripID = ? AND payment_id = ? AND recovery_id IS NULL AND active = 1',
                            [id, paymentId]
                        );
                        console.log(`Soft deleted ${poolPaymentDeleteResult.affectedRows} pool record(s) for trip_id ${id} and payment_id ${paymentId}`);

                        // Recalculate balances for each affected depo
                        for (const poolDepoId of poolDepoIds) {
                            const finalBalance = await recalculatePoolBalancesFromRow(connection, poolDepoId, minPoolId);
                            if (finalBalance !== null) {
                                // Subtract total credits from depo balance
                                await connection.execute(
                                    'UPDATE depo SET Balance = Balance - ?, MD = NOW() WHERE id = ?',
                                    [totalCredits, poolDepoId]
                                );
                                console.log(`Updated depo ${poolDepoId} balance: subtracted ${totalCredits} credits`);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.log('Error handling pool soft delete for trip_id and payment_id:', err.message);
            console.error('Error stack:', err.stack);
        }

        // Step 8: Soft delete recoveries associated with this trip
        try {
            const [recoveriesResult] = await connection.execute(
                'UPDATE recoveries SET Active = 0, MD = NOW() WHERE trip_id = ? AND Active = 1',
                [id]
            );
            console.log(`Soft deleted ${recoveriesResult.affectedRows} recovery record(s) for trip_id ${id}`);
        } catch (err) {
            console.log('Error soft deleting recoveries:', err.message);
        }

        // Step 9: Reverse transactions in cash_in_hand and accounts tables
        // Directly get all cash_in_hand_ids and accountids from transactions with this trip_id
        console.log(`\n========== STEP 9: Processing cash_in_hand and accounts for trip_id ${id} ==========`);
        try {
            // Method 1: Get all transactions directly linked to this trip_id
            console.log(`\n[LOG] Method 1: Querying transactions table for trip_id = ${id}`);
            const [allTripTransactions] = await connection.execute(
                'SELECT ID, AccountID, cash_in_hand_id, Credit, Debit, active FROM transactions WHERE trip_id = ?',
                [id]
            );
            
            console.log(`[LOG] Found ${allTripTransactions.length} transaction(s) directly linked to trip_id ${id}`);
            if (allTripTransactions.length > 0) {
                console.log(`[LOG] Direct trip transactions details:`, JSON.stringify(allTripTransactions, null, 2));
            }
            
            // Method 2: Also get transactionIDs from payments and recoveries tables
            console.log(`\n[LOG] Method 2: Querying payments table for trip_id = ${id}`);
            const [paymentTransactionRows] = await connection.execute(
                'SELECT DISTINCT transactionID FROM payments WHERE trip_id = ? AND transactionID IS NOT NULL',
                [id]
            );
            console.log(`[LOG] Found ${paymentTransactionRows.length} payment transactionID(s):`, paymentTransactionRows.map(r => r.transactionID));
            
            console.log(`\n[LOG] Method 2: Querying recoveries table for trip_id = ${id}`);
            const [recoveryTransactionRows] = await connection.execute(
                'SELECT DISTINCT transactionID FROM recoveries WHERE trip_id = ? AND transactionID IS NOT NULL',
                [id]
            );
            console.log(`[LOG] Found ${recoveryTransactionRows.length} recovery transactionID(s):`, recoveryTransactionRows.map(r => r.transactionID));
            
            // Get additional transactions from payments/recoveries that might not have trip_id set
            const additionalTransactionIds = [
                ...paymentTransactionRows.map(r => r.transactionID),
                ...recoveryTransactionRows.map(r => r.transactionID)
            ];
            
            let additionalTransactions = [];
            if (additionalTransactionIds.length > 0) {
                console.log(`\n[LOG] Querying transactions table for additional transaction IDs: ${additionalTransactionIds.join(', ')}`);
                const placeholders = additionalTransactionIds.map(() => '?').join(',');
                const [additionalRows] = await connection.execute(
                    `SELECT ID, AccountID, cash_in_hand_id, Credit, Debit, active FROM transactions WHERE ID IN (${placeholders})`,
                    additionalTransactionIds
                );
                additionalTransactions = additionalRows;
                console.log(`[LOG] Found ${additionalTransactions.length} additional transaction(s) from payments/recoveries`);
                if (additionalTransactions.length > 0) {
                    console.log(`[LOG] Additional transactions details:`, JSON.stringify(additionalTransactions, null, 2));
                }
            }
            
            // Combine all transactions
            const allTransactions = [...allTripTransactions, ...additionalTransactions];
            console.log(`\n[LOG] Combined total transactions before deduplication: ${allTransactions.length}`);
            
            // Remove duplicates by transaction ID
            const uniqueTransactions = Array.from(
                new Map(allTransactions.map(t => [t.ID, t])).values()
            );
            
            console.log(`[LOG] Total unique transactions after deduplication: ${uniqueTransactions.length}`);
            console.log(`[LOG] Unique transaction IDs:`, uniqueTransactions.map(t => t.ID).join(', '));
            
            // Collect unique cash_in_hand_ids and accountids
            const cashInHandIds = new Set();
            const accountIds = new Set();
            
            console.log(`\n[LOG] Processing each transaction to collect cash_in_hand_ids and accountids:`);
            for (const transaction of uniqueTransactions) {
                const accountID = transaction.AccountID;
                const cashInHandId = transaction.cash_in_hand_id;
                const credit = parseFloat(transaction.Credit) || 0;
                const debit = parseFloat(transaction.Debit) || 0;
                const isActive = transaction.active === 1 || transaction.active === true;

                console.log(`\n[LOG] Processing transaction ID: ${transaction.ID}`);
                console.log(`  - AccountID: ${accountID || 'NULL'}`);
                console.log(`  - cash_in_hand_id: ${cashInHandId || 'NULL'}`);
                console.log(`  - Credit: ${credit}`);
                console.log(`  - Debit: ${debit}`);
                console.log(`  - Active: ${isActive}`);

                // Soft delete transaction only if it's still active
                if (isActive) {
                    await connection.execute(
                        'UPDATE transactions SET active = 0, MD = NOW() WHERE ID = ? AND active = 1',
                        [transaction.ID]
                    );
                    console.log(`  [LOG] ✓ Soft deleted transaction ${transaction.ID}`);
                } else {
                    console.log(` Transaction ${transaction.ID} is already inactive, skipping soft delete`);
                }

                // Collect cash_in_hand_ids (regardless of transaction active status)
                if (cashInHandId) {
                    cashInHandIds.add(cashInHandId);
                    console.log(`  [LOG] ✓ Collected cash_in_hand_id: ${cashInHandId} from transaction ${transaction.ID} (transaction was active: ${isActive})`);
                } else {
                    console.log(`  [LOG] - No cash_in_hand_id in transaction ${transaction.ID}`);
                }

                // Collect accountids and adjust account balance (only for active transactions)
                if (accountID && isActive) {
                    accountIds.add(accountID);
                    // Reverse the transaction effect:
                    // - Subtract credits (money that came in)
                    // - Add back debits (money that went out)
                    if (credit > 0 || debit > 0) {
                        // Update account balance: Balance = Balance - Credit + Debit
                        await connection.execute(
                            'UPDATE accounts SET Balance = Balance - ? + ?, MD = NOW() WHERE ID = ? AND Active = 1',
                            [credit, debit, accountID]
                        );
                        console.log(`  [LOG] ✓ Adjusted account ${accountID} balance: subtracted ${credit} credit, added ${debit} debit`);
                    }
                } else if (accountID && !isActive) {
                    console.log(`  [LOG] - AccountID ${accountID} found but transaction is inactive, skipping account adjustment`);
                }
            }
            
            console.log(`\n[LOG] Summary of collected IDs:`);
            console.log(`  - Total unique cash_in_hand_ids collected: ${cashInHandIds.size}`);
            console.log(`  - cash_in_hand_ids: [${Array.from(cashInHandIds).join(', ')}]`);
            console.log(`  - Total unique accountids collected: ${accountIds.size}`);
            console.log(`  - accountids: [${Array.from(accountIds).join(', ')}]`);
            
            // Set active=0 for all unique cash_in_hand_ids
            if (cashInHandIds.size > 0) {
                const cashInHandIdsArray = Array.from(cashInHandIds);
                const cashPlaceholders = cashInHandIdsArray.map(() => '?').join(',');
                
                console.log(`\n[LOG] ===== SOFT DELETING cash_in_hand RECORDS =====`);
                console.log(`[LOG] Attempting to soft delete cash_in_hand records with IDs: ${cashInHandIdsArray.join(', ')}`);
                
                // Check status before deletion
                console.log(`[LOG] Checking cash_in_hand records status BEFORE deletion:`);
                const [beforeCheckRows] = await connection.execute(
                    `SELECT id, Active, credit, debit, balance FROM cash_in_hand WHERE id IN (${cashPlaceholders})`,
                    cashInHandIdsArray
                );
                console.log(`[LOG] Before deletion - cash_in_hand records:`, JSON.stringify(beforeCheckRows, null, 2));
                
                const [cashInHandResult] = await connection.execute(
                    `UPDATE cash_in_hand SET Active = 0, MD = NOW() WHERE id IN (${cashPlaceholders}) AND Active = 1`,
                    cashInHandIdsArray
                );
                console.log(`[LOG] ✓ Soft deleted ${cashInHandResult.affectedRows} cash_in_hand record(s) with IDs: ${cashInHandIdsArray.join(', ')}`);
                
                // Check status after deletion
                console.log(`[LOG] Checking cash_in_hand records status AFTER deletion:`);
                const [afterCheckRows] = await connection.execute(
                    `SELECT id, Active, credit, debit, balance FROM cash_in_hand WHERE id IN (${cashPlaceholders})`,
                    cashInHandIdsArray
                );
                console.log(`[LOG] After deletion - cash_in_hand records:`, JSON.stringify(afterCheckRows, null, 2));
                
                if (cashInHandResult.affectedRows === 0) {
                    console.warn(`[LOG] ⚠ WARNING: No cash_in_hand records were updated. IDs attempted: ${cashInHandIdsArray.join(', ')}`);
                    console.log(`[LOG] All requested IDs may already be inactive or do not exist.`);
                } else if (cashInHandResult.affectedRows < cashInHandIdsArray.length) {
                    console.warn(`[LOG] ⚠ WARNING: Only ${cashInHandResult.affectedRows} out of ${cashInHandIdsArray.length} cash_in_hand records were updated.`);
                }
                
                // Recalculate all cash_in_hand balances
                console.log(`\n[LOG] Recalculating all cash_in_hand balances...`);
                await recalculateAllBalances(connection);
                console.log(`[LOG] ✓ Completed recalculation of cash_in_hand balances`);
            } else {
                console.log(`\n[LOG] No cash_in_hand_ids found to soft delete`);
            }
            
            // Set active=0 for all unique accountids
            if (accountIds.size > 0) {
                const accountIdsArray = Array.from(accountIds);
                const accountPlaceholders = accountIdsArray.map(() => '?').join(',');
                const [accountResult] = await connection.execute(
                    `UPDATE accounts SET Active = 0, MD = NOW() WHERE ID IN (${accountPlaceholders}) AND Active = 1`,
                    accountIdsArray
                );
                console.log(`Soft deleted ${accountResult.affectedRows} account record(s): ${accountIdsArray.join(', ')}`);
            }
        } catch (err) {
            console.log('Error reversing transactions in cash_in_hand and accounts:', err.message);
            console.error('Error stack:', err.stack);
        }

        // Commit all changes
        console.log(`\n========== COMMITTING ALL CHANGES FOR TRIP ${id} ==========`);
        await connection.commit();
        connection.release();

        console.log(`\n========== TRIP DELETION COMPLETE ==========`);
        console.log(`[LOG] ✓ Successfully soft deleted trip ${id} (${trip.trip_no}) and all related records`);
        console.log(`[LOG] Summary of operations:`);
        console.log(`  - Trip: soft deleted`);
        console.log(`  - trip_products: soft deleted`);
        console.log(`  - pol_sale: soft deleted`);
        console.log(`  - trip_depos: soft deleted`);
        console.log(`  - pool: soft deleted and balances recalculated`);
        console.log(`  - payments: soft deleted`);
        console.log(`  - recoveries: soft deleted`);
        console.log(`  - transactions: soft deleted`);
        console.log(`  - cash_in_hand: soft deleted and balances recalculated`);
        console.log(`  - accounts: soft deleted and balances adjusted`);
        console.log(`==========================================\n`);
        
        res.json({ 
            message: 'Trip and all related records soft deleted successfully',
            deleted: {
                trip: true,
                trip_products: true,
                pol_sale: true,
                trip_depos: true,
                pool: true,
                payments: true,
                recoveries: true,
                transactions: true,
                cash_in_hand: true,
                accounts: true
            }
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error deleting trip:', err);
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

// Get remaining amount for a depo (payable_amount - paid_amount)
exports.getDepoRemainingAmount = async (req, res) => {
    try {
        const depoId = req.query.depoId;
        
        if (!depoId) {
            return res.status(400).json({ message: 'Depo ID is required' });
        }

        // Calculate remaining amount from pool table (same logic as dashboard):
        // Remaining = Initial Limit - Current Limit (which is the used amount)
        // This shows how much credit has been used from the depo, matching the dashboard "USED" column
        const query = `
            SELECT 
                COALESCE((SELECT p.DepoLimit 
                          FROM pool p 
                          WHERE p.DepoID = ? 
                            AND p.TripID IS NULL 
                            AND p.recovery_id IS NULL 
                            AND p.payment_id IS NULL 
                            AND p.active = 1 
                          ORDER BY p.ID ASC 
                          LIMIT 1), 
                         (SELECT d.Balance FROM depo d WHERE d.id = ? AND d.active = 1), 0) as InitialLimit,
                COALESCE((SELECT p.DepoLimit 
                          FROM pool p 
                          WHERE p.DepoID = ? 
                            AND p.active = 1 
                          ORDER BY p.ID DESC 
                          LIMIT 1), 
                         (SELECT d.Balance FROM depo d WHERE d.id = ? AND d.active = 1), 0) as CurrentLimit
        `;
        
        const [rows] = await db.execute(query, [depoId, depoId, depoId, depoId]);
        const initialLimit = parseFloat(rows[0]?.InitialLimit || 0);
        const currentLimit = parseFloat(rows[0]?.CurrentLimit || 0);
        
        // Remaining amount = Initial Limit - Current Limit (amount used/owed)
        // This matches the "USED" calculation in the dashboard
        const remainingAmount = initialLimit - currentLimit;
        
        console.log(`Depo ${depoId}: InitialLimit=${initialLimit}, CurrentLimit=${currentLimit}, RemainingAmount=${remainingAmount}`);
        
        res.json({ remainingAmount: remainingAmount });
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
                t.trip_no,
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
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

        const CB = req.body.CB || 'System'; // Created By (user ID or username), default to 'System' if not provided

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
        
        console.log('Received sale data:', req.body);
        
        const {
            trip_id,
            trip_product_id,
            client_id,
            Qty,
            capacity,
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
                // For Can/Drum, Qty should be whole number >= 500
                if (qty < 500) {
                    await connection.rollback();
                    return res.status(400).json({
                        message: 'Quantity must be at least 500 for Can/Drum'
                    });
                }
                if (qty > availableQuantity) {
                    await connection.rollback();
                    return res.status(400).json({
                        message: `Insufficient quantity available. Available: ${availableQuantity.toFixed(2)} liters, Requested: ${qty.toFixed(2)} liters`
                    });
                }
            }
        }

        // Insert into pol_sale table with new structure
        const insertQuery = `
            INSERT INTO pol_sale (
                trip_id, trip_product_id, client_id, Qty, container_type, capacity, fuel, rate, 
                Discount, total_amount, date, Active, CD, MD, CB
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW(), ?)
        `;
        
        // Get CB (Created By) from request body, default to 'System' if not provided
        const CB = req.body.CB || 'System';

        const queryParams = [
            trip_id,
            trip_product_id,
            client_id,
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
        
        console.log('Add Sale - Query parameters:', JSON.stringify(queryParams, null, 2));

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
        
        // Check if trip should be closed (all payments cleared and all fuel sold)
        await checkAndCloseTrip(connection, trip_id);
        
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
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
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
                ps.Qty,
                ps.capacity,
                ps.fuel,
                ps.rate,
                ps.Discount,
                ps.total_amount,
                ps.date,
                ps.container_type,
                c.name as client_name
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
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
                tp.product_type as fuel_type
            FROM pol_sale ps
            LEFT JOIN customers c ON ps.client_id = c.id AND c.active = 1
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

