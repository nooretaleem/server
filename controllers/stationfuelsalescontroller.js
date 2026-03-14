const db = require('../models/db');

// Get all station fuel sales records
exports.getStationFuelSales = async (req, res) => {
    try {
        const customerId = req.query.customer_id;
        const readingDate = req.query.reading_date;
        const shift = req.query.shift;
        
        let query = `
            SELECT 
                sfs.id,
                sfs.customer_id,
                sfs.reading_date,
                sfs.shift,
                sfs.total_sale_a,
                sfs.total_sale_b,
                sfs.CB,
                sfs.CD,
                sfs.MB,
                sfs.MD,
                sfs.Active,
                c.name as customer_name
            FROM station_fuel_sales sfs
            LEFT JOIN customers c ON sfs.customer_id = c.id
            WHERE sfs.Active = 1
        `;
        const params = [];
        
        if (customerId) {
            query += ' AND sfs.customer_id = ?';
            params.push(customerId);
        }
        if (readingDate) {
            query += ' AND sfs.reading_date = ?';
            params.push(readingDate);
        }
        if (shift) {
            query += ' AND sfs.shift = ?';
            params.push(shift);
        }
        
        query += ' ORDER BY sfs.reading_date DESC, sfs.shift DESC';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching station fuel sales:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get single station fuel sales record
exports.getStationFuelSale = async (req, res) => {
    try {
        const { id } = req.query;
        
        if (!id) {
            return res.status(400).json({ message: 'ID is required' });
        }
        
        const query = `
            SELECT 
                sfs.id,
                sfs.customer_id,
                sfs.reading_date,
                sfs.shift,
                sfs.total_sale_a,
                sfs.total_sale_b,
                sfs.CB,
                sfs.CD,
                sfs.MB,
                sfs.MD,
                sfs.Active,
                c.name as customer_name
            FROM station_fuel_sales sfs
            LEFT JOIN customers c ON sfs.customer_id = c.id
            WHERE sfs.id = ? AND sfs.Active = 1
        `;
        
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Station fuel sale not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching station fuel sale:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add station fuel sales record
exports.addStationFuelSale = async (req, res) => {
    try {
        const {
            customer_id,
            reading_date,
            shift,
            total_sale_a,
            total_sale_b
        } = req.body;
        
        if (!customer_id) {
            return res.status(400).json({ message: 'Customer ID is required' });
        }
        if (!reading_date) {
            return res.status(400).json({ message: 'Reading date is required' });
        }
        if (!shift) {
            return res.status(400).json({ message: 'Shift is required' });
        }
        
        // Check for duplicate (customer_id, reading_date, shift)
        const checkQuery = `
            SELECT id FROM station_fuel_sales 
            WHERE customer_id = ? AND reading_date = ? AND shift = ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [customer_id, reading_date, shift]);
        
        if (existing.length > 0) {
            // Update existing record instead of creating duplicate
            const updateQuery = `
                UPDATE station_fuel_sales SET
                    total_sale_a = ?,
                    total_sale_b = ?,
                    MB = ?,
                    MD = NOW()
                WHERE id = ?
            `;
            // Get CB (Created By) from request body - required, no default to 'System'
            const CB = req.body.CB;
            if (!CB) {
                return res.status(400).json({ message: 'CB (Created By - username) is required' });
            }
            const [result] = await db.execute(updateQuery, [
                total_sale_a || 0,
                total_sale_b || 0,
                CB,
                existing[0].id
            ]);
            
            return res.json({
                message: 'Station fuel sale updated successfully',
                id: existing[0].id,
                updated: true
            });
        }
        
        const CB = req.body.CB || 'System';
        
        const query = `
            INSERT INTO station_fuel_sales (
                customer_id, reading_date, shift,
                total_sale_a, total_sale_b,
                CB, CD, MD, Active
            ) 
            VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
        `;
        
        const [result] = await db.execute(query, [
            customer_id,
            reading_date,
            shift,
            total_sale_a || 0,
            total_sale_b || 0,
            CB
        ]);
        
        res.json({
            message: 'Station fuel sale added successfully',
            id: result.insertId,
            updated: false
        });
    } catch (err) {
        console.error('Error adding station fuel sale:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Station fuel sale already exists for this customer, date, and shift' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update station fuel sales record
exports.updateStationFuelSale = async (req, res) => {
    try {
        const {
            id,
            customer_id,
            reading_date,
            shift,
            total_sale_a,
            total_sale_b
        } = req.body;
        
        if (!id) {
            return res.status(400).json({ message: 'ID is required' });
        }
        
        // Check for duplicate (excluding current record)
        if (customer_id && reading_date && shift) {
            const checkQuery = `
                SELECT id FROM station_fuel_sales 
                WHERE customer_id = ? AND reading_date = ? AND shift = ? 
                AND id != ? AND Active = 1
            `;
            const [existing] = await db.execute(checkQuery, [customer_id, reading_date, shift, id]);
            
            if (existing.length > 0) {
                return res.status(400).json({ 
                    message: 'Station fuel sale already exists for this customer, date, and shift' 
                });
            }
        }
        
        // Get MB (Modified By) from request body - required, no default to 'System'
        const MB = req.body.MB;
        if (!MB) {
            return res.status(400).json({ message: 'MB (Modified By - username) is required' });
        }
        
        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];
        
        if (customer_id !== undefined) {
            updateFields.push('customer_id = ?');
            updateValues.push(customer_id);
        }
        if (reading_date !== undefined) {
            updateFields.push('reading_date = ?');
            updateValues.push(reading_date);
        }
        if (shift !== undefined) {
            updateFields.push('shift = ?');
            updateValues.push(shift);
        }
        if (total_sale_a !== undefined) {
            updateFields.push('total_sale_a = ?');
            updateValues.push(total_sale_a || 0);
        }
        if (total_sale_b !== undefined) {
            updateFields.push('total_sale_b = ?');
            updateValues.push(total_sale_b || 0);
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }
        
        updateFields.push('MB = ?');
        updateFields.push('MD = NOW()');
        updateValues.push(MB);
        updateValues.push(id);
        
        const query = `UPDATE station_fuel_sales SET ${updateFields.join(', ')} WHERE id = ?`;
        
        const [result] = await db.execute(query, updateValues);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Station fuel sale not found' });
        }
        
        res.json({ message: 'Station fuel sale updated successfully' });
    } catch (err) {
        console.error('Error updating station fuel sale:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Station fuel sale already exists for this customer, date, and shift' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Delete station fuel sales record (soft delete)
exports.deleteStationFuelSale = async (req, res) => {
    try {
        const { id } = req.query;
        
        if (!id) {
            return res.status(400).json({ message: 'ID is required' });
        }
        
        const query = `UPDATE station_fuel_sales SET Active = 0, MD = NOW() WHERE id = ?`;
        
        const [result] = await db.execute(query, [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Station fuel sale not found' });
        }
        
        res.json({ message: 'Station fuel sale deleted successfully' });
    } catch (err) {
        console.error('Error deleting station fuel sale:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

