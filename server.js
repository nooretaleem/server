// server.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const dataRoutes = require('./routes/authentication');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.use('/api', dataRoutes);

// Static files (optional, Vercel usually serves frontend separately)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send("API is running");
});

// DB init
require('./models/db');

// Export app for Vercel
module.exports = app;
