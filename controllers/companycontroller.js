const db = require('../models/db');

// Get all companies (only active ones)
exports.getCompanies = async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                name,
                CD,
                CB,
                MD,
                active
            FROM company
            WHERE active = 1
            ORDER BY name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching companies:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single company by ID
exports.getCompany = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Company ID is required' });
        }

        const query = 'SELECT * FROM company WHERE id = ? AND active = 1';
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Company not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching company:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new company
exports.addCompany = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            name
        } = req.body;

        if (!name) {
            connection.release();
            return res.status(400).json({ message: 'Company name is required' });
        }

        // Get CB (Created By) from request body, default to 'System' if not provided
        const CB = req.body.CB || 'System';

        await connection.beginTransaction();

        // Insert into company table with CB, CD, MD, active (default active=1)
        const companyQuery = `
            INSERT INTO company (name, CB, CD, MD, active) 
            VALUES (?, ?, NOW(), NOW(), 1)
        `;

        const [companyResult] = await connection.execute(companyQuery, [
            name,
            CB
        ]);

        const companyId = companyResult.insertId;

        await connection.commit();
        connection.release();

        res.json({
            message: 'Company added successfully',
            id: companyId
        });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error adding company:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'company table does not exist. Please create the table first.' });
        } else if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Company with this name already exists' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update company
exports.updateCompany = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            id,
            name
        } = req.body;

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Company ID is required' });
        }
        if (!name) {
            connection.release();
            return res.status(400).json({ message: 'Company name is required' });
        }

        await connection.beginTransaction();

        // Update company table (only name and MD, keep CD and CB as original)
        const companyQuery = `
            UPDATE company 
            SET name = ?, MD = NOW()
            WHERE id = ? AND active = 1
        `;

        const [result] = await connection.execute(companyQuery, [
            name,
            id
        ]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Company not found or inactive' });
        }

        await connection.commit();
        connection.release();

        res.json({ message: 'Company updated successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error updating company:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Company with this name already exists' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Delete company (soft delete - set active=0)
exports.deleteCompany = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { id } = req.body;

        if (!id) {
            connection.release();
            return res.status(400).json({ message: 'Company ID is required' });
        }

        await connection.beginTransaction();

        // Check if company exists and is active
        const [companyRows] = await connection.execute('SELECT id, active FROM company WHERE id = ?', [id]);
        if (companyRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Company not found' });
        }

        if (companyRows[0].active === 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ message: 'Company is already deleted' });
        }

        // Check if company is used in depo_company table (only active relationships)
        try {
            const [depoCompanyRows] = await connection.execute(
                'SELECT COUNT(*) as count FROM depo_company WHERE company_id = ? AND active = 1',
                [id]
            );

            if (depoCompanyRows[0].count > 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ 
                    message: `Cannot delete: This company is linked to ${depoCompanyRows[0].count} depo(s).` 
                });
            }
        } catch (err) {
            // If depo_company table doesn't exist, ignore
            console.log('Note: Could not check depo_company:', err.message);
        }

        // Soft delete: set active=0 and update MD
        const query = 'UPDATE company SET active = 0, MD = NOW() WHERE id = ?';
        const [result] = await connection.execute(query, [id]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Company not found' });
        }

        await connection.commit();
        connection.release();

        res.json({ message: 'Company deleted successfully' });
    } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('Error deleting company:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

