const crypto = require('crypto');
const privateKey = crypto.randomBytes(32).toString('hex');
console.log(privateKey);