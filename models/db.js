const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');
const config = require('../config/config.json');

// Create a pool to handle database connections
const poolConfig = {
  host: config.host,
  user: config.user,
  password: config.password,
  database: config.database,
  port: config.port || 3306,
  waitForConnections: config.waitForConnections !== undefined ? config.waitForConnections : true,
  connectionLimit: config.connectionLimit || 10,
  queueLimit: config.queueLimit || 0,
  connectTimeout: config.connectTimeout || 60000,
  namedPlaceholders: true,
};

// Add SSL configuration if specified (required for Aiven cloud databases)
if (config.ssl) {
  const sslConfig = {
    rejectUnauthorized: false // Default to false, will be set to true if certificate is provided
  };

  // If CA certificate path is provided, read and use it
  if (config.sslCa) {
    try {
      const caPath = path.isAbsolute(config.sslCa) 
        ? config.sslCa 
        : path.join(__dirname, '..', config.sslCa);
      
      if (fs.existsSync(caPath)) {
        sslConfig.ca = fs.readFileSync(caPath);
        sslConfig.rejectUnauthorized = true; // Verify certificate when CA is provided
        console.log('✅ SSL CA Certificate loaded from:', caPath);
      } else {
        console.warn('⚠️  SSL CA Certificate file not found at:', caPath);
      }
    } catch (err) {
      console.error('❌ Error reading SSL CA certificate:', err.message);
    }
  }

  // If client certificate is provided (optional, usually not needed for Aiven)
  if (config.sslCert) {
    try {
      const certPath = path.isAbsolute(config.sslCert) 
        ? config.sslCert 
        : path.join(__dirname, '..', config.sslCert);
      
      if (fs.existsSync(certPath)) {
        sslConfig.cert = fs.readFileSync(certPath);
        console.log('✅ SSL Client Certificate loaded from:', certPath);
      } else {
        console.warn('⚠️  SSL Client Certificate file not found at:', certPath);
      }
    } catch (err) {
      console.error('❌ Error reading SSL Client certificate:', err.message);
    }
  }

  // If client key is provided (optional, usually not needed for Aiven)
  if (config.sslKey) {
    try {
      const keyPath = path.isAbsolute(config.sslKey) 
        ? config.sslKey 
        : path.join(__dirname, '..', config.sslKey);
      
      if (fs.existsSync(keyPath)) {
        sslConfig.key = fs.readFileSync(keyPath);
        console.log('✅ SSL Client Key loaded from:', keyPath);
      } else {
        console.warn('⚠️  SSL Client Key file not found at:', keyPath);
      }
    } catch (err) {
      console.error('❌ Error reading SSL Client key:', err.message);
    }
  }

  poolConfig.ssl = sslConfig;
}

const pool = mysql.createPool(poolConfig);

// Test connection and log database info
pool.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database Connection Error:', err.message);
    console.error('   Host:', config.host);
    console.error('   User:', config.user);
    console.error('   Database:', config.database);
  } else {
    console.log('✅ Database Connected Successfully!');
    console.log('   Host:', config.host);
    console.log('   User:', config.user);
    console.log('   Database:', config.database);
    console.log('   Connection Pool: Ready');
    connection.release();
  }
});

module.exports = pool.promise();