const db = require('../models/db');

// Get all station tank stock records
exports.getStationTankStock = async (req, res) => {
    try {
        const tankId = req.query.tank_id;
        const stockDate = req.query.stock_date;
        const shift = req.query.shift;
        
        let query = `
            SELECT 
                sts.id,
                sts.tank_id,
                sts.stock_date,
                sts.shift,
                sts.opening_stock,
                sts.received_qty,
                sts.sold_qty,
                sts.adjustment_qty,
                sts.closing_stock,
                sts.CB,
                sts.CD,
                sts.MB,
                sts.MD,
                sts.Active,
                st.tank_label,
                st.customer_id as station_id,
                c.name as station_name,
                ft.name as fuel_type_name
            FROM station_tank_stock sts
            LEFT JOIN station_tanks st ON sts.tank_id = st.id
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN fuel_types ft ON st.fuel_type_id = ft.id
            WHERE sts.Active = 1
        `;
        const params = [];
        
        if (tankId) {
            query += ' AND sts.tank_id = ?';
            params.push(tankId);
        }
        if (stockDate) {
            query += ' AND sts.stock_date = ?';
            params.push(stockDate);
        }
        if (shift) {
            query += ' AND sts.shift = ?';
            params.push(shift);
        }
        
        query += ' ORDER BY sts.stock_date DESC, sts.shift, st.tank_label';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching station tank stock:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single station tank stock by ID
exports.getStationTankStockById = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Station Tank Stock ID is required' });
        }

        const query = `
            SELECT 
                sts.id,
                sts.tank_id,
                sts.stock_date,
                sts.shift,
                sts.opening_stock,
                sts.received_qty,
                sts.sold_qty,
                sts.adjustment_qty,
                sts.closing_stock,
                sts.CB,
                sts.CD,
                sts.MB,
                sts.MD,
                sts.Active,
                st.tank_label,
                st.customer_id as station_id,
                c.name as station_name,
                ft.name as fuel_type_name
            FROM station_tank_stock sts
            LEFT JOIN station_tanks st ON sts.tank_id = st.id
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN fuel_types ft ON st.fuel_type_id = ft.id
            WHERE sts.id = ? AND sts.Active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Station Tank Stock not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching station tank stock:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get latest stock for a tank
exports.getLatestTankStock = async (req, res) => {
    try {
        const tankId = req.query.tank_id;
        if (!tankId) {
            return res.status(400).json({ message: 'Tank ID is required' });
        }

        const query = `
            SELECT 
                sts.id,
                sts.tank_id,
                sts.stock_date,
                sts.shift,
                sts.opening_stock,
                sts.received_qty,
                sts.sold_qty,
                sts.adjustment_qty,
                sts.closing_stock
            FROM station_tank_stock sts
            WHERE sts.tank_id = ? AND sts.Active = 1
            ORDER BY sts.stock_date DESC, 
                     CASE sts.shift 
                         WHEN 'Evening' THEN 2 
                         WHEN 'Morning' THEN 1 
                         ELSE 0 
                     END DESC
            LIMIT 1
        `;
        const [rows] = await db.execute(query, [tankId]);
        
        if (rows.length === 0) {
            return res.json({ closing_stock: 0 });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching latest tank stock:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new station tank stock record
exports.addStationTankStock = async (req, res) => {
    try {
        const {
            tank_id,
            stock_date,
            shift,
            opening_stock,
            received_qty,
            sold_qty,
            adjustment_qty
        } = req.body;

        if (!tank_id) {
            return res.status(400).json({ message: 'Tank ID is required' });
        }
        if (!stock_date) {
            return res.status(400).json({ message: 'Stock date is required' });
        }
        if (!shift) {
            return res.status(400).json({ message: 'Shift is required' });
        }

        // Calculate closing stock
        const opening = parseFloat(opening_stock || 0);
        const received = parseFloat(received_qty || 0);
        const sold = parseFloat(sold_qty || 0);
        const adjustment = parseFloat(adjustment_qty || 0);
        const closing_stock = opening + received - sold + adjustment;

        // Check for duplicate (same tank, date, shift)
        const checkQuery = `
            SELECT id FROM station_tank_stock 
            WHERE tank_id = ? AND stock_date = ? AND shift = ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [tank_id, stock_date, shift]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Stock record already exists for this tank, date, and shift' 
            });
        }

        const CB = req.body.CB || 'System';

        const query = `
            INSERT INTO station_tank_stock (
                tank_id, stock_date, shift,
                opening_stock, received_qty, sold_qty, adjustment_qty, closing_stock,
                Active, CB, CD, MD
            ) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [
            tank_id,
            stock_date,
            shift,
            opening,
            received,
            sold,
            adjustment,
            closing_stock,
            CB
        ]);

        res.json({
            message: 'Station tank stock added successfully',
            id: result.insertId,
            closing_stock: closing_stock
        });
    } catch (err) {
        console.error('Error adding station tank stock:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'station_tank_stock table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update station tank stock
exports.updateStationTankStock = async (req, res) => {
    try {
        const {
            id,
            tank_id,
            stock_date,
            shift,
            opening_stock,
            received_qty,
            sold_qty,
            adjustment_qty,
            Active,
            active
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Station Tank Stock ID is required' });
        }
        if (!tank_id) {
            return res.status(400).json({ message: 'Tank ID is required' });
        }
        if (!stock_date) {
            return res.status(400).json({ message: 'Stock date is required' });
        }
        if (!shift) {
            return res.status(400).json({ message: 'Shift is required' });
        }

        // Calculate closing stock
        const opening = parseFloat(opening_stock || 0);
        const received = parseFloat(received_qty || 0);
        const sold = parseFloat(sold_qty || 0);
        const adjustment = parseFloat(adjustment_qty || 0);
        const closing_stock = opening + received - sold + adjustment;

        // Check for duplicate (excluding current record)
        const checkQuery = `
            SELECT id FROM station_tank_stock 
            WHERE tank_id = ? AND stock_date = ? AND shift = ? AND id != ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [tank_id, stock_date, shift, id]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Stock record already exists for this tank, date, and shift' 
            });
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        const MB = req.body.MB || 'System';

        const query = `
            UPDATE station_tank_stock SET 
                tank_id = ?,
                stock_date = ?,
                shift = ?,
                opening_stock = ?,
                received_qty = ?,
                sold_qty = ?,
                adjustment_qty = ?,
                closing_stock = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            tank_id,
            stock_date,
            shift,
            opening,
            received,
            sold,
            adjustment,
            closing_stock,
            activeValue ? 1 : 0,
            MB,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Station Tank Stock not found' });
        }

        res.json({ 
            message: 'Station tank stock updated successfully',
            closing_stock: closing_stock
        });
    } catch (err) {
        console.error('Error updating station tank stock:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add received quantity to tank (from fuel purchase)
exports.addReceivedQty = async (req, res) => {
    try {
        const {
            tank_id,
            received_qty,
            stock_date,
            shift
        } = req.body;

        if (!tank_id) {
            return res.status(400).json({ message: 'Tank ID is required' });
        }
        if (!received_qty || received_qty <= 0) {
            return res.status(400).json({ message: 'Valid received quantity is required' });
        }

        // Get latest stock for the tank
        const latestStockQuery = `
            SELECT closing_stock, stock_date, shift
            FROM station_tank_stock
            WHERE tank_id = ? AND Active = 1
            ORDER BY stock_date DESC, 
                     CASE shift 
                         WHEN 'Evening' THEN 2 
                         WHEN 'Morning' THEN 1 
                         ELSE 0 
                     END DESC
            LIMIT 1
        `;
        const [latestRows] = await db.execute(latestStockQuery, [tank_id]);
        
        const latestStock = latestRows.length > 0 ? latestRows[0] : null;
        const opening_stock = latestStock ? parseFloat(latestStock.closing_stock) : 0;
        
        // Use provided date/shift or current date/Morning
        const useDate = stock_date || new Date().toISOString().split('T')[0];
        const useShift = shift || 'Morning';

        // Check if record exists for this date/shift
        const checkQuery = `
            SELECT id, opening_stock, received_qty, sold_qty, adjustment_qty, closing_stock
            FROM station_tank_stock 
            WHERE tank_id = ? AND stock_date = ? AND shift = ? AND Active = 1
        `;
        const [existingRows] = await db.execute(checkQuery, [tank_id, useDate, useShift]);
        
        if (existingRows.length > 0) {
            // Update existing record
            const existing = existingRows[0];
            const newReceivedQty = parseFloat(existing.received_qty || 0) + parseFloat(received_qty);
            const newClosingStock = parseFloat(existing.opening_stock || 0) + 
                                   newReceivedQty - 
                                   parseFloat(existing.sold_qty || 0) + 
                                   parseFloat(existing.adjustment_qty || 0);
            
            const updateQuery = `
                UPDATE station_tank_stock SET 
                    received_qty = ?,
                    closing_stock = ?,
                    MD = NOW()
                WHERE id = ?
            `;
            await db.execute(updateQuery, [newReceivedQty, newClosingStock, existing.id]);
            
            res.json({
                message: 'Received quantity added successfully',
                closing_stock: newClosingStock
            });
        } else {
            // Create new record
            const received = parseFloat(received_qty);
            const closing_stock = opening_stock + received;
            
            const insertQuery = `
                INSERT INTO station_tank_stock (
                    tank_id, stock_date, shift,
                    opening_stock, received_qty, sold_qty, adjustment_qty, closing_stock,
                    Active, CB, CD, MD
                ) 
                VALUES (?, ?, ?, ?, ?, 0, 0, ?, 1, 'System', NOW(), NOW())
            `;
            const [result] = await db.execute(insertQuery, [
                tank_id,
                useDate,
                useShift,
                opening_stock,
                received,
                closing_stock
            ]);
            
            res.json({
                message: 'Received quantity added successfully',
                id: result.insertId,
                closing_stock: closing_stock
            });
        }
    } catch (err) {
        console.error('Error adding received quantity:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete station tank stock (soft delete - set Active=0)
exports.deleteStationTankStock = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Station Tank Stock ID is required' });
        }

        const query = 'UPDATE station_tank_stock SET Active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Station Tank Stock not found' });
        }

        res.json({ message: 'Station tank stock deleted successfully' });
    } catch (err) {
        console.error('Error deleting station tank stock:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

