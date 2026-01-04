const { createClient } = require('redis');
require('dotenv').config();

/**
 * Redis Client Configuration
 * 
 * WHY WE NEED REDIS:
 * - URL lookups are read-heavy (10:1 or 100:1 read:write ratio typical)
 * - Caching hot URLs in Redis reduces database load dramatically
 * - Sub-millisecond latency vs 10-50ms database queries
 * 
 * DISTRIBUTED CACHE ISSUES (TODOs for future):
 * 
 * TODO: Single Redis instance is a single point of failure
 *   - Need Redis Cluster or Sentinel for high availability
 *   - Current implementation: Falls back to database on Redis failure (graceful degradation)
 * 
 * TODO: Memory limits - Redis is in-memory
 *   - Need eviction policies (LRU) configured in Redis
 *   - Capacity planning required based on cache size and TTL
 *   - Can't cache everything, need smart cache strategy (currently caching all lookups)
 * 
 * TODO: Cache stampede on cold starts
 *   - If cache expires for popular URL, all requests hit DB simultaneously
 *   - Solution: Cache warming, probabilistic early expiration, or request coalescing
 *   - Current implementation: No protection against stampede
 * 
 * TODO: Cache invalidation in distributed systems
 *   - When URL is updated/deleted, need to invalidate cache across all instances
 *   - Current implementation: Only invalidates local cache on same instance
 *   - Solution: Use Redis pub/sub or cache tags for distributed invalidation
 * 
 * TODO: Cache consistency across regions
 *   - Multi-region deployments need cache replication or invalidation
 *   - Current implementation: Single region only
 */
const redisClient = createClient({
    socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
    }
});

// Handle connection errors - log but don't crash
// Cache failures should gracefully degrade to database
redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err.message);
    // Don't throw - allow graceful degradation to database
});

// Connect to Redis (non-blocking)
// If connection fails, we'll handle it gracefully in cache service
let isConnected = false;
redisClient.connect().then(() => {
    isConnected = true;
    console.log('Redis connected successfully');
}).catch((err) => {
    console.warn('Redis connection failed, will use database only:', err.message);
    isConnected = false;
});

// Export client and connection status
module.exports = {
    client: redisClient,
    isConnected: () => isConnected,
    setConnected: (status) => { isConnected = status; }
};

