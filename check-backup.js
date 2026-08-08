// backend/check-backup.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const backupFile = process.argv[2] || 'backup_2026-06-20_13-30.sql.gz';
const backupPath = path.join(__dirname, 'backup', backupFile);

console.log(`📁 Checking backup file: ${backupPath}`);

if (!fs.existsSync(backupPath)) {
    console.error('❌ Backup file not found!');
    process.exit(1);
}

try {
    let content;

    if (backupPath.endsWith('.gz')) {
        // Read compressed file
        const compressed = fs.readFileSync(backupPath);
        content = zlib.gunzipSync(compressed).toString('utf8');
    } else {
        content = fs.readFileSync(backupPath, 'utf8');
    }

    // Check if file has content
    if (!content || content.trim().length === 0) {
        console.log('❌ Backup file is empty!');
        process.exit(1);
    }

    console.log(`📊 Backup file size: ${(content.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`📝 First 500 characters:`);
    console.log('='.repeat(50));
    console.log(content.substring(0, 500));
    console.log('='.repeat(50));

    // Check for CREATE TABLE statements
    const createTableMatches = content.match(/CREATE TABLE/g);
    const insertMatches = content.match(/INSERT INTO/g);

    console.log(`\n📊 Analysis:`);
    console.log(`  - CREATE TABLE statements: ${createTableMatches ? createTableMatches.length : 0}`);
    console.log(`  - INSERT INTO statements: ${insertMatches ? insertMatches.length : 0}`);
    console.log(`  - Total lines: ${content.split('\n').length}`);

    // Check which database is referenced
    const useMatch = content.match(/USE `([^`]+)`/);
    if (useMatch) {
        console.log(`  - Database referenced: ${useMatch[1]}`);
    }

    // Check for table names
    const tableMatches = content.match(/CREATE TABLE `([^`]+)`/g);
    if (tableMatches) {
        const tableNames = tableMatches.map(m => m.replace(/CREATE TABLE `/, '').replace(/`/, ''));
        console.log(`  - Tables found: ${tableNames.join(', ')}`);
    }

} catch (error) {
    console.error('❌ Error reading backup:', error.message);
}