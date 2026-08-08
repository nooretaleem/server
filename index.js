// server.js
// server.js
const express = require('express');
const path = require('path');
const app = express();
const dataRoutes = require('./routes/authentication');
const cors = require('cors');
const bodyParser = require('body-parser');
const backupService = require('./services/backupService');


// Middleware
// CORS configuration to allow frontend origin
const allowedOrigins = new Set([
  'http://localhost:4200',
  'http://localhost:5000',
  'https://zeeshanpetrolium.vercel.app',
  'https://www.zeeshanpetrolium.vercel.app',
  'https://zeeshanpetroerp.vercel.app',
  'https://www.zeeshanpetroerp.vercel.app',
  'https://demopetrofrontend.vercel.app',
]);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser clients/tools that don't send Origin header.
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.has(normalizedOrigin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'token'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve uploaded QR code images BEFORE API routes to avoid route conflicts
// Only serve static files in local development (not on Vercel)
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV;

if (!isVercel) {
  const uploadsPath = path.join(__dirname, 'uploads');
  console.log('Static file serving configured for uploads at:', uploadsPath);

  app.use('/uploads', (req, res, next) => {
    console.log('Static file request:', req.url);
    next();
  }, express.static(uploadsPath, {
    setHeaders: (res, filePath) => {
      // Set proper headers for images
      if (filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.jpeg') || filePath.endsWith('.gif') || filePath.endsWith('.webp')) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
    }
  }));
} else {
  console.log('  Running on Vercel - Static file serving disabled (use cloud storage URLs)');
}

// Routes (must be after static file serving)
app.use('/api', dataRoutes);

// Serve static files from the 'dist' directory
app.use(express.static(path.join(__dirname, 'public')));

// Define a route handler for the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'erp', 'index.html'));
});

//  START BACKUP SERVICE (add this)
if (process.env.NODE_ENV !== 'development') {
  backupService.startSchedule();
}

// Optional: Manual backup endpoint (for admin use)
/* app.post('/api/admin/backup', async (req, res) => {
  try {
    await backupService.manualBackup();
    res.json({ message: 'Manual backup triggered successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}); */
// Start the server on port 5000
const PORT = process.env.PORT || 5000;

// Initialize database connection (this will trigger the connection log)
const db = require('./models/db');


// Add this route for manual backup
app.post('/api/admin/backup/manual', async (req, res) => {
  try {
    const result = await backupService.manualBackup();
    res.json({
      success: true,
      message: 'Manual backup triggered successfully',
      result: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Get backup list endpoint
app.get('/api/admin/backups', async (req, res) => {
  try {
    const fs = require('fs-extra');
    const path = require('path');
    const backupDir = path.join(__dirname, 'backup');

    const files = fs.readdirSync(backupDir);
    const backups = files.map(file => {
      const stats = fs.statSync(path.join(backupDir, file));
      return {
        name: file,
        size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
        created: stats.mtime
      };
    }).sort((a, b) => b.created - a.created);

    res.json(backups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(` POL Server is running on port ${PORT}`);
  console.log('═══════════════════════════════════════════════════════');
});

