const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { encodeBase62 } = require('../utils/base62');
const { generateId } = require('../utils/idGenerator');
const { invalidateCache } = require('../utils/cache');
const { asyncHandler, DatabaseError } = require('../middleware/errorHandler');
const { shortenRateLimiter } = require('../middleware/rateLimiter');
const { dbCircuitBreaker } = require('../utils/circuitBreaker');

/**
 * POST /shorten
 * 
 * Creates a shortened URL from a long URL
 * 
 * Request body: { url: "https://example.com/very/long/url" }
 * Response: { shortCode: "abc123", shortUrl: "http://localhost:3000/abc123" }
 * 
 * HOW IT WORKS (Updated with Snowflake IDs):
 * 1. Validate input URL
 * 2. Generate Snowflake-style ID (64-bit, timestamp + machine + sequence)
 * 3. Encode the ID to Base62 to create short code
 * 4. Insert URL with ID and short code in single transaction
 * 5. Return the short code and full short URL
 * 
 * WHY THIS APPROACH WORKS:
 * - Snowflake IDs prevent collisions (timestamp + machine ID + sequence)
 * - Handles concurrent requests naturally (sequence counter per millisecond)
 * - Distributed-friendly (each machine generates IDs independently)
 * - Single database roundtrip (generate ID before insert)
 * - Deterministic encoding ensures consistency
 * - Short codes are compact and URL-safe (~10-11 chars)
 * 
 * WHERE IT WILL FAIL AT SCALE:
 * 
 * 1. RACE CONDITIONS:
 *    Two requests with same URL create duplicate entries
 *    Current approach: No deduplication - each request creates new short URL
 *    Solution: Add unique constraint on original_url OR use SELECT + INSERT with ON CONFLICT
 * 
 * 2. SNOWFLAKE ID GENERATION LIMITS:
 *    - Machine ID coordination needed (1024 machines max)
 *    - Sequence overflow: >4096 IDs/ms/machine requires wait (extremely rare)
 *    - Clock skew: Backward clock moves cause errors (mitigated with NTP)
 * 
 * 3. IMPROVEMENTS FROM PREVIOUS APPROACH:
 *    - ✅ No sequence bottleneck (distributed generation)
 *    - ✅ Single database roundtrip (ID generated before insert)
 *    - ✅ Collision prevention (mathematically guaranteed with proper implementation)
 * 
 * 4. NO INPUT VALIDATION SCALE:
 *    URL validation regex can be CPU-intensive for malicious input
 *    Need proper URL parsing library and input sanitization
 *    DoS risk from crafted URLs causing regex backtracking
 * 
 * 5. TRANSACTION OVERHEAD:
 *    Each shorten request is a transaction
 *    At scale, need to batch operations or use lighter transaction model
 * 
 * 6. NO RATE LIMITING:
 *    Single user can create millions of URLs, exhausting resources
 *    Need per-user/IP rate limiting
 * 
 * 7. DATABASE CONNECTION POOL EXHAUSTION:
 *    Each request holds a connection during entire operation
 *    Under load, pool may exhaust, causing request queuing
 */
// Apply rate limiting to shorten endpoint
router.post('/shorten', shortenRateLimiter, asyncHandler(async (req, res) => {
    const { url } = req.body;

    // Basic URL validation
    // SCALING ISSUE: Simple regex doesn't handle all edge cases
    // Should use proper URL parsing library (like 'url' or 'valid-url')
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required and must be a string' });
    }

    // Basic URL format validation
    try {
        new URL(url); // Throws if invalid URL
    } catch (error) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Use circuit breaker for database operations
    const client = await dbCircuitBreaker.execute(
        () => pool.connect(),
        () => {
            throw new DatabaseError('Database service temporarily unavailable');
        }
    );

    try {
        // Generate Snowflake ID before database operation
        // This allows us to do a single INSERT with both ID and short_code
        // COLLISION PREVENTION: Snowflake algorithm guarantees uniqueness
        // - Timestamp ensures uniqueness across time
        // - Machine ID ensures uniqueness across machines
        // - Sequence ensures uniqueness within same millisecond on same machine
        let id;
        let shortCode;
        let retries = 0;
        const MAX_RETRIES = 3;

        // Retry loop handles extremely rare cases of:
        // 1. Clock skew (clock moved backward)
        // 2. Database constraint violation (shouldn't happen, but defensive)
        while (retries < MAX_RETRIES) {
            try {
                // Generate unique ID using Snowflake algorithm
                id = generateId();
                
                // Encode to Base62 for URL-safe short code
                // Snowflake IDs are 64-bit, so codes are ~10-11 characters
                shortCode = encodeBase62(id);
                
                break; // Success, exit retry loop
            } catch (idError) {
                // Handle clock skew (extremely rare, only if clock moves backward)
                if (idError.message.includes('Clock moved backward')) {
                    retries++;
                    if (retries >= MAX_RETRIES) {
                        throw new Error('Clock skew detected. Server time synchronization required.');
                    }
                    // Wait a bit and retry
                    await new Promise(resolve => setTimeout(resolve, 1));
                    continue;
                }
                throw idError;
            }
        }

        // Begin transaction for atomicity
        // SCALING ISSUE: Transactions add overhead
        // For truly high scale, might need eventual consistency model
        await client.query('BEGIN');

        // Single INSERT with both ID and short_code
        // IMPROVEMENT: Only one database roundtrip (vs two in previous approach)
        // Snowflake ID is generated in application, so we can insert both together
        await client.query(
            'INSERT INTO urls (id, short_code, original_url) VALUES ($1, $2, $3)',
            [id.toString(), shortCode, url] // Convert BigInt to string for PostgreSQL
        );

        await client.query('COMMIT');

        // CACHE INVALIDATION: New URL doesn't exist in cache yet, but invalidate
        // in case there was a stale entry (defensive programming)
        // This is also useful if we later implement URL update functionality
        await invalidateCache(shortCode);

        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const shortUrl = `${baseUrl}/${shortCode}`;

        res.status(201).json({
            shortCode,
            shortUrl,
            originalUrl: url
        });

    } catch (error) {
        // Rollback transaction if it exists
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            // Ignore rollback errors
        }
        
        // Handle specific error types
        if (error instanceof DatabaseError) {
            throw error; // Re-throw to be handled by error handler
        }
        
        if (error.code === '23505') { // PostgreSQL unique violation
            return res.status(409).json({ error: 'Short code already exists' });
        }

        // Generic database error
        if (error.code && error.code.startsWith('23')) { // PostgreSQL constraint violations
            throw new DatabaseError('Database constraint violation', error);
        }

        // Re-throw to error handler
        throw error;
    } finally {
        client.release();
    }
}));

module.exports = router;

