// server.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const dataRoutes = require('./routes/authentication');


const app = express();

// Middleware
const allowedOrigins = new Set([
  'http://localhost:4200',
  'http://localhost:5000',
  'https://zeeshanpetrolium.vercel.app',
  'https://www.zeeshanpetrolium.vercel.app',
  'https://zeeshanpetroerp.vercel.app',
  'https://www.zeeshanpetroerp.vercel.app',
  'https://demopetrofrontend.vercel.app'
]);

const corsOptions = {
  origin: (origin, callback) => {
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

// Static files (optional, Vercel usually serves frontend separately)
app.use(express.static(path.join(__dirname, 'public')));

// Routes (must be after static file serving)
app.use('/api', dataRoutes);

app.get('/', (req, res) => {
  res.send("API is running");
});

// Test endpoint to verify file serving
app.get('/test-upload/:filename', (req, res) => {
  const fs = require('fs');
  const filePath = path.join(__dirname, 'uploads', 'qrcodes', req.params.filename);
  console.log('Testing file access:', filePath);
  console.log('File exists:', fs.existsSync(filePath));
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found', path: filePath });
  }
});

// DB init
require('./models/db');

// Export app for Vercel
module.exports = app;
