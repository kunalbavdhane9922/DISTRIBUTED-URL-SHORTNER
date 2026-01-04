const { Pool } = require('pg');
require('dotenv').config();

/**
 * PostgreSQL Connection Pool
 * 
 * Using connection pooling is essential for production:
 * - Reuses connections instead of creating new ones
 * - Limits max connections to prevent database overload
 * - Handles connection failures gracefully
 * 
 * WHERE THIS WILL FAIL AT SCALE:
 * 1. Fixed pool size may not handle traffic spikes
 *    Default max: 10 connections - too low for high traffic
 *    Need to tune based on actual load patterns
 * 
 * 2. No read/write splitting
 *    All queries hit the primary database
 *    Should use separate pools for reads (replicas) and writes (primary)
 * 
 * 3. No connection health checks
 *    Stale connections can cause failures
 *    Should implement connection validation and retries
 * 
 * 4. Pool exhaustion under load
 *    If all connections are busy, new requests queue
 *    Need circuit breakers and timeout handling
 */
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'url_shortener',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection cannot be established
});

// Handle pool errors
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

module.exports = pool;

