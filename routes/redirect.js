const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { getUrlFromCache, setUrlInCache } = require('../utils/cache');
const { asyncHandler, DatabaseError } = require('../middleware/errorHandler');
const { redirectRateLimiter } = require('../middleware/rateLimiter');
const { dbCircuitBreaker } = require('../utils/circuitBreaker');

/**
 * GET /:shortCode
 * 
 * Redirects to the original URL associated with the short code
 * 
 * Response: 302 redirect to original URL
 * 
 * HOW IT WORKS (with Read-Through Cache):
 * 1. Extract shortCode from URL parameter
 * 2. Check Redis cache for cached URL
 * 3a. CACHE HIT: Return cached URL immediately (no DB query)
 * 3b. CACHE MISS: Query database for original_url
 * 4. On cache miss: Store URL in cache for future requests (with TTL)
 * 5. Increment click_count (analytics)
 * 6. Redirect to original URL with HTTP 302
 * 
 * CACHE HIT BEHAVIOR:
 * - Request arrives for shortCode
 * - Cache lookup returns URL (<1ms latency)
 * - Skip database query (reduces DB load by ~90% for hot URLs)
 * - Increment click_count (still need analytics)
 * - Return redirect immediately
 * 
 * CACHE MISS BEHAVIOR:
 * - Request arrives for shortCode
 * - Cache lookup returns null
 * - Query database for URL (10-50ms latency)
 * - Store URL in cache with TTL (1 hour default)
 * - Increment click_count
 * - Return redirect
 * - Next request will be cache hit (until TTL expires)
 * 
 * WHY THIS APPROACH WORKS:
 * - Read-through pattern: Cache is transparent to caller
 * - Graceful degradation: If Redis fails, falls back to database
 * - Reduces database load dramatically for popular URLs
 * - HTTP 302 is standard for temporary redirects
 * - Click tracking provides basic analytics (still query DB for this)
 * 
 * WHERE IT WILL FAIL AT SCALE:
 * 
 * 1. DATABASE BECOMES BOTTLENECK:
 *    Every redirect = 2 database queries (SELECT + UPDATE)
 *    At 100k redirects/sec, database cannot keep up
 *    Solution: Cache hot URLs in Redis (will implement later)
 * 
 * 2. CLICK_COUNT UPDATE CONTENTION:
 *    UPDATE with increment causes row-level locks
 *    Popular URLs get hit thousands of times per second
 *    All those UPDATEs queue, causing latency
 *    Solution: Async analytics updates, separate analytics DB, or probabilistic updates
 * 
 * 3. CACHING IMPROVEMENTS (✅ IMPLEMENTED):
 *    ✅ Read-through cache reduces DB load by ~90% for hot URLs
 *    ✅ Cache hit ratio should be 80-95% in production
 *    ✅ Graceful degradation to database if Redis fails
 *    ⚠️ TODO: No protection against cache stampede (see cache.js TODOs)
 * 
 * 4. SYNCHRONOUS ANALYTICS:
 *    Click count update blocks the redirect response
 *    Analytics should be fire-and-forget, not block user experience
 *    Solution: Message queue (Kafka, RabbitMQ) or async worker
 * 
 * 5. INDEX BLOAT:
 *    As table grows, index on short_code grows
 *    At billions of rows, index maintenance becomes expensive
 *    Solution: Table partitioning, index optimization
 * 
 * 6. NO RATE LIMITING:
 *    Attacker can hammer endpoint to DoS database
 *    Need per-IP rate limiting and circuit breakers
 * 
 * 7. NO SHORT CODE VALIDATION:
 *    Invalid short codes still hit database
 *    Should validate format before query (regex or length check)
 *    Saves database resources
 * 
 * 8. HTTP 302 vs 301:
 *    Using 302 (temporary) but could use 301 (permanent)
 *    301 would allow browser caching, reducing server load
 *    But 302 gives more control (can change destination later)
 *    Trade-off: server load vs flexibility
 * 
 * 9. NO ERROR HANDLING FOR MISSING URLS:
 *    Returns 500 error, should return 404 for not found
 *    Better UX and doesn't pollute error logs
 */
// Apply rate limiting to redirect endpoint
router.get('/:shortCode', redirectRateLimiter, asyncHandler(async (req, res) => {
    const { shortCode } = req.params;

    // Basic validation - short code shouldn't be empty
    // SCALING ISSUE: Should validate format/length before DB query
    // Could save many unnecessary database calls
    if (!shortCode || shortCode.length === 0) {
        return res.status(400).json({ error: 'Short code is required' });
    }

    // READ-THROUGH CACHE: Check cache first
    // CACHE HIT: Returns {url, id} immediately, no DB query needed
    // CACHE MISS: Returns null, we'll query DB and populate cache
    const cachedData = await getUrlFromCache(shortCode);
    let original_url;
    let id;

    // CACHE MISS: Query database and populate cache
    if (!cachedData) {
        const client = await dbCircuitBreaker.execute(
            () => pool.connect(),
            () => {
                throw new DatabaseError('Database service temporarily unavailable');
            }
        );
        
        try {
            // Query for the original URL and ID
            const result = await client.query(
                'SELECT original_url, id FROM urls WHERE short_code = $1',
                [shortCode]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Short URL not found' });
            }

            original_url = result.rows[0].original_url;
            id = result.rows[0].id;
            
            // Populate cache for future requests (read-through pattern)
            // Store both URL and ID to avoid second DB query on cache hit
            // TTL: 1 hour (default)
            await setUrlInCache(shortCode, original_url, id);
            
        } finally {
            client.release();
        }
    } else {
        // CACHE HIT: Use cached data (URL + ID)
        // No database query needed - reduces load significantly
        original_url = cachedData.url;
        id = cachedData.id;
    }

    // Update click count for analytics
    // NOTE: We still need DB connection even on cache hit for analytics
    // TODO: Could move analytics to async queue to avoid blocking redirect
    // Use circuit breaker with graceful degradation - don't fail redirect if analytics fail
    let client = null;
    
    try {
        client = await dbCircuitBreaker.execute(
            () => pool.connect(),
            () => {
                // Circuit breaker open - skip analytics, return null to signal skip
                console.warn('Database circuit breaker open, skipping analytics');
                return null;
            }
        );
        
        // If client is null, circuit breaker is open - skip analytics
        if (client) {
            // SCALING ISSUE: This UPDATE causes row-level lock contention
            // Popular URLs (millions of clicks) create hotspot
            // All UPDATEs serialize, causing latency spikes
            // Solution: Batch updates, async processing, or probabilistic updates
            // For now, we do it synchronously (blocks redirect)
            await client.query(
                'UPDATE urls SET click_count = click_count + 1 WHERE id = $1',
                [id]
            );
        }
    } catch (error) {
        // If it's a database error, log but don't fail redirect
        // Analytics failure should not prevent redirect
        if (error instanceof DatabaseError) {
            console.warn('Database error during analytics, redirecting anyway:', error.message);
        } else {
            // Unexpected error - still redirect, but log it
            console.error('Unexpected error during analytics:', error);
        }
    } finally {
        if (client) {
            client.release();
        }
    }

    // Redirect to original URL (always, even if analytics failed)
    // Using 302 (temporary redirect) instead of 301 (permanent)
    // Trade-off: 301 allows browser caching (less server load)
    // But 302 gives flexibility to change destination later
    res.redirect(302, original_url);
}));

module.exports = router;

