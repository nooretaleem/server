const db = require('../models/db');

// Get all banks (only active ones)
exports.getBanks = async (req, res) => {
    try {
        const query = `
            SELECT 
                b.ID,
                b.Name,
                b.Branch,
                b.cd,
                b.md,
                b.active,
                COALESCE(SUM(a.Balance), 0) as totalBalance
            FROM bank b
            LEFT JOIN accounts a ON b.ID = a.BankID AND a.active = 1
            WHERE b.active = 1
            GROUP BY b.ID, b.Name, b.Branch, b.cd, b.md, b.active
            ORDER BY b.ID DESC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching banks:', err);
        console.error('Error code:', err.code);
        console.error('Error SQL state:', err.sqlState);
        console.error('Error message:', err.message);
        console.error('Full error:', JSON.stringify(err, null, 2));
        
        if (err.code === 'ER_NO_SUCH_TABLE') {
            // Table doesn't exist - return empty array
            console.log('Bank table does not exist, returning empty array');
            res.json([]);
        } else if (err.code === 'ER_BAD_FIELD_ERROR') {
            // Column doesn't exist - might be case sensitivity or wrong column name
            res.status(500).json({ 
                message: 'Database schema error', 
                error: 'One or more columns do not exist. Please check your database schema.',
                details: err.message,
                hint: 'Check if the bank table exists and has the correct column names (ID, Name, Branch, cd, md, active)'
            });
        } else {
            res.status(500).json({ 
                message: 'Server Error', 
                error: err.message,
                code: err.code,
                sqlState: err.sqlState,
                hint: 'Please check server console for more details'
            });
        }
    }
};

// Get single bank by ID
exports.getBank = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Bank ID is required' });
        }

        const query = `
            SELECT 
                ID,
                Name,
                Branch,
                cd,
                md,
                active
            FROM bank
            WHERE ID = ? AND active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Bank not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching bank:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new bank
exports.addBank = async (req, res) => {
    try {
        const {
            Name,
            Branch
        } = req.body;

        if (!Name) {
            return res.status(400).json({ message: 'Bank name is required' });
        }

        const query = `
            INSERT INTO bank (Name, Branch, active) 
            VALUES (?, ?, 1)
        `;

        const [result] = await db.execute(query, [
            Name,
            Branch || null
        ]);

        res.json({
            message: 'Bank added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding bank:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'bank table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update bank
exports.updateBank = async (req, res) => {
    try {
        const {
            ID,
            Name,
            Branch
        } = req.body;

        if (!ID) {
            return res.status(400).json({ message: 'Bank ID is required' });
        }
        if (!Name) {
            return res.status(400).json({ message: 'Bank name is required' });
        }

        const query = `
            UPDATE bank SET 
                Name = ?,
                Branch = ?,
                md = NOW()
            WHERE ID = ? AND active = 1
        `;

        const [result] = await db.execute(query, [
            Name,
            Branch || null,
            ID
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Bank not found' });
        }

        res.json({ message: 'Bank updated successfully' });
    } catch (err) {
        console.error('Error updating bank:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete bank (soft delete - set active = 0)
exports.deleteBank = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Bank ID is required' });
        }

        await connection.beginTransaction();

        // Soft delete: set active = 0 for the bank
        const [bankResult] = await connection.execute(
            'UPDATE bank SET active = 0, md = NOW() WHERE ID = ?', 
            [id]
        );

        if (bankResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Bank not found' });
        }

        // Set all associated accounts to active = 0
        await connection.execute(
            'UPDATE accounts SET active = 0, MD = NOW() WHERE BankID = ? AND active = 1',
            [id]
        );

        await connection.commit();
        res.json({ message: 'Bank and its associated accounts deleted successfully' });
    } catch (err) {
        await connection.rollback();
        console.error('Error deleting bank:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    } finally {
        connection.release();
    }
};

