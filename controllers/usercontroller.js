const db = require('../models/db');
const bcrypt = require("bcrypt");


exports.getUsers = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT users.id,users.name,users.email,roles.id as roleid,roles.roletype from users '
            + ' Inner join roles on roles.id=users.roleid');
        //console.log(rows); // check if rows is coming from the database
        const users = rows.map(row => ({
            id: row.id,
            name: row.name,
            email: row.email,
            roleid: row.roleid,
            role: row.roletype,

        }));
        res.status(200).json(users);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};

exports.getRoles = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT id,roletype from roles');

        const roles = rows.map(row => ({
            id: row.id,
            roletype: row.roletype,

        }));
        res.status(200).json(roles);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};

exports.getModules = async (req, res) => {

    try {
        const [rows] = await db.execute('SELECT id,name from modules');

        const roles = rows.map(row => ({
            id: row.id,
            name: row.name,

        }));
        res.status(200).json(roles);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};
exports.getModulesforRole = async (req, res) => {

    const id = req.query.id;

    try {
        const [rows] = await db.execute('SELECT modules.id,modules.name from modulesassignment'
            + ' inner join modules on modules.id=modulesassignment.moduleid'
            + ' inner join roles on roles.id=modulesassignment.roleid where modulesassignment.roleid=?', [id]);

        const roles = rows.map(row => ({
            id: row.id,
            name: row.name,

        }));

        res.status(200).json(roles);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
};
exports.addUser = async (req, res) => {

    //const id = req.body.id;
    const name = req.body.name;
    const email = req.body.email;
    const password = req.body.password;
    const role = Number(req.body.role);
    const CB = req.body.CB || 'System';
    const MB = req.body.MB || CB;
    const createStaffRecord = req.body.createStaffRecord === true;
    let conn;

    console.log(name + ' ' + email + ' ' + password + ' ' + role);
    try {
        const [rows] = await db.execute('SELECT email FROM users WHERE email = ?', [
            email
        ]);
        if (rows.length != 0) {

            console.log("------> User with this Email already exists.");
            //res.sendStatus(409);
            res.status(409).json({ message: 'User with the given Email already exists' });
        }
        else {
            const hash = await hashPassword(password);
            conn = await db.getConnection();
            await conn.beginTransaction();

            const [[roleRow]] = await conn.execute(
                'SELECT roletype FROM roles WHERE id = ? LIMIT 1',
                [role]
            );
            const roleName = roleRow?.roletype || null;

            const [result] = await conn.execute(
                'INSERT INTO users (name, password, email, roleid, CB, MB) VALUES (?, ?, ?, ?, ?, ?)',
                [name, hash, email, role, CB, MB]
            );

            let staffId = null;
            if (createStaffRecord) {
                const designation = String(roleName || 'Staff').trim() || 'Staff';
                const codePrefix = designation.toLowerCase().includes('manager') ? 'MGR' : 'STF';
                const staffCode = `${codePrefix}-${result.insertId}`;

                const [staffResult] = await conn.execute(
                    `INSERT INTO staff (
                        staffCode, name, phone, designation, employmentType,
                        joiningDate, user_id, pump_id, cnic, salary,
                        Active, CB, CD, MB, MD
                    ) VALUES (?, ?, ?, ?, ?, CURDATE(), ?, NULL, NULL, NULL, 1, ?, NOW(), ?, NOW())`,
                    [staffCode, name, '', designation, 'Permanent', result.insertId, CB, CB]
                );
                staffId = staffResult.insertId;
            }

            await conn.commit();

            res.status(200).json({
                message: 'Inserted successfully.',
                user: {
                    id: result.insertId,
                    name,
                    email,
                    roleid: role,
                    role: roleName
                },
                staffId
            });
        }

    } catch (err) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (rollbackErr) {
                console.error(rollbackErr);
            }
        }
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    } finally {
        if (conn) conn.release();
    }
};
exports.updateUser = async (req, res) => {
    //const { name, password, email } = req.body;
    const id = req.body.id;
    const name = req.body.name;
    const email = req.body.email;
    const password = req.body.password;
    const role = req.body.role;

    console.log('In api ' + id + ' ' + name + ' ' + email + ' ' + password + ' ' + role);

    try {
        const [rows] = await db.execute('SELECT * FROM users WHERE email = ? and id=?', [
            email, id
        ]);
        if (rows.length != 0) {

            res.status(200).json({ message: 'User updated succesfully.' });
        }
        const [rowss] = await db.execute('SELECT * FROM users WHERE email = ? and id!=?', [
            email, id
        ]);
        if (rowss.length != 0) {

            res.status(409).json({ message: 'User with the given email already exists.' });
        }
        else {
            hashPassword(password).then(async (hash) => {
                //console.log(hash); // the hashed password is available here
                const [result] = await db.execute(

                    'UPDATE users SET name = ?,email=?, password=?, roleid=? WHERE id = ?', [name, email, hash, role, id]);

                res.status(200).json({ message: 'Inserted successfully.' });
            }).catch((err) => {
                console.error(err);
            });


        }

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'User can not be deleted due to connection to some other data.' });
    }
};
exports.deleteUser = async (req, res) => {
    //const { name, password, email } = req.body;
    const id = req.body.id;


    try {

        const [result] = await db.execute(

            'Delete FROM users WHERE id = ?', [id]);
        res.json(result[0]);


    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        bcrypt.genSalt(10, function (err, salt) {
            bcrypt.hash(password, salt, function (err, hash) {
                if (err) {
                    reject(err);
                } else {
                    resolve(hash);
                }
            });
        });
    });
}

