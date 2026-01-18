const db = require('../models/db');
const bcrypt = require("bcrypt");
const generateAccessToken  = require("../util/generateAccessToken");

exports.getAllUsers = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM users');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};
exports.login = async (req, res) => {
    try {
        const email = req.body.username;
        const password = req.body.password;
        
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }
        
        const [rows] = await db.execute('Select users.id,users.password, users.email, users.name, roles.roletype from users Inner Join '
        +' roles on users.roleid=roles.id where email = ?', [
            email,
        ]);
        
        if (rows.length == 0) {
            console.log("--------> User does not exist")
            return res.status(401).json({ message: 'Incorrect email or password' });
        }
        else {
            const hashedPassword = rows[0].password;
            const userrole = rows[0].roletype;
            const userid = rows[0].id;
            const username = rows[0].name || rows[0].email; // Use name if available, else use email
            
            // Compare password with hashed password
            bcrypt.compare(password, hashedPassword, function (err, result) {
                if (err) {
                    console.log("Error comparing password:", err);
                    return res.status(500).json({ message: 'Server Error' });
                } else if (result === true) {
                    console.log("---------> Login Successful");
                    // Generate access token
                    const token = generateAccessToken({ email: email, userid: userid });
                    return res.json({ 
                        accessToken: token, 
                        role: userrole, 
                        expiry: new Date().getTime() + 15 * 60 * 1000,
                        userid: userid,
                        name: username
                    });
                } else {
                    console.log("---------> Password Incorrect");
                    return res.status(401).json({ message: 'Incorrect email or password' });
                }
            });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.signup = async (req, res) => {
    //const { name, password, email } = req.body;
    const name = req.body.name;
    const email = req.body.email;
    const password = req.body.password;

    try {
        //const [rows] = await db.execute('SELECT * FROM users WHERE email = ?',email);
        const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [
            email,
        ]);
        if (rows.length != 0) {

            console.log("------> User already exists");
            res.sendStatus(409);
        }
        else {
            hashPassword(password).then(async (hash) => {
                //console.log(hash); // the hashed password is available here
                const [result] = await db.execute(
                    'INSERT INTO users (name, password, email) VALUES (?, ?, ?)',
                    [name, hash, email]
                );
                const [data] = await db.execute('SELECT * FROM users WHERE id = ?', [
                    result.insertId,
                ]);
                res.json(data[0]);
            }).catch((err) => {
                console.error(err);
            });

            /* bcrypt.genSalt(10, function (err, salt) {
                hashedPassword=bcrypt.hash(password, salt, function (err, hash) {
                    
                    // console.log(hashedPassword);
                });
            }); */
        }



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

exports.getCurrentUser = async (req, res) => {
    try {
        const userid = req.query.userid;
        
        if (!userid) {
            return res.status(400).json({ message: 'User ID is required' });
        }
        
        const [rows] = await db.execute('SELECT id, name, email FROM users WHERE id = ?', [userid]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.getAlowedModules=async(req,res)=>{
    const username=req.query.username;
   
    try{
        const [rows] = await db.execute('Select users.id,modules.name,modules.link,modules.imagesrc'+
    ' from users Inner Join roles on users.roleid=roles.id inner join modulesassignment'+
    ' on modulesassignment.roleid=roles.id inner join modules on modules.id=modulesassignment.moduleid'+
    ' where email = ?', [
            username,
        ]);
        const category = rows.map(row => ({
            name: row.name,
            link:row.link,
            imagesrc:row.imagesrc

        }));
        res.status(200).json(category);
    }catch (err) {
        console.error(err);
        res.status(500).json({ message: err });
    }
    
};