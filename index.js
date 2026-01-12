// server.js
// server.js
const express = require('express');
const path = require('path');
const app = express();
const dataRoutes = require('./routes/authentication');
const cors = require('cors');
const bodyParser = require('body-parser');


// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
// Routes
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

