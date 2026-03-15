const db = require('../models/db');

// Get all daily sales summaries
exports.getDailySalesSummaries = async (req, res) => {
    try {
        const stationId = req.query.station_id;
        const fuelTypeId = req.query.fuel_type_id;
        const saleDate = req.query.sale_date;
        const startDate = req.query.start_date;
        const endDate = req.query.end_date;
        
        let query = `
            SELECT 
                dss.id,
                dss.station_id,
                dss.fuel_type_id,
                dss.sale_date,
                dss.total_liters,
                dss.rate,
                dss.total_amount,
                dss.CB,
                dss.CD,
                dss.MB,
                dss.MD,
                dss.Active,
                c.name as station_name,
                ft.name as fuel_type_name
            FROM daily_sales_summary dss
            LEFT JOIN customers c ON dss.station_id = c.id
            LEFT JOIN fuel_types ft ON dss.fuel_type_id = ft.id
            WHERE dss.Active = 1
        `;
        const params = [];
        
        if (stationId) {
            query += ' AND dss.station_id = ?';
            params.push(stationId);
        }
        if (fuelTypeId) {
            query += ' AND dss.fuel_type_id = ?';
            params.push(fuelTypeId);
        }
        if (saleDate) {
            query += ' AND dss.sale_date = ?';
            params.push(saleDate);
        }
        if (startDate && endDate) {
            query += ' AND dss.sale_date BETWEEN ? AND ?';
            params.push(startDate, endDate);
        }
        
        query += ' ORDER BY dss.sale_date DESC, c.name, ft.name';
        
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching daily sales summaries:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single daily sales summary by ID
exports.getDailySalesSummary = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Daily Sales Summary ID is required' });
        }

        const query = `
            SELECT 
                dss.id,
                dss.station_id,
                dss.fuel_type_id,
                dss.sale_date,
                dss.total_liters,
                dss.rate,
                dss.total_amount,
                dss.CB,
                dss.CD,
                dss.MB,
                dss.MD,
                dss.Active,
                c.name as station_name,
                ft.name as fuel_type_name
            FROM daily_sales_summary dss
            LEFT JOIN customers c ON dss.station_id = c.id
            LEFT JOIN fuel_types ft ON dss.fuel_type_id = ft.id
            WHERE dss.id = ? AND dss.Active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Daily Sales Summary not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching daily sales summary:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new daily sales summary
exports.addDailySalesSummary = async (req, res) => {
    try {
        const {
            station_id,
            fuel_type_id,
            sale_date,
            total_liters,
            rate,
            total_amount
        } = req.body;

        if (!station_id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }
        if (!fuel_type_id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (!sale_date) {
            return res.status(400).json({ message: 'Sale date is required' });
        }

        // Check for duplicate summary (same station, fuel type, and date)
        const checkQuery = `
            SELECT id FROM daily_sales_summary 
            WHERE station_id = ? AND fuel_type_id = ? AND sale_date = ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [station_id, fuel_type_id, sale_date]);
        
        if (existing.length > 0) {
            // Get existing credit_sale so cash_sale = total_amount - credit_sale (all sales into cash, minus what's already credit)
            const [existingRow] = await db.execute(
                'SELECT credit_sale FROM daily_sales_summary WHERE id = ?',
                [existing[0].id]
            );
            const existingCredit = existingRow.length > 0 ? (parseFloat(existingRow[0].credit_sale) || 0) : 0;
            const calculatedAmount = total_amount || (total_liters && rate ? parseFloat(total_liters) * parseFloat(rate) : 0);
            const newCashSale = Math.max(0, calculatedAmount - existingCredit);

            const updateQuery = `
                UPDATE daily_sales_summary SET
                    total_liters = ?,
                    rate = ?,
                    total_amount = ?,
                    cash_sale = ?,
                    MB = ?,
                    MD = NOW()
                WHERE id = ?
            `;
            // Get CB (Created By) from request body - required, no default to 'System'
            const CB = req.body.CB;
            if (!CB) {
                return res.status(400).json({ message: 'CB (Created By - username) is required' });
            }

            const [updateResult] = await db.execute(updateQuery, [
                total_liters || null,
                rate || null,
                calculatedAmount,
                newCashSale,
                CB,
                existing[0].id
            ]);
            
            return res.json({
                message: 'Daily sales summary updated successfully',
                id: existing[0].id,
                updated: true
            });
        }

        // Calculate total_amount if not provided
        let calculatedAmount = total_amount;
        if (calculatedAmount === null || calculatedAmount === undefined) {
            if (total_liters && rate) {
                calculatedAmount = parseFloat(total_liters) * parseFloat(rate);
            } else {
                calculatedAmount = 0;
            }
        }

        const CB = req.body.CB || 'System';

        // When creating from meter readings: all sales amount goes into cash_sale; credit_sale = 0
        const query = `
            INSERT INTO daily_sales_summary (
                station_id, fuel_type_id, sale_date,
                total_liters, rate, total_amount,
                credit_sale, cash_sale,
                active, CB, CD, MD
            ) 
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?, NOW(), NOW())
        `;

        const [result] = await db.execute(query, [
            station_id,
            fuel_type_id,
            sale_date,
            total_liters || null,
            rate || null,
            calculatedAmount,
            calculatedAmount,
            CB
        ]);

        res.json({
            message: 'Daily sales summary added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding daily sales summary:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'daily_sales_summary table does not exist. Please create the table first.' });
        } else if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Daily sales summary already exists for this station, fuel type, and date' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update daily sales summary
exports.updateDailySalesSummary = async (req, res) => {
    try {
        const {
            id,
            station_id,
            fuel_type_id,
            sale_date,
            total_liters,
            rate,
            total_amount,
            Active,
            active
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Daily Sales Summary ID is required' });
        }
        if (!station_id) {
            return res.status(400).json({ message: 'Station ID is required' });
        }
        if (!fuel_type_id) {
            return res.status(400).json({ message: 'Fuel Type ID is required' });
        }
        if (!sale_date) {
            return res.status(400).json({ message: 'Sale date is required' });
        }

        // Check for duplicate summary (excluding current record)
        const checkQuery = `
            SELECT id FROM daily_sales_summary 
            WHERE station_id = ? AND fuel_type_id = ? AND sale_date = ? 
            AND id != ? AND Active = 1
        `;
        const [existing] = await db.execute(checkQuery, [station_id, fuel_type_id, sale_date, id]);
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                message: 'Daily sales summary already exists for this station, fuel type, and date' 
            });
        }

        // Calculate total_amount if not provided
        let calculatedAmount = total_amount;
        if (calculatedAmount === null || calculatedAmount === undefined) {
            if (total_liters && rate) {
                calculatedAmount = parseFloat(total_liters) * parseFloat(rate);
            } else {
                calculatedAmount = 0;
            }
        }

        const activeValue = Active !== undefined ? Active : (active !== undefined ? active : 1);
        // Get MB (Modified By) from request body - required, no default to 'System'
        const MB = req.body.MB;
        if (!MB) {
            return res.status(400).json({ message: 'MB (Modified By - username) is required' });
        }

        // cash_sale = total_amount - credit_sale so cash + credit = total
        const [existingRow] = await db.execute(
            'SELECT credit_sale FROM daily_sales_summary WHERE id = ?',
            [id]
        );
        const existingCredit = existingRow.length > 0 ? (parseFloat(existingRow[0].credit_sale) || 0) : 0;
        const newCashSale = Math.max(0, calculatedAmount - existingCredit);

        const query = `
            UPDATE daily_sales_summary SET 
                station_id = ?,
                fuel_type_id = ?,
                sale_date = ?,
                total_liters = ?,
                rate = ?,
                total_amount = ?,
                cash_sale = ?,
                Active = ?,
                MB = ?,
                MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            station_id,
            fuel_type_id,
            sale_date,
            total_liters || null,
            rate || null,
            calculatedAmount,
            newCashSale,
            activeValue ? 1 : 0,
            MB,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Daily Sales Summary not found' });
        }

        res.json({ message: 'Daily sales summary updated successfully' });
    } catch (err) {
        console.error('Error updating daily sales summary:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Daily sales summary already exists for this station, fuel type, and date' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Delete daily sales summary (soft delete - set Active=0)
exports.deleteDailySalesSummary = async (req, res) => {
    try {
        const id = req.body.id || req.params.id;
        
        if (!id) {
            return res.status(400).json({ message: 'Daily Sales Summary ID is required' });
        }

        const query = 'UPDATE daily_sales_summary SET Active = 0, MD = NOW() WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Daily Sales Summary not found' });
        }

        res.json({ message: 'Daily sales summary deleted successfully' });
    } catch (err) {
        console.error('Error deleting daily sales summary:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

