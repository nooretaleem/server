const db = require('../models/db');

// Get all meter readings
exports.getMeterReadings = async (req, res) => {
    try {
        const customerId = req.query.customer_id || req.query.station_id;
        const meterId = req.query.meter_id;
        const readingDate = req.query.reading_date;
        const shift = req.query.shift;
        
        let query = `
            SELECT 
                mr.id,
                mr.customer_id,
                mr.meter_id,
                mr.reading_date,
                mr.shift,
                mr.old_a,
                mr.new_a,
                mr.sale_a,
                mr.old_b,
                mr.new_b,
                mr.sale_b,
                mr.CB,
                mr.CD,
                mr.MB,
                mr.MD,
                mr.Active,
                c.name as station_name,
                m.meter_no,
                ft.name as fuel_type_name
            FROM meter_readings mr
            LEFT JOIN customers c ON mr.customer_id = c.id
            LEFT JOIN meters m ON mr.meter_id = m.id
            LEFT JOIN fuel_types ft ON m.fuel_type_id = ft.id
            WHERE mr.Active = 1
        `;
        const params = [];
        
        if (customerId) {
            query += ' AND mr.customer_id = ?';
            params.push(customerId);
        }
        if (meterId) {
            query += ' AND mr.meter_id = ?';
            params.push(meterId);
        }
        if (readingDate) {
            query += ' AND mr.reading_date = ?';
            params.push(readingDate);
        }
        if (shift !== undefined && shift !== null) {
            // Handle NULL shifts - treat as Opening
            if (shift === 'NULL' || shift === 'null') {
                query += ' AND (mr.shift IS NULL OR mr.shift = \'Opening\')';
            } else {
                query += ' AND mr.shift = ?';
                params.push(shift);
            }
        }
        query += ' ORDER BY mr.reading_date DESC, mr.shift, c.name, m.meter_no';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching meter readings:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get latest meter reading per meter for a station (for old_a/old_b when entering new readings)
exports.getLatestMeterReadings = async (req, res) => {
    try {
        const customerId = req.query.customer_id || req.query.station_id;
        if (!customerId) {
            return res.status(400).json({ message: 'customer_id or station_id is required' });
        }
        const query = `
            SELECT meter_id, new_a, new_b
            FROM (
                SELECT mr.meter_id, mr.new_a, mr.new_b,
                       ROW_NUMBER() OVER (PARTITION BY mr.meter_id ORDER BY mr.reading_date DESC, mr.CD DESC) as rn
                FROM meter_readings mr
                WHERE mr.customer_id = ? AND mr.Active = 1
            ) t
            WHERE rn = 1
        `;
        const [rows] = await db.execute(query, [customerId]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching latest meter readings:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single meter reading by ID
exports.getMeterReading = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Meter Reading ID is required' });
        }

        const query = `
            SELECT 
                mr.id,
                mr.customer_id,
                mr.customer_id as station_id,
                mr.meter_id,
                mr.reading_date,
                mr.shift,
                mr.old_a,
                mr.new_a,
                mr.sale_a,
                mr.old_b,
                mr.new_b,
                mr.sale_b,
                mr.CB,
                mr.CD,
                mr.MB,
                mr.MD,
                mr.Active,
                c.name as station_name,
                m.meter_no,
                ft.name as fuel_type_name
            FROM meter_readings mr
            LEFT JOIN customers c ON mr.customer_id = c.id
            LEFT JOIN meters m ON mr.meter_id = m.id
            LEFT JOIN fuel_types ft ON m.fuel_type_id = ft.id
            WHERE mr.id = ? AND mr.Active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching meter reading:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new meter reading
exports.addMeterReading = async (req, res) => {
    try {
        const {
            station_id,
            customer_id,
            meter_id,
            reading_date,
            shift,
            old_a,
            new_a,
            sale_a,
            old_b,
            new_b,
            sale_b
        } = req.body;

        const resolvedCustomerId = customer_id ?? station_id;

        if (!resolvedCustomerId) {
            return res.status(400).json({ message: 'Station (customer) ID is required' });
        }
        if (!meter_id) {
            return res.status(400).json({ message: 'Meter ID is required' });
        }
        // Ensure meter exists and is assigned to a fuel type and same station (customer)
        const meterQuery = `
            SELECT customer_id, fuel_type_id 
            FROM meters 
            WHERE id = ? AND Active = 1
        `;
        const [meterRows] = await db.execute(meterQuery, [meter_id]);
        if (meterRows.length === 0) {
            return res.status(400).json({ message: 'Meter is not active or does not exist' });
        }
        const meter = meterRows[0];
        if (!meter.fuel_type_id) {
            return res.status(400).json({ message: 'Meter is not assigned to a fuel type/UST' });
        }
        if (meter.customer_id !== resolvedCustomerId) {
            return res.status(400).json({ message: 'Meter does not belong to the selected station (customer)' });
        }
        if (!reading_date) {
            return res.status(400).json({ message: 'Reading date is required' });
        }
        if (!shift) {
            return res.status(400).json({ message: 'Shift is required' });
        }

        // Check for duplicate reading (same station, meter, date, and shift)
        const checkQuery = `
            SELECT id FROM meter_readings 
            WHERE customer_id = ? AND meter_id = ? AND reading_date = ? AND shift = ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [resolvedCustomerId, meter_id, reading_date, shift]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Meter reading already exists for this station, meter, date, and shift' 
            });
        }

        // Allow Opening, Morning, Evening
        if (shift !== 'Opening' && shift !== 'Morning' && shift !== 'Evening') {
            return res.status(400).json({ message: 'Shift must be Opening, Morning, or Evening' });
        }

        // First reading: if no prior row for this meter at this station, use Opening and no sales
        const [priorRows] = await db.execute(
            `SELECT id FROM meter_readings WHERE customer_id = ? AND meter_id = ? AND Active = 1 LIMIT 1`,
            [resolvedCustomerId, meter_id]
        );
        const isFirstReading = priorRows.length === 0;
        const finalShift = isFirstReading ? 'Opening' : shift;
        const finalSaleA = isFirstReading ? 0 : (sale_a != null ? parseFloat(sale_a) : null);
        const finalSaleB = isFirstReading ? 0 : (sale_b != null ? parseFloat(sale_b) : null);

        // Get CB (Created By) from request body - required, no default to 'System'
        const CB = req.body.CB;
        if (!CB) {
            return res.status(400).json({ message: 'CB (Created By - username) is required' });
        }

        const query = `
            INSERT INTO meter_readings (
                customer_id, meter_id, reading_date, shift,
                old_a, new_a, sale_a, old_b, new_b, sale_b,
                active, CB, CD, MD
            ) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [
            resolvedCustomerId,
            meter_id,
            reading_date,
            finalShift,
            old_a || null,
            new_a || null,
            finalSaleA,
            old_b || null,
            new_b || null,
            finalSaleB,
            CB
        ]);

        // Tank stock will be updated in batch after all meter readings are saved
        // See updateTankStockFromReadings() function

        res.json({
            message: 'Meter reading added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding meter reading:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'meter_readings table does not exist. Please create the table first.' });
        } else if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Meter reading already exists for this station, meter, date, and shift' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update meter reading
exports.updateMeterReading = async (req, res) => {
    try {
        const {
            id,
            station_id,
            customer_id,
            meter_id,
            reading_date,
            shift,
            old_a,
            new_a,
            sale_a,
            old_b,
            new_b,
            sale_b,
            Active,
            active
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Meter Reading ID is required' });
        }
        const resolvedCustomerId = customer_id ?? station_id;

        if (!resolvedCustomerId) {
            return res.status(400).json({ message: 'Station (customer) ID is required' });
        }
        if (!meter_id) {
            return res.status(400).json({ message: 'Meter ID is required' });
        }
        if (!reading_date) {
            return res.status(400).json({ message: 'Reading date is required' });
        }
        if (!shift) {
            return res.status(400).json({ message: 'Shift is required' });
        }

        // Check for duplicate reading (excluding current record)
        const checkQuery = `
            SELECT id FROM meter_readings 
            WHERE customer_id = ? AND meter_id = ? AND reading_date = ? AND shift = ? 
            AND id != ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [resolvedCustomerId, meter_id, reading_date, shift, id]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Meter reading already exists for this station, meter, date, and shift' 
            });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        // Get MB (Modified By) from request body - required, no default to 'System'
        const MB = req.body.MB;
        if (!MB) {
            return res.status(400).json({ message: 'MB (Modified By - username) is required' });
        }

        // Verify the meter reading exists and get its current values
        const [existingReadingRows] = await db.execute(
            `SELECT id, customer_id, meter_id, reading_date, shift FROM meter_readings WHERE id = ? AND Active = 1`,
            [id]
        );
        
        if (existingReadingRows.length === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }

        const existingReading = existingReadingRows[0];
        
        // CRITICAL: Prevent editing if stock has been finalized
        // Check if tank stock exists for this meter's tank, date, and shift
        // This prevents data corruption after stock is calculated
        
        // Get meter info to find fuel_type_id and tank
        const [meterRows] = await db.execute(
            `SELECT fuel_type_id FROM meters WHERE id = ? AND Active = 1`,
            [meter_id]
        );
        
        if (meterRows.length > 0 && meterRows[0].fuel_type_id) {
            // Find the tank for this meter
            const [tankRows] = await db.execute(
                `SELECT id FROM station_tanks 
                 WHERE customer_id = ? AND fuel_type_id = ? AND active = 1
                 LIMIT 1`,
                [resolvedCustomerId, meterRows[0].fuel_type_id]
            );
            
            if (tankRows.length > 0) {
                const tank_id = tankRows[0].id;
                
                // Check if stock exists for the CURRENT reading's date/shift (before any changes)
                // Use the existing reading's date/shift, not the new values from request
                const [stockCheckRows] = await db.execute(
                    `SELECT id FROM station_tank_stock 
                     WHERE tank_id = ? AND stock_date = ? AND shift = ? AND Active = 1
                     LIMIT 1`,
                    [tank_id, existingReading.reading_date, existingReading.shift]
                );
                
                if (stockCheckRows.length > 0) {
                    return res.status(400).json({ 
                        message: 'Meter reading cannot be edited after tank stock has been finalized for this date and shift. Please contact an administrator to make corrections.',
                        code: 'STOCK_FINALIZED',
                        stock_exists: true
                    });
                }
                
                // Also check if user is trying to change date or shift to one that has stock
                // This prevents moving a reading to a finalized period
                if (reading_date !== existingReading.reading_date || shift !== existingReading.shift) {
                    const [newStockCheckRows] = await db.execute(
                        `SELECT id FROM station_tank_stock 
                         WHERE tank_id = ? AND stock_date = ? AND shift = ? AND Active = 1
                         LIMIT 1`,
                        [tank_id, reading_date, shift]
                    );
                    
                    if (newStockCheckRows.length > 0) {
                        return res.status(400).json({ 
                            message: 'Cannot change reading date/shift to a period where tank stock has already been finalized.',
                            code: 'TARGET_STOCK_FINALIZED',
                            stock_exists: true
                        });
                    }
                }
            }
        }

        const query = `
            UPDATE meter_readings SET 
                customer_id = ?,
                meter_id = ?,
                reading_date = ?,
                shift = ?,
                old_a = ?,
                new_a = ?,
                sale_a = ?,
                old_b = ?,
                new_b = ?,
                sale_b = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            resolvedCustomerId,
            meter_id,
            reading_date,
            shift,
            old_a || null,
            new_a || null,
            sale_a || null,
            old_b || null,
            new_b || null,
            sale_b || null,
            activeValue ? 1 : 0,
            MB,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }

        // IMPORTANT: Tank stock is NOT updated here during individual meter reading updates.
        // This prevents race conditions and incorrect balances when multiple meter readings
        // are updated simultaneously. Tank stock must be updated ONLY via batch aggregation
        // using updateTankStockFromReadings(), which recalculates from scratch by summing
        // all meter readings. This ensures consistency and correctness.
        // 
        // The frontend should call updateTankStockFromReadings() after all meter readings
        // are saved/updated to ensure tank stock reflects the correct aggregated totals.

        res.json({ message: 'Meter reading updated successfully' });
    } catch (err) {
        console.error('Error updating meter reading:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Meter reading already exists for this station, meter, date, and shift' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update tank stock from meter readings (batch operation)
// This should be called AFTER all meter readings for a date/shift are saved
// Groups by tank_id, reading_date, shift and sums the sales
exports.updateTankStockFromReadings = async (req, res) => {
    try {
        const { customer_id, reading_date, shift } = req.body;
        
        if (!customer_id || !reading_date || !shift) {
            return res.status(400).json({ 
                message: 'Customer ID, reading date, and shift are required' 
            });
        }
        
        console.log(`[Tank Stock Batch] Updating tank stock for customer ${customer_id}, date ${reading_date}, shift ${shift}`);
        
        // Step 1: Sum sales for each tank/date/shift combination
        // For each meter reading, take max(sale_a, sale_b), then sum across all meters for the same tank
        const salesQuery = `
            SELECT 
                st.id as tank_id,
                st.tank_label,
                mr.reading_date,
                mr.shift,
                SUM(GREATEST(COALESCE(mr.sale_a, 0), COALESCE(mr.sale_b, 0))) as total_sold
            FROM meter_readings mr
            INNER JOIN meters m ON mr.meter_id = m.id
            INNER JOIN station_tanks st ON st.customer_id = m.customer_id 
                                        AND st.fuel_type_id = m.fuel_type_id 
                                        AND st.active = 1
            WHERE mr.customer_id = ? 
              AND mr.reading_date = ? 
              AND mr.shift = ?
              AND mr.shift IN ('Morning', 'Evening')
              AND mr.Active = 1
              AND (mr.sale_a IS NOT NULL OR mr.sale_b IS NOT NULL)
            GROUP BY st.id, st.tank_label, mr.reading_date, mr.shift
        `;
        
        const [salesRows] = await db.execute(salesQuery, [customer_id, reading_date, shift]);
        
        if (salesRows.length === 0) {
            console.log(`[Tank Stock Batch] No sales found for customer ${customer_id}, date ${reading_date}, shift ${shift}`);
            return res.json({ 
                message: 'No sales found to update tank stock',
                updated: 0 
            });
        }
        
        console.log(`[Tank Stock Batch] Found ${salesRows.length} tank(s) with sales`);
        
        // Step 2: Insert or update ONE stock record per tank/date/shift
        let updatedCount = 0;
        
        for (const saleRow of salesRows) {
            const tank_id = saleRow.tank_id;
            const tank_label = saleRow.tank_label;
            const totalSold = parseFloat(saleRow.total_sold || 0);
            
            if (totalSold <= 0) {
                console.log(`[Tank Stock Batch] Skipping tank ${tank_id} (${tank_label}) - no sales`);
                continue;
            }
            
            // Check if stock record exists
            const [existingStockRows] = await db.execute(
                `SELECT id, opening_stock, received_qty, sold_qty, adjustment_qty, closing_stock
                 FROM station_tank_stock 
                 WHERE tank_id = ? AND stock_date = ? AND shift = ? AND Active = 1
                 LIMIT 1`,
                [tank_id, reading_date, shift]
            );
            
            if (existingStockRows.length > 0) {
                // Update existing record
                const existing = existingStockRows[0];
                const newSoldQty = totalSold; // Use the calculated total, not accumulate
                const newClosingStock = parseFloat(existing.opening_stock || 0) + 
                                       parseFloat(existing.received_qty || 0) - 
                                       newSoldQty + 
                                       parseFloat(existing.adjustment_qty || 0);
                
                // Get MB (Modified By) from request body for updates
                const MB = req.body.CB || req.body.MB; // Use CB as MB if MB not provided
                if (!MB) {
                    return res.status(400).json({ message: 'MB (Modified By - username) is required for stock update' });
                }
                
                await db.execute(
                    `UPDATE station_tank_stock SET 
                        sold_qty = ?,
                        closing_stock = ?,
                        MB = ?,
                        MD = NOW()
                    WHERE id = ?`,
                    [newSoldQty, newClosingStock, MB, existing.id]
                );
                
                console.log(`[Tank Stock Batch] ✓ Updated tank ${tank_id} (${tank_label}): Sold=${newSoldQty}L, Balance=${newClosingStock}L`);
            } else {
                // Create new record - get latest stock to use as opening_stock
                const [latestStockRows] = await db.execute(
                    `SELECT closing_stock FROM station_tank_stock
                     WHERE tank_id = ? AND Active = 1
                     ORDER BY stock_date DESC, 
                              CASE shift 
                                  WHEN 'Evening' THEN 2 
                                  WHEN 'Morning' THEN 1 
                                  ELSE 0 
                              END DESC
                     LIMIT 1`,
                    [tank_id]
                );
                
                const opening_stock = latestStockRows.length > 0 ? parseFloat(latestStockRows[0].closing_stock) : 0;
                const closing_stock = opening_stock - totalSold;
                // Get CB (Created By) from request body - required, no default to 'System'
                const CB = req.body.CB;
                if (!CB) {
                    return res.status(400).json({ message: 'CB (Created By) is required for update' });
                }
                
                await db.execute(
                    `INSERT INTO station_tank_stock (
                        tank_id, stock_date, shift,
                        opening_stock, received_qty, sold_qty, adjustment_qty, closing_stock,
                        Active, CB, CD, MD
                    ) 
                    VALUES (?, ?, ?, ?, 0, ?, 0, ?, 1, ?, NOW(), NOW())`,
                    [tank_id, reading_date, shift, opening_stock, totalSold, closing_stock, CB]
                );
                
                console.log(`[Tank Stock Batch] ✓ Created stock record for tank ${tank_id} (${tank_label}): Sold=${totalSold}L, Balance=${closing_stock}L`);
            }
            
            updatedCount++;
        }
        
        res.json({
            message: `Tank stock updated successfully for ${updatedCount} tank(s)`,
            updated: updatedCount
        });
        
    } catch (err) {
        console.error('[Tank Stock Batch] Error updating tank stock from readings:', err);
        res.status(500).json({ 
            message: 'Server Error', 
            error: err.message 
        });
    }
};

// Delete meter reading (soft delete - set Active=0)
exports.deleteMeterReading = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Meter Reading ID is required' });
        }

        // Get the reading details before deletion to check stock status
        const [readingRows] = await db.execute(
            `SELECT customer_id, meter_id, reading_date, shift FROM meter_readings WHERE id = ? AND Active = 1`,
            [id]
        );
        
        if (readingRows.length === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }

        const reading = readingRows[0];
        const customerId = reading.customer_id;
        
        // CRITICAL: Prevent deletion if stock has been finalized
        // Get meter info to find fuel_type_id and tank
        const [meterRows] = await db.execute(
            `SELECT fuel_type_id FROM meters WHERE id = ? AND Active = 1`,
            [reading.meter_id]
        );
        
        if (meterRows.length > 0 && meterRows[0].fuel_type_id) {
            // Find the tank for this meter
            const [tankRows] = await db.execute(
                `SELECT id FROM station_tanks 
                 WHERE customer_id = ? AND fuel_type_id = ? AND active = 1
                 LIMIT 1`,
                [customerId, meterRows[0].fuel_type_id]
            );
            
            if (tankRows.length > 0) {
                const tank_id = tankRows[0].id;
                
                // Check if stock exists for this reading's date/shift
                const [stockCheckRows] = await db.execute(
                    `SELECT id FROM station_tank_stock 
                     WHERE tank_id = ? AND stock_date = ? AND shift = ? AND Active = 1
                     LIMIT 1`,
                    [tank_id, reading.reading_date, reading.shift]
                );
                
                if (stockCheckRows.length > 0) {
                    return res.status(400).json({ 
                        message: 'Meter reading cannot be deleted after tank stock has been finalized for this date and shift. Please contact an administrator to make corrections.',
                        code: 'STOCK_FINALIZED',
                        stock_exists: true
                    });
                }
            }
        }

        const query = 'UPDATE meter_readings SET Active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }

        res.json({ message: 'Meter reading deleted successfully' });
    } catch (err) {
        console.error('Error deleting meter reading:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Check if a meter reading can be edited (helper function for frontend)
// Returns whether stock has been finalized for the reading's date/shift
exports.canEditMeterReading = async (req, res) => {
    try {
        const id = req.query.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Meter Reading ID is required' });
        }

        // Get the reading details
        const [readingRows] = await db.execute(
            `SELECT customer_id, meter_id, reading_date, shift FROM meter_readings WHERE id = ? AND Active = 1`,
            [id]
        );
        
        if (readingRows.length === 0) {
            return res.status(404).json({ message: 'Meter Reading not found' });
        }

        const reading = readingRows[0];
        const customerId = reading.customer_id;
        
        // Get meter info to find fuel_type_id and tank
        const [meterRows] = await db.execute(
            `SELECT fuel_type_id FROM meters WHERE id = ? AND Active = 1`,
            [reading.meter_id]
        );
        
        let canEdit = true;
        let reason = null;
        
        if (meterRows.length > 0 && meterRows[0].fuel_type_id) {
            // Find the tank for this meter
            const [tankRows] = await db.execute(
                `SELECT id FROM station_tanks 
                 WHERE customer_id = ? AND fuel_type_id = ? AND active = 1
                 LIMIT 1`,
                [customerId, meterRows[0].fuel_type_id]
            );
            
            if (tankRows.length > 0) {
                const tank_id = tankRows[0].id;
                
                // Check if stock exists for this reading's date/shift
                const [stockCheckRows] = await db.execute(
                    `SELECT id FROM station_tank_stock 
                     WHERE tank_id = ? AND stock_date = ? AND shift = ? AND Active = 1
                     LIMIT 1`,
                    [tank_id, reading.reading_date, reading.shift]
                );
                
                if (stockCheckRows.length > 0) {
                    canEdit = false;
                    reason = 'Tank stock has been finalized for this date and shift';
                }
            }
        }

        res.json({
            can_edit: canEdit,
            reason: reason,
            reading_date: reading.reading_date,
            shift: reading.shift
        });
    } catch (err) {
        console.error('Error checking if meter reading can be edited:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

