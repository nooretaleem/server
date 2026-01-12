const jwt = require("jsonwebtoken")
const config=require('../config/config.json');
function generateAccessToken (user) {
return jwt.sign(user, config.privateKey, {expiresIn: "15m"})
}

module.exports=generateAccessToken