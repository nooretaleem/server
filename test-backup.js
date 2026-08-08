// backend/test-backup.js
const path = require('path');
const fs = require('fs');

// Load environment variables from .env file
require('dotenv').config();

// Add the server directory to module paths
const serverDir = __dirname;
process.chdir(serverDir);

// Now require the backup service
const backupService = require('./services/backupService');

async function testBackup() {
    console.log('🧪 Testing MySQL backup service...');
    console.log('='.repeat(50));
    console.log('Server directory:', serverDir);
    console.log('Backup directory:', backupService.backupDir);

    // Check database configuration
    console.log('\n📋 Database Configuration:');
    console.log(`DB_HOST: ${process.env.DB_HOST || 'localhost'}`);
    console.log(`DB_PORT: ${process.env.DB_PORT || '3306'}`);
    console.log(`DB_USER: ${process.env.DB_USER || 'avintest'}`);
    console.log(`DB_NAME: ${process.env.DB_NAME || 'dbname'}`);
    console.log(`DB_PASSWORD: ${process.env.DB_PASSWORD ? '✅ Set' : '❌ Not set'}`);
    console.log('='.repeat(50));

    try {
        const result = await backupService.manualBackup();
        console.log('\n📊 Result:', result);

        // Get backup list
        const backups = backupService.getBackupList();
        console.log(`\n📁 Recent backups (${backups.length} total):`);
        backups.slice(0, 5).forEach(b => {
            console.log(`  - ${b.name} (${b.size}) - ${b.created}`);
        });

        console.log('\n✅ Backup test completed successfully!');
    } catch (error) {
        console.error('\n❌ Backup test failed:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Run the test
testBackup();