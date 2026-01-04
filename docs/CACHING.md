# Caching Strategy

## Overview

The URL shortener uses a **read-through cache pattern** with Redis to dramatically reduce database load for popular URLs.

## Cache Pattern: Read-Through

### How It Works

1. **Cache Hit Flow**:
   - Request arrives for `shortCode`
   - Check Redis cache first
   - If found: Return cached URL immediately (<1ms latency)
   - Skip database SELECT query
   - Still update click_count in database (analytics)
   - Return redirect

2. **Cache Miss Flow**:
   - Request arrives for `shortCode`
   - Check Redis cache first
   - If not found: Query database (10-50ms latency)
   - Store result in cache with TTL
   - Update click_count in database
   - Return redirect
   - Next request will be cache hit

### Cache Hit vs Miss Behavior

**Cache Hit:**
- ✅ Extremely fast (<1ms Redis lookup)
- ✅ No database SELECT query needed
- ✅ Reduces database load by ~90% for hot URLs
- ⚠️ Still requires database UPDATE for analytics

**Cache Miss:**
- ⚠️ Slower (10-50ms database query)
- ✅ Cache is populated for future requests
- ✅ Normal database load for cold URLs

## TTL Strategy

- **Default TTL**: 1 hour (3600 seconds)
- **Configurable**: Set via `CACHE_TTL` environment variable
- **Rationale**: URLs are relatively static, longer TTL improves hit ratio
- **Trade-off**: Balance between cache hit ratio and memory usage

## Cache Invalidation

When a URL is created:
- Cache is invalidated for that `shortCode` (defensive, prevents stale data)
- New URLs don't exist in cache yet, but this handles edge cases

**TODO: Distributed Cache Invalidation**
- Current implementation only invalidates local Redis instance
- Need Redis pub/sub or cache tags for distributed invalidation
- See TODOs in `utils/cache.js`

## Performance Monitoring

Cache statistics are logged every 100 operations:
- Cache hits
- Cache misses
- Cache errors
- Hit ratio percentage

View current stats via `/health` endpoint:
```json
{
  "status": "healthy",
  "database": "connected",
  "cache": {
    "redis": "connected",
    "stats": {
      "hits": 1000,
      "misses": 100,
      "errors": 0,
      "hitRatio": "90.91%",
      "total": 1100
    }
  }
}
```

## Graceful Degradation

If Redis fails or is unavailable:
- System continues to work with database only
- No cache operations block requests
- Errors are logged but don't crash the application
- Connection status is tracked and can be monitored

## Distributed Cache Issues (TODOs)

See detailed TODOs in `utils/cache.js` and `config/redis.js`:

1. **Single Point of Failure**: Need Redis Cluster/Sentinel
2. **Memory Limits**: Need eviction policies (LRU) and capacity planning
3. **Cache Stampede**: No protection when popular URL expires
4. **Distributed Invalidation**: Only invalidates local instance
5. **Multi-Region**: Single region only, need replication strategy

## Configuration

```bash
# Redis connection
REDIS_HOST=localhost
REDIS_PORT=6379

# Cache TTL (seconds)
CACHE_TTL=3600
```

