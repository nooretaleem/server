const db = require('../models/db');
const bcrypt = require('bcrypt');

// Get all staff
exports.getStaff = async (req, res) => {
    try {
        const query = `
            SELECT id, staffCode, name, phone, designation, employmentType,
                   joiningDate, user_id, pump_id, cnic, salary,
                   cd, md, CB, MB, Active
            FROM staff
            WHERE Active = 1
            ORDER BY name
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching staff:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get staff by ID
exports.getStaffById = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Staff ID is required' });
        }

        const query = `
            SELECT s.id, s.staffCode, s.name, s.phone, s.designation, s.employmentType,
                   s.joiningDate, s.user_id, s.pump_id, s.cnic, s.salary,
                   s.cd, s.md, s.CB, s.MB, s.Active, u.email, u.roleid
            FROM staff s
            LEFT JOIN users u ON u.id = s.user_id
            WHERE s.id = ? AND s.Active = 1
        `;
        const [rows] = await db.execute(query, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Staff not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching staff:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add staff (creates user first, then staff)
exports.addStaff = async (req, res) => {
    try {
        const {
            staffCode,
            name,
            phone,
            designation,
            employmentType,
            joiningDate,
            email,
            password,
            roleid,
            pump_id,
            cnic,
            salary,
            CB
        } = req.body;

        if (!staffCode || !staffCode.trim()) {
            return res.status(400).json({ message: 'Staff code is required' });
        }
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Name is required' });
        }
        if (!phone || !phone.trim()) {
            return res.status(400).json({ message: 'Phone is required' });
        }
        const phoneDigits = (phone + '').replace(/\D/g, '');
        if (phoneDigits.length > 11) {
            return res.status(400).json({ message: 'Phone number must be at most 11 digits' });
        }
        if (!designation || !designation.trim()) {
            return res.status(400).json({ message: 'Designation is required' });
        }
        const isStaffRole = (designation || '').trim().toLowerCase() === 'staff';
        if (!isStaffRole) {
            if (!email || !email.trim()) {
                return res.status(400).json({ message: 'Email is required' });
            }
            if (!password || !password.trim()) {
                return res.status(400).json({ message: 'Password is required' });
            }
        }
        if (!roleid) {
            return res.status(400).json({ message: 'Role (Designation) is required' });
        }
        if (!employmentType || !employmentType.trim()) {
            return res.status(400).json({ message: 'Employment type is required' });
        }
        if (!joiningDate || !joiningDate.trim()) {
            return res.status(400).json({ message: 'Joining date is required' });
        }

        const createdBy = CB || req.body.CB || 'System';
        const salaryVal = salary != null ? parseFloat(salary) : null;
        const pumpId = pump_id != null && pump_id !== '' ? parseInt(pump_id) : null;
        const roleId = parseInt(roleid);
        const emailVal = email && typeof email === 'string' ? email.trim() : '';
        const passwordVal = password && typeof password === 'string' ? password.trim() : '';

        let userId = null;

        if (emailVal && passwordVal) {
            // Check if email already exists in users
            const [existingUser] = await db.execute('SELECT id FROM users WHERE email = ?', [emailVal]);
            if (existingUser.length > 0) {
                return res.status(409).json({ message: 'User with this email already exists' });
            }
            // Create user (CB = Created By, CD = Created Date)
            const hashedPassword = await bcrypt.hash(passwordVal, 10);
            const [userResult] = await db.execute(
                'INSERT INTO users (name, email, password, roleid, CB, CD) VALUES (?, ?, ?, ?, ?, NOW())',
                [name.trim(), emailVal, hashedPassword, roleId, createdBy]
            );
            userId = userResult.insertId;
        }

        // Create staff with user_id (null when Designation is Staff and no email/password)
        const query = `
            INSERT INTO staff (
                staffCode, name, phone, designation, employmentType,
                joiningDate, user_id, pump_id, cnic, salary,
                Active, CB, CD, MB, MD
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())
        `;

        const [result] = await db.execute(query, [
            staffCode.trim(),
            name.trim(),
            phone.trim(),
            designation.trim(),
            employmentType.trim(),
            joiningDate,
            userId,
            pumpId,
            cnic ? cnic.trim() : null,
            salaryVal,
            createdBy,
            createdBy
        ]);

        res.json({
            message: 'Staff added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding staff:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'staff table does not exist. Please create the table first.' });
        } else if (err.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ message: 'Duplicate entry. Staff with this code may already exist.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update staff (also updates user if user_id exists)
exports.updateStaff = async (req, res) => {
    try {
        const {
            id,
            staffCode,
            name,
            phone,
            designation,
            employmentType,
            joiningDate,
            user_id,
            email,
            password,
            roleid,
            pump_id,
            cnic,
            salary,
            Active,
            MB
        } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Staff ID is required' });
        }
        if (!staffCode || !staffCode.trim()) {
            return res.status(400).json({ message: 'Staff code is required' });
        }
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Name is required' });
        }
        if (!phone || !phone.trim()) {
            return res.status(400).json({ message: 'Phone is required' });
        }
        const phoneDigitsUpdate = (phone + '').replace(/\D/g, '');
        if (phoneDigitsUpdate.length > 11) {
            return res.status(400).json({ message: 'Phone number must be at most 11 digits' });
        }
        if (!designation || !designation.trim()) {
            return res.status(400).json({ message: 'Designation is required' });
        }
        if (!employmentType || !employmentType.trim()) {
            return res.status(400).json({ message: 'Employment type is required' });
        }
        if (!joiningDate || !joiningDate.trim()) {
            return res.status(400).json({ message: 'Joining date is required' });
        }

        const salaryVal = salary != null ? parseFloat(salary) : null;
        const pumpId = pump_id != null && pump_id !== '' ? parseInt(pump_id) : null;
        const userId = user_id != null && user_id !== '' ? parseInt(user_id) : null;
        const activeVal = Active != null ? (Active === 1 || Active === true ? 1 : 0) : 1;
        const modifiedBy = MB || req.body.MB || 'System';

        // Update user if staff has user_id and email provided (MB = Modified By, MD = Modified Date)
        if (userId && email && email.trim()) {
            const roleId = roleid != null ? parseInt(roleid) : null;
            const modifiedBy = MB || req.body.MB || 'System';
            const [userRows] = await db.execute('SELECT id, roleid FROM users WHERE id = ?', [userId]);
            if (userRows.length > 0) {
                const currentRoleId = roleId != null ? roleId : userRows[0].roleid;
                if (password && password.trim()) {
                    const hashedPassword = await bcrypt.hash(password.trim(), 10);
                    await db.execute(
                        'UPDATE users SET name = ?, email = ?, password = ?, roleid = ?, MB = ?, MD = NOW() WHERE id = ?',
                        [name.trim(), email.trim(), hashedPassword, currentRoleId, modifiedBy, userId]
                    );
                } else {
                    await db.execute(
                        'UPDATE users SET name = ?, email = ?, roleid = ?, MB = ?, MD = NOW() WHERE id = ?',
                        [name.trim(), email.trim(), currentRoleId, modifiedBy, userId]
                    );
                }
            }
        }

        const query = `
            UPDATE staff SET
                staffCode = ?, name = ?, phone = ?, designation = ?,
                employmentType = ?, joiningDate = ?, user_id = ?,
                pump_id = ?, cnic = ?, salary = ?, Active = ?,
                MB = ?, MD = NOW()
            WHERE id = ?
        `;

        const [result] = await db.execute(query, [
            staffCode.trim(),
            name.trim(),
            phone.trim(),
            designation.trim(),
            employmentType.trim(),
            joiningDate,
            userId,
            pumpId,
            cnic ? cnic.trim() : null,
            salaryVal,
            activeVal,
            modifiedBy,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Staff not found' });
        }

        res.json({ message: 'Staff updated successfully' });
    } catch (err) {
        console.error('Error updating staff:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get staff advance history (credit/debit records from staff_advance_salary)
exports.getStaffAdvanceHistory = async (req, res) => {
    try {
        const staffId = req.query.staff_id;
        if (!staffId) {
            return res.status(400).json({ message: 'Staff ID is required' });
        }

        const [rows] = await db.execute(
            `SELECT id, staff_id, credit, debit, reason, CB, MB, cd, md
             FROM staff_advance_salary
             WHERE staff_id = ? AND Active = 1
             ORDER BY cd DESC, id DESC`,
            [staffId]
        );

        const history = (rows || []).map(r => ({
            id: r.id,
            staff_id: r.staff_id,
            credit: r.credit != null ? parseFloat(r.credit) : 0,
            debit: r.debit != null ? parseFloat(r.debit) : 0,
            reason: r.reason || null,
            CB: r.CB,
            MB: r.MB,
            cd: r.cd,
            md: r.md
        }));

        res.json(history);
    } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.json([]);
        }
        console.error('Error fetching staff advance history:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Get staff advance balance (sum of credit - sum of debit)
exports.getStaffAdvanceBalance = async (req, res) => {
    try {
        const staffId = req.query.staff_id;
        if (!staffId) {
            return res.status(400).json({ message: 'Staff ID is required' });
        }

        const [rows] = await db.execute(
            `SELECT COALESCE(SUM(credit), 0) - COALESCE(SUM(debit), 0) AS balance
             FROM staff_advance_salary WHERE staff_id = ? AND Active = 1`,
            [staffId]
        );
        const balance = rows && rows[0] ? parseFloat(rows[0].balance) || 0 : 0;

        res.json({ balance, staff_id: parseInt(staffId) });
    } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.json({ balance: 0, staff_id: parseInt(req.query.staff_id) });
        }
        console.error('Error fetching staff advance balance:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add debit/credit to staff_advance_salary
exports.addStaffAdvanceRecord = async (req, res) => {
    try {
        const { staff_id, credit, debit, reason, CB, MB } = req.body;

        if (!staff_id) {
            return res.status(400).json({ message: 'Staff ID is required' });
        }
        const creditVal = parseFloat(credit) || 0;
        const debitVal = parseFloat(debit) || 0;
        if (creditVal <= 0 && debitVal <= 0) {
            return res.status(400).json({ message: 'Either credit or debit amount is required' });
        }
        if (creditVal > 0 && debitVal > 0) {
            return res.status(400).json({ message: 'Provide either credit or debit, not both' });
        }

        // Validate reason length (max 200 characters)
        const reasonVal = reason ? reason.trim().substring(0, 200) : null;

        const cb = CB || req.body.CB || 'System';
        const mb = MB || req.body.MB || cb;

        await db.execute(
            `INSERT INTO staff_advance_salary (staff_id, credit, debit, reason, CB, MB, cd, md, Active)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
            [staff_id, creditVal, debitVal, reasonVal, cb, mb]
        );

        res.json({ message: 'Record saved successfully' });
    } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ message: 'staff_advance_salary table does not exist. Please create it first.' });
        }
        console.error('Error adding staff advance record:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete staff advance record (soft delete - set Active = 0)
exports.deleteStaffAdvanceRecord = async (req, res) => {
    try {
        const id = req.body?.id;
        if (!id) {
            return res.status(400).json({ message: 'Record ID is required' });
        }

        const mb = req.body?.MB || 'System';

        const query = `UPDATE staff_advance_salary SET Active = 0, MB = ?, MD = NOW() WHERE id = ?`;
        const [result] = await db.execute(query, [mb, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Record not found' });
        }

        res.json({ message: 'Record deleted successfully' });
    } catch (err) {
        console.error('Error deleting staff advance record:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete staff (soft delete - set Active = 0)
exports.deleteStaff = async (req, res) => {
    try {
        const id = req.body?.id;
        if (!id) {
            return res.status(400).json({ message: 'Staff ID is required' });
        }

        const query = `UPDATE staff SET Active = 0, MD = NOW() WHERE id = ?`;
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Staff not found' });
        }

        res.json({ message: 'Staff deleted successfully' });
    } catch (err) {
        console.error('Error deleting staff:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};
