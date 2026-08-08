// backend/config/config.js
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Load environment variables
dotenv.config();

// Default config from config.json (for non-sensitive defaults)
let defaultConfig = {};
try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        defaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
} catch (error) {
    console.log('No config.json found, using environment variables');
}

// Build config from environment variables with fallbacks
const config = {
    host: process.env.DB_HOST || defaultConfig.host || 'localhost',
    user: process.env.DB_USER || defaultConfig.user || 'root',
    password: process.env.DB_PASSWORD || defaultConfig.password || '',
    database: process.env.DB_NAME || defaultConfig.database || 'petroerp',
    port: parseInt(process.env.DB_PORT) || defaultConfig.port || 3306,
    ssl: process.env.DB_SSL === 'true' || defaultConfig.ssl || false,
    sslCa: process.env.DB_SSL_CA || defaultConfig.sslCa || '',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || defaultConfig.connectionLimit || 10,
    waitForConnections: defaultConfig.waitForConnections !== undefined ? defaultConfig.waitForConnections : true,
    queueLimit: defaultConfig.queueLimit || 0,
    connectTimeout: parseInt(process.env.DB_CONNECT_TIMEOUT) || defaultConfig.connectTimeout || 12,
    privateKey: process.env.DB_PRIVATE_KEY || defaultConfig.privateKey || '',


    // =============================================
    // JWT Configuration (ADD THIS SECTION)
    // =============================================
    jwtSecret: process.env.JWT_SECRET || defaultConfig.jwtSecret || defaultConfig.privateKey || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || defaultConfig.jwtExpiresIn || '24h',


    // Server Configuration
    serverPort: parseInt(process.env.PORT) || defaultConfig.port || 5000,
    nodeEnv: process.env.NODE_ENV || defaultConfig.nodeEnv || 'development',
    frontendUrl: process.env.FRONTEND_URL || defaultConfig.frontendUrl || 'http://localhost:4200',
};

// Validate JWT secret (only warn in development, error in production)
if (!config.jwtSecret) {
    if (config.nodeEnv === 'production') {
        console.error('❌ JWT_SECRET is required in production!');
        process.exit(1);
    } else {
        console.warn('⚠️ JWT_SECRET is not set! Using fallback for development only.');
        config.jwtSecret = 'dev-fallback-secret-do-not-use-in-production';
    }
}

// Log configuration (without sensitive data)
/* console.log('📊 Configuration Loaded:');
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Database: ${config.database}@${config.host}:${config.port}`);
console.log(`   JWT Secret: ${config.jwtSecret ? '✅ Configured' : '❌ Missing'}`);
console.log(`   JWT Expires: ${config.jwtExpiresIn}`); */

module.exports = config;