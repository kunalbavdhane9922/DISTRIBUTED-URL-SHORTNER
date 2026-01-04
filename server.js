const express = require('express');
const pool = require('./config/database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json()); // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Routes
const shortenRouter = require('./routes/shorten');
const redirectRouter = require('./routes/redirect');

app.use('/shorten', shortenRouter);
app.use('/', redirectRouter); // Short code redirects at root

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        // Simple database connectivity check
        await pool.query('SELECT 1');
        
        const { getCacheStats } = require('./utils/cache');
        const { isConnected } = require('./config/redis');
        const cacheStats = getCacheStats();
        
        res.status(200).json({ 
            status: 'healthy', 
            database: 'connected',
            cache: {
                redis: isConnected() ? 'connected' : 'disconnected',
                stats: cacheStats
            }
        });
    } catch (error) {
        res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
    }
});

// 404 handler (must be before error handler)
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
app.use(notFoundHandler);

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
    console.log(`URL Shortener server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Shorten endpoint: POST http://localhost:${PORT}/shorten`);
    console.log(`Redirect endpoint: GET http://localhost:${PORT}/:shortCode`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    await pool.end(); // Close database connections
    
    // Close Redis connection
    const { client: redisClient } = require('./config/redis');
    try {
        await redisClient.quit();
        console.log('Redis connection closed');
    } catch (error) {
        console.error('Error closing Redis connection:', error);
    }
    
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received: closing HTTP server');
    await pool.end();
    
    // Close Redis connection
    const { client: redisClient } = require('./config/redis');
    try {
        await redisClient.quit();
        console.log('Redis connection closed');
    } catch (error) {
        console.error('Error closing Redis connection:', error);
    }
    
    process.exit(0);
});

module.exports = app;

