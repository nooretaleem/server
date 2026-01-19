// server.js
// server.js
const express = require('express');
const path = require('path');
const app = express();
const dataRoutes = require('./routes/authentication');
const cors = require('cors');
const bodyParser = require('body-parser');


// Middleware
// CORS configuration to allow frontend origin
const corsOptions = {
  origin: [
    'http://localhost:4200',
    'http://localhost:5000',
    'https://zeeshanpetrolium.vercel.app',
    'https://www.zeeshanpetrolium.vercel.app'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'token'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

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
  console.log('⚠️  Running on Vercel - Static file serving disabled (use cloud storage URLs)');
}

// Routes (must be after static file serving)
app.use('/api', dataRoutes);

// Serve static files from the 'dist' directory
app.use(express.static(path.join(__dirname, 'public')));

// Define a route handler for the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'erp', 'index.html'));
});

// Start the server on port 5000
const PORT = process.env.PORT || 5000;

// Initialize database connection (this will trigger the connection log)
const db = require('./models/db');

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(`🚀 POL Server is running on port ${PORT}`);
  console.log('═══════════════════════════════════════════════════════');
});

