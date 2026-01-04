/**
 * Cache Service - Read-Through Cache Pattern
 * 
 * READ-THROUGH CACHE BEHAVIOR:
 * 
 * Cache Hit:
 * - Request comes in for shortCode
 * - Check Redis cache first
 * - If found (cache hit): Return cached URL immediately
 * - No database query needed - reduces load by ~90% for hot URLs
 * - Latency: <1ms (Redis) vs 10-50ms (database)
 * 
 * Cache Miss:
 * - Request comes in for shortCode
 * - Check Redis cache first
 * - If not found (cache miss): Query database
 * - Store result in cache for future requests
 * - Return URL to client
 * - Next request will be a cache hit (until TTL expires)
 * 
 * TTL STRATEGY:
 * - Default TTL: 1 hour (3600 seconds)
 * - URLs are relatively static, so longer TTL is acceptable
 * - Balance between cache hit ratio and memory usage
 * - Can be configured via CACHE_TTL env variable
 * 
 * CACHE INVALIDATION:
 * - When URL is created/updated: Invalidate cache for that shortCode
 * - Prevents serving stale data
 * - Currently only invalidates local cache (see TODOs for distributed)
 */

const { client: redisClient, isConnected, setConnected } = require('../config/redis');

// Cache key prefix to namespace our keys
const CACHE_PREFIX = 'url:';
// Default TTL: 1 hour (can be overridden via env)
const DEFAULT_TTL = parseInt(process.env.CACHE_TTL || '3600', 10);

// Cache statistics for performance monitoring
const stats = {
    hits: 0,
    misses: 0,
    errors: 0
};

/**
 * Get cache key for a short code
 * 
 * @param {string} shortCode - The short code
 * @returns {string} Cache key
 */
function getCacheKey(shortCode) {
    return `${CACHE_PREFIX}${shortCode}`;
}

/**
 * Get URL from cache (read-through pattern)
 * 
 * CACHE HIT BEHAVIOR:
 * - Returns cached data (URL + ID) immediately
 * - No database query
 * - Fast response time (<1ms)
 * 
 * CACHE MISS BEHAVIOR:
 * - Returns null
 * - Caller should query database
 * - Cache will be populated by setUrlInCache after DB query
 * 
 * @param {string} shortCode - The short code to look up
 * @returns {Promise<{url: string, id: string}|null>} Cached data or null if not found
 */
async function getUrlFromCache(shortCode) {
    // Graceful degradation: If Redis is not connected, return null (cache miss)
    // This allows the system to continue working with database only
    if (!isConnected()) {
        return null;
    }

    try {
        const cacheKey = getCacheKey(shortCode);
        const cachedData = await redisClient.get(cacheKey);
        
        if (cachedData) {
            // Cache hit - log for performance monitoring
            stats.hits++;
            if (stats.hits % 100 === 0) {
                logCacheStats();
            }
            // Parse JSON (stored as {url: string, id: string})
            return JSON.parse(cachedData);
        } else {
            // Cache miss - log for performance monitoring
            stats.misses++;
            if (stats.misses % 100 === 0) {
                logCacheStats();
            }
            return null;
        }
    } catch (error) {
        // Redis error - log but don't fail the request
        // Graceful degradation: return null so caller uses database
        stats.errors++;
        console.error('Cache get error:', error.message);
        
        // Mark as disconnected if connection error
        if (error.code === 'ECONNREFUSED' || error.code === 'NR_CLOSED') {
            setConnected(false);
        }
        
        return null;
    }
}

/**
 * Store URL in cache with TTL
 * 
 * Called after database query on cache miss to populate cache
 * for future requests
 * 
 * @param {string} shortCode - The short code
 * @param {string} originalUrl - The original URL to cache
 * @param {string|number} id - The database ID (for analytics updates)
 * @param {number} ttlSeconds - Time to live in seconds (optional, uses default if not provided)
 * @returns {Promise<void>}
 */
async function setUrlInCache(shortCode, originalUrl, id, ttlSeconds = DEFAULT_TTL) {
    // Graceful degradation: If Redis is not connected, silently fail
    // System continues to work with database only
    if (!isConnected()) {
        return;
    }

    try {
        const cacheKey = getCacheKey(shortCode);
        // Store as JSON object containing both URL and ID
        // This avoids second DB query on cache hit (for click_count update)
        const cacheData = JSON.stringify({ url: originalUrl, id: id.toString() });
        await redisClient.setEx(cacheKey, ttlSeconds, cacheData);
    } catch (error) {
        // Redis error - log but don't fail the request
        // Cache write failures are non-critical (we still have database)
        stats.errors++;
        console.error('Cache set error:', error.message);
        
        // Mark as disconnected if connection error
        if (error.code === 'ECONNREFUSED' || error.code === 'NR_CLOSED') {
            setConnected(false);
        }
    }
}

/**
 * Invalidate cache for a short code
 * 
 * Called when URL is created/updated/deleted to prevent serving stale data
 * 
 * TODO: DISTRIBUTED CACHE INVALIDATION
 * - Current implementation only invalidates local Redis instance
 * - In distributed systems, need to invalidate across all instances
 * - Solutions:
 *   1. Redis pub/sub to broadcast invalidation events
 *   2. Cache tags/namespaces for bulk invalidation
 *   3. Version-based cache keys with TTL (eventual consistency)
 * 
 * @param {string} shortCode - The short code to invalidate
 * @returns {Promise<void>}
 */
async function invalidateCache(shortCode) {
    // Graceful degradation: If Redis is not connected, silently fail
    if (!isConnected()) {
        return;
    }

    try {
        const cacheKey = getCacheKey(shortCode);
        await redisClient.del(cacheKey);
    } catch (error) {
        // Redis error - log but don't fail the request
        stats.errors++;
        console.error('Cache invalidation error:', error.message);
        
        // Mark as disconnected if connection error
        if (error.code === 'ECONNREFUSED' || error.code === 'NR_CLOSED') {
            setConnected(false);
        }
    }
}

/**
 * Log cache performance statistics
 * 
 * Helps monitor cache effectiveness (hit ratio, error rate)
 */
function logCacheStats() {
    const total = stats.hits + stats.misses;
    if (total === 0) return;
    
    const hitRatio = ((stats.hits / total) * 100).toFixed(2);
    const missRatio = ((stats.misses / total) * 100).toFixed(2);
    
    console.log(`Cache Stats - Hits: ${stats.hits} (${hitRatio}%), Misses: ${stats.misses} (${missRatio}%), Errors: ${stats.errors}`);
}

/**
 * Get current cache statistics
 * 
 * @returns {Object} Cache statistics
 */
function getCacheStats() {
    const total = stats.hits + stats.misses;
    const hitRatio = total > 0 ? (stats.hits / total) * 100 : 0;
    
    return {
        hits: stats.hits,
        misses: stats.misses,
        errors: stats.errors,
        hitRatio: hitRatio.toFixed(2) + '%',
        total
    };
}

/**
 * Reset cache statistics (useful for testing)
 */
function resetCacheStats() {
    stats.hits = 0;
    stats.misses = 0;
    stats.errors = 0;
}

module.exports = {
    getUrlFromCache,
    setUrlInCache,
    invalidateCache,
    getCacheStats,
    resetCacheStats,
    logCacheStats,
    DEFAULT_TTL
};