exports.addRole = async (req, res) => {


    const role = req.body.role;

    try {
        const [rows] = await db.execute('SELECT roletype FROM roles WHERE roletype = ?', [
            role,
        ]);
        if (rows.length != 0) {

            console.log("------> Role already exists.");
            //res.sendStatus(409);
            res.status(409).json({ message: 'Role already exists' });
        }
        else {
            const [result] = await db.execute(
                'INSERT INTO roles (roletype) VALUES (?)',
                [role]
            );

            res.status(200).json({ message: 'Inserted successfully.' });
        }

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};
exports.updateRole = async (req, res) => {
    //const { name, password, email } = req.body;
    const id = req.body.id;
    const role = req.body.role;


    try {
        const [rows] = await db.execute('SELECT * FROM roles WHERE roletype = ? and id=?', [
            role, id
        ]);
        if (rows.length != 0) {

            res.status(200).json({ message: 'Role updated succesfully.' });
        }
        const [rowss] = await db.execute('SELECT * FROM roles WHERE roletype = ? and id!=?', [
            role, id
        ]);
        if (rowss.length != 0) {

            res.status(409).json({ message: 'Role already exists.' });
        }
        else {
            const [result] = await db.execute(

                'UPDATE roles SET roletype = ? WHERE id = ?', [role, id]);

            res.status(200).json({ message: 'Role updated successfully.' });
        }

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
};
exports.deleteRole = async (req, res) => {

    const id = req.body.id;


    try {

        const [result] = await db.execute(

            'Delete FROM roles WHERE id = ?', [id]);
        res.json(result[0]);


    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.addRoleModules = async (req, res) => {
    const roleid = Number(req.body.roleid);
    const modules = Array.isArray(req.body.modules) ? req.body.modules : [];

    if (!roleid) {
        return res.status(400).json({ message: 'roleid is required.' });
    }

    const selectedModuleIds = [...new Set(
        modules
            .map(module => Number(module?.id ?? module))
            .filter(moduleId => Number.isInteger(moduleId) && moduleId > 0)
    )];

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [existingRows] = await connection.execute(
            'SELECT moduleid FROM modulesassignment WHERE roleid = ?',
            [roleid]
        );

        const existingModuleIds = existingRows.map(row => Number(row.moduleid));
        const modulesToInsert = selectedModuleIds.filter(moduleId => !existingModuleIds.includes(moduleId));
        const modulesToDelete = existingModuleIds.filter(moduleId => !selectedModuleIds.includes(moduleId));

        for (const moduleId of modulesToInsert) {
            await connection.execute(
                'INSERT INTO modulesassignment (roleid, moduleid) VALUES (?, ?)',
                [roleid, moduleId]
            );
        }

        for (const moduleId of modulesToDelete) {
            await connection.execute(
                'DELETE FROM modulesassignment WHERE roleid = ? AND moduleid = ?',
                [roleid, moduleId]
            );
        }

        await connection.commit();
        res.status(200).json({ message: 'Modules updated for the role.' });
    } catch (err) {
        if (connection) {
            await connection.rollback();
        }
        console.error('Error updating role modules:', err);
        res.status(500).json({ message: 'Server Error' });
    } finally {
        if (connection) {
            connection.release();
        }
    }
}
