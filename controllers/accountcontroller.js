const db = require('../models/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Check if running on Vercel
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV;

// Configure multer storage based on environment
let storage;

if (isVercel) {
  // For Vercel: Use memory storage and upload to cloud storage
  // Note: You'll need to implement cloud storage (AWS S3, Cloudinary, or Vercel Blob)
  console.warn('⚠️  Running on Vercel - File storage requires cloud storage setup');
  console.warn('⚠️  Current implementation uses memory storage (files will be lost)');
  console.warn('⚠️  Please configure cloud storage (AWS S3, Cloudinary, or Vercel Blob)');
  
  // Use memory storage as fallback (files will be lost when function ends)
  // TODO: Implement cloud storage upload
  storage = multer.memoryStorage();
} else {
  // For local development: Use disk storage
  storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, '../uploads/qrcodes/');
      // Create directory if it doesn't exist
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      // Generate unique filename: timestamp-accountId-originalname
      const accountId = req.params.id || 'unknown';
      const uniqueSuffix = Date.now() + '-' + accountId;
      const ext = path.extname(file.originalname);
      cb(null, uniqueSuffix + ext);
    }
  });
}

// File filter to accept only images
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  
  if (extname && mimetype) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files (jpeg, jpg, png, gif, webp) are allowed!'));
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: fileFilter
});

// Get all accounts for a specific bank (only active ones)
exports.getAccounts = async (req, res) => {
    try {
        const bankId = req.query.bankId;
        if (!bankId) {
            return res.status(400).json({ message: 'Bank ID is required' });
        }

        const query = `
            SELECT 
                a.ID,
                a.BankID,
                a.AccountNo,
                a.AccountTitle,
                a.Balance,
                a.QrImagePath,
                a.CD,
                a.MD,
                a.active,
                COALESCE(COUNT(t.ID), 0) as transactionCount
            FROM accounts a
            LEFT JOIN transactions t ON t.AccountID = a.ID AND t.active = 1
            WHERE a.BankID = ? AND a.active = 1
            GROUP BY a.ID, a.BankID, a.AccountNo, a.AccountTitle, a.Balance, a.QrImagePath, a.CD, a.MD, a.active
            ORDER BY a.ID DESC
        `;
        const [rows] = await db.execute(query, [bankId]);
        
        // Add hasReferences flag to each account
        const accountsWithReferences = rows.map(account => ({
            ...account,
            transactionCount: parseInt(account.transactionCount) || 0,
            hasReferences: (parseInt(account.transactionCount) || 0) > 0
        }));
        
        res.json(accountsWithReferences);
    } catch (err) {
        console.error('Error fetching accounts:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.json([]);
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Get single account by ID
exports.getAccount = async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) {
            return res.status(400).json({ message: 'Account ID is required' });
        }

        const query = `
            SELECT 
                ID,
                BankID,
                AccountNo,
                AccountTitle,
                Balance,
                QrImagePath,
                CD,
                MD,
                active
            FROM accounts
            WHERE ID = ? AND active = 1
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }
        
        // Check if account has references in transactions table
        const [transactionRows] = await db.execute(
            'SELECT COUNT(*) as count FROM transactions WHERE AccountID = ? AND active = 1',
            [id]
        );
        const transactionCount = transactionRows[0]?.count || 0;
        const hasReferences = transactionCount > 0;

        const accountData = rows[0];
        accountData.hasReferences = hasReferences;
        accountData.transactionCount = transactionCount;
        accountData.paymentCount = 0;
        
        res.json(accountData);
    } catch (err) {
        console.error('Error fetching account:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Add new account
exports.addAccount = async (req, res) => {
    try {
        const {
            BankID,
            AccountNo,
            AccountTitle,
            Balance
        } = req.body;

        if (!BankID) {
            return res.status(400).json({ message: 'Bank ID is required' });
        }
        if (!AccountNo) {
            return res.status(400).json({ message: 'Account number is required' });
        }
        if (!AccountTitle) {
            return res.status(400).json({ message: 'Account title is required' });
        }

        // Get bank branch to check for duplicates within same bank and branch
        const [bankRows] = await db.execute('SELECT Branch FROM bank WHERE ID = ? AND active = 1', [BankID]);
        if (bankRows.length === 0) {
            return res.status(404).json({ message: 'Bank not found' });
        }
        const bankBranch = bankRows[0].Branch || null;

        // Check for duplicate account number or account title in the same bank and branch
        const duplicateCheckQuery = `
            SELECT a.ID, a.AccountNo, a.AccountTitle, b.Branch
            FROM accounts a
            INNER JOIN bank b ON a.BankID = b.ID
            WHERE a.BankID = ? 
              AND (a.AccountNo = ? OR a.AccountTitle = ?)
              AND a.active = 1
              AND (b.Branch = ? OR (b.Branch IS NULL AND ? IS NULL))
        `;
        const [duplicateRows] = await db.execute(duplicateCheckQuery, [
            BankID,
            AccountNo,
            AccountTitle,
            bankBranch,
            bankBranch
        ]);

        if (duplicateRows.length > 0) {
            const duplicate = duplicateRows[0];
            if (duplicate.AccountNo === AccountNo && duplicate.AccountTitle === AccountTitle) {
                return res.status(400).json({ 
                    message: 'An account with the same account number and account title already exists in this bank branch.' 
                });
            } else if (duplicate.AccountNo === AccountNo) {
                return res.status(400).json({ 
                    message: 'An account with the same account number already exists in this bank branch.' 
                });
            } else if (duplicate.AccountTitle === AccountTitle) {
                return res.status(400).json({ 
                    message: 'An account with the same account title already exists in this bank branch.' 
                });
            }
        }

        const query = `
            INSERT INTO accounts (BankID, AccountNo, AccountTitle, Balance, active) 
            VALUES (?, ?, ?, ?, 1)
        `;

        const [result] = await db.execute(query, [
            BankID,
            AccountNo,
            AccountTitle,
            Balance || 0
        ]);

        res.json({
            message: 'Account added successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('Error adding account:', err);
        if (err.code === 'ER_NO_SUCH_TABLE') {
            res.status(500).json({ message: 'accounts table does not exist. Please create the table first.' });
        } else {
            res.status(500).json({ message: 'Server Error', error: err.message });
        }
    }
};

// Update account
exports.updateAccount = async (req, res) => {
    try {
        const {
            ID,
            BankID,
            AccountNo,
            AccountTitle,
            Balance
        } = req.body;

        if (!ID) {
            return res.status(400).json({ message: 'Account ID is required' });
        }
        if (!AccountNo) {
            return res.status(400).json({ message: 'Account number is required' });
        }
        if (!AccountTitle) {
            return res.status(400).json({ message: 'Account title is required' });
        }

        // Get current account's bank to check for duplicates
        const [currentAccount] = await db.execute('SELECT BankID FROM accounts WHERE ID = ? AND active = 1', [ID]);
        if (currentAccount.length === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }
        const accountBankID = BankID || currentAccount[0].BankID;

        // Get bank branch to check for duplicates within same bank and branch
        const [bankRows] = await db.execute('SELECT Branch FROM bank WHERE ID = ? AND active = 1', [accountBankID]);
        if (bankRows.length === 0) {
            return res.status(404).json({ message: 'Bank not found' });
        }
        const bankBranch = bankRows[0].Branch || null;

        // Check if account is referenced in transactions
        const [transactionRows] = await db.execute(
            'SELECT COUNT(*) as count FROM transactions WHERE AccountID = ? AND active = 1',
            [ID]
        );
        const transactionCount = transactionRows[0]?.count || 0;
        const hasReferences = transactionCount > 0;

        // If account has references, only allow updating AccountTitle (name)
        if (hasReferences) {
            // Check if user is trying to change AccountNo or Balance
            const [currentAccountData] = await db.execute(
                'SELECT AccountNo, Balance FROM accounts WHERE ID = ? AND active = 1',
                [ID]
            );

            if (currentAccountData.length === 0) {
                return res.status(404).json({ message: 'Account not found' });
            }

            const currentAccountNo = currentAccountData[0].AccountNo;
            const currentBalance = parseFloat(currentAccountData[0].Balance || 0);
            const newBalance = parseFloat(Balance || 0);

            // If trying to change AccountNo or Balance, show error
            if (AccountNo !== currentAccountNo) {
                return res.status(400).json({ 
                    message: `Cannot change account number. This account is currently being used in ${transactionCount} transaction${transactionCount > 1 ? 's' : ''}.` 
                });
            }

            if (Math.abs(newBalance - currentBalance) > 0.01) {
                return res.status(400).json({ 
                    message: `Cannot change account balance. This account is currently being used in ${transactionCount} transaction${transactionCount > 1 ? 's' : ''}.` 
                });
            }
            // Check for duplicate account title only (AccountNo and Balance cannot be changed)
            const duplicateTitleQuery = `
                SELECT a.ID, a.AccountTitle, b.Branch
                FROM accounts a
                INNER JOIN bank b ON a.BankID = b.ID
                WHERE a.BankID = ? 
                  AND a.ID != ?
                  AND a.AccountTitle = ?
                  AND a.active = 1
                  AND (b.Branch = ? OR (b.Branch IS NULL AND ? IS NULL))
            `;
            const [duplicateTitleRows] = await db.execute(duplicateTitleQuery, [
                accountBankID,
                ID,
                AccountTitle,
                bankBranch,
                bankBranch
            ]);

            if (duplicateTitleRows.length > 0) {
                return res.status(400).json({ 
                    message: 'An account with the same account title already exists in this bank branch.' 
                });
            }

            // Only update AccountTitle, keep AccountNo and Balance unchanged
            const query = `
                UPDATE accounts SET 
                    AccountTitle = ?,
                    MD = NOW()
                WHERE ID = ? AND active = 1
            `;

            const [result] = await db.execute(query, [
                AccountTitle,
                ID
            ]);

            if (result.affectedRows === 0) {
                return res.status(404).json({ message: 'Account not found' });
            }

            return res.json({ 
                message: 'Account title updated successfully. Account number and balance cannot be changed as the account has transaction history.' 
            });
        }

        // If no references, allow full update (including AccountNo and Balance)
        // Check for duplicate account number or account title in the same bank and branch (excluding current account)
        const duplicateCheckQuery = `
            SELECT a.ID, a.AccountNo, a.AccountTitle, b.Branch
            FROM accounts a
            INNER JOIN bank b ON a.BankID = b.ID
            WHERE a.BankID = ? 
              AND a.ID != ?
              AND (a.AccountNo = ? OR a.AccountTitle = ?)
              AND a.active = 1
              AND (b.Branch = ? OR (b.Branch IS NULL AND ? IS NULL))
        `;
        const [duplicateRows] = await db.execute(duplicateCheckQuery, [
            accountBankID,
            ID,
            AccountNo,
            AccountTitle,
            bankBranch,
            bankBranch
        ]);

        if (duplicateRows.length > 0) {
            const duplicate = duplicateRows[0];
            if (duplicate.AccountNo === AccountNo && duplicate.AccountTitle === AccountTitle) {
                return res.status(400).json({ 
                    message: 'An account with the same account number and account title already exists in this bank branch.' 
                });
            } else if (duplicate.AccountNo === AccountNo) {
                return res.status(400).json({ 
                    message: 'An account with the same account number already exists in this bank branch.' 
                });
            } else if (duplicate.AccountTitle === AccountTitle) {
                return res.status(400).json({ 
                    message: 'An account with the same account title already exists in this bank branch.' 
                });
            }
        }

        const query = `
            UPDATE accounts SET 
                AccountNo = ?,
                AccountTitle = ?,
                Balance = ?,
                MD = NOW()
            WHERE ID = ? AND active = 1
        `;

        const [result] = await db.execute(query, [
            AccountNo,
            AccountTitle,
            Balance || 0,
            ID
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }

        res.json({ message: 'Account updated successfully' });
    } catch (err) {
        console.error('Error updating account:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Delete account (soft delete - set Active = 0)
exports.deleteAccount = async (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ message: 'Account ID is required' });
        }

        // Check if account is referenced in transactions table
        const [transactionRows] = await db.execute(
            'SELECT COUNT(*) as count FROM transactions WHERE AccountID = ? AND active = 1',
            [id]
        );
        const transactionCount = transactionRows[0]?.count || 0;

        if (transactionCount > 0) {
            return res.status(400).json({ 
                message: `Cannot delete this account. It is currently being used in ${transactionCount} transaction${transactionCount > 1 ? 's' : ''}.` 
            });
        }

        // Note: AccountID is in transactions table, not payments table

        // Soft delete: set Active = 0 instead of deleting the record
        const [result] = await db.execute('UPDATE accounts SET active = 0, MD = NOW() WHERE ID = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }

        res.json({ message: 'Account deleted successfully' });
    } catch (err) {
        console.error('Error deleting account:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Upload QR code image for an account
exports.uploadQrCode = async (req, res) => {
    try {
        const accountId = req.params.id;
        
        if (!accountId) {
            return res.status(400).json({ message: 'Account ID is required' });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        // Check if account exists
        const [accountRows] = await db.execute(
            'SELECT ID FROM accounts WHERE ID = ? AND active = 1',
            [accountId]
        );

        if (accountRows.length === 0) {
            return res.status(404).json({ message: 'Account not found' });
        }

        // Get old QR image path if exists
        const [oldAccountRows] = await db.execute(
            'SELECT QrImagePath FROM accounts WHERE ID = ?',
            [accountId]
        );
        const oldQrPath = oldAccountRows[0]?.QrImagePath;

        let filePath;

        if (isVercel) {
            // On Vercel: Upload to cloud storage
            // TODO: Implement cloud storage upload (AWS S3, Cloudinary, or Vercel Blob)
            // For now, return error indicating cloud storage is needed
            console.error('⚠️  Vercel deployment detected - Cloud storage required');
            return res.status(501).json({ 
                message: 'File upload not configured for Vercel. Please set up cloud storage (AWS S3, Cloudinary, or Vercel Blob).',
                error: 'Cloud storage not configured',
                hint: 'See VERCEL_DEPLOYMENT.md for setup instructions'
            });
            
            // Example implementation structure (uncomment and configure):
            /*
            const { put } = require('@vercel/blob'); // or AWS S3, Cloudinary, etc.
            const blob = await put(`qrcodes/${Date.now()}-${accountId}.png`, req.file.buffer, {
                access: 'public',
            });
            filePath = blob.url; // Save the cloud URL instead of local path
            */
        } else {
            // Local development: Save to filesystem
            if (!req.file.path) {
                return res.status(500).json({ message: 'File path not available' });
            }

            // Save file path in database (relative path from server root)
            const serverRoot = path.join(__dirname, '../'); // D:\POL\pol\server
            const relativePath = path.relative(serverRoot, req.file.path);
            filePath = relativePath.replace(/\\/g, '/'); // Convert backslashes to forward slashes
            
            console.log('File upload details:');
            console.log('  Server root:', serverRoot);
            console.log('  Full file path:', req.file.path);
            console.log('  Relative path:', relativePath);
            console.log('  Saved path (DB):', filePath);
        }

        await db.execute(
            'UPDATE accounts SET QrImagePath = ?, MD = NOW() WHERE ID = ?',
            [filePath, accountId]
        );
        
        console.log('QR path saved to database for account:', accountId);

        // Delete old QR image if it exists and is different from new one
        // Use async deletion with retry logic to handle Windows file locking issues
        if (oldQrPath && oldQrPath !== filePath) {
            const deleteOldFile = async (filePathToDelete, retries = 3) => {
                const oldFullPath = path.join(__dirname, '../', filePathToDelete);
                
                if (!fs.existsSync(oldFullPath)) {
                    return; // File doesn't exist, nothing to delete
                }

                for (let i = 0; i < retries; i++) {
                    try {
                        // Use async unlink with a small delay to allow file handles to close
                        await new Promise((resolve, reject) => {
                            fs.unlink(oldFullPath, (err) => {
                                if (err) reject(err);
                                else resolve();
                            });
                        });
                        console.log('Old QR image deleted successfully:', oldFullPath);
                        return; // Success, exit retry loop
                    } catch (unlinkErr) {
                        if (unlinkErr.code === 'EBUSY' || unlinkErr.code === 'ENOENT') {
                            // File is busy (locked) or doesn't exist
                            if (i < retries - 1) {
                                // Wait before retrying (exponential backoff)
                                const delay = Math.pow(2, i) * 100; // 100ms, 200ms, 400ms
                                console.log(`File busy, retrying deletion in ${delay}ms... (attempt ${i + 1}/${retries})`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                            } else {
                                // Last attempt failed, log but don't throw error
                                console.warn('Could not delete old QR image after retries (file may be in use):', oldFullPath);
                                console.warn('Error:', unlinkErr.message);
                            }
                        } else if (unlinkErr.code === 'ENOENT') {
                            // File doesn't exist anymore, that's fine
                            console.log('Old QR image already deleted:', oldFullPath);
                            return;
                        } else {
                            // Other error, log but don't fail the upload
                            console.warn('Error deleting old QR image:', unlinkErr.message);
                            return;
                        }
                    }
                }
            };

            // Delete old file asynchronously (don't block the response)
            deleteOldFile(oldQrPath).catch(err => {
                console.warn('Failed to delete old QR image (non-critical):', err.message);
            });
        }

        // Verify file exists before responding
        if (!fs.existsSync(req.file.path)) {
            console.error('Uploaded file does not exist at path:', req.file.path);
            return res.status(500).json({ 
                message: 'File upload failed - file not found on server',
                error: 'File not found'
            });
        }

        // Return response with file path for debugging
        const response = {
            success: true,
            message: 'QR code uploaded successfully',
            filePath: filePath,
            fullPath: req.file.path,
            accountId: accountId,
            fileSize: req.file.size,
            fileExists: fs.existsSync(req.file.path),
            accessibleUrl: `http://localhost:5000/${filePath}`
        };
        console.log('Upload response:', JSON.stringify(response, null, 2));
        console.log('File accessible at:', `http://localhost:5000/${filePath}`);
        res.json(response);
    } catch (err) {
        console.error('Error uploading QR code:', err);
        // Delete uploaded file on error
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (unlinkErr) {
                console.error('Error deleting file on error:', unlinkErr);
            }
        }
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

// Export multer upload middleware
exports.uploadQrCodeMiddleware = upload.single('qr');

