# Scalability Analysis

## Overview

This document explains how the URL shortener handles scale, failures, and horizontal scaling strategies.

---

## Handling 10 Million Requests Per Day

### Request Breakdown

**10M requests/day = ~116 requests/second (average)**
- With 3x peak multiplier: **~350 requests/second peak**
- Typical URL shortener ratio: **90% redirects (reads), 10% creates (writes)**
  - **9M redirects/day** = ~105 req/sec avg, ~315 req/sec peak
  - **1M creates/day** = ~12 req/sec avg, ~35 req/sec peak

### Capacity Analysis

#### Current Architecture Capacity

**Single Instance Capacity:**
- **Express + Node.js**: Can handle 1000-5000 req/sec (depends on hardware)
- **PostgreSQL**: Can handle 500-2000 queries/sec (depends on configuration)
- **Redis**: Can handle 100k+ operations/sec

**Bottlenecks at 350 req/sec peak:**

1. **Database Connection Pool** (Current: 20 connections)
   - **Redirects**: 315 req/sec × 1 query (SELECT) = 315 queries/sec
   - **Creates**: 35 req/sec × 1 query (INSERT) = 35 queries/sec
   - **Analytics**: 315 req/sec × 1 query (UPDATE) = 315 queries/sec
   - **Total**: ~665 queries/sec
   - **With connection pool of 20**: Each connection handles ~33 queries/sec
   - **Verdict**: ✅ **FEASIBLE** with proper pool sizing (increase to 50-100)

2. **Redis Cache Hit Ratio**
   - Expected hit ratio: **85-95%** for popular URLs
   - **Cache hits**: 315 × 0.90 = **283 req/sec** (no DB SELECT)
   - **Cache misses**: 315 × 0.10 = **32 req/sec** (DB SELECT)
   - **Reduces DB load by 90%**: ✅ **HIGHLY EFFECTIVE**

3. **Network I/O**
   - Each request: ~1KB request + ~500B response
   - **315 req/sec × 1.5KB = ~450 KB/sec** = 3.6 Mbps
   - **Verdict**: ✅ **TRIVIAL** (standard connection handles 100+ Mbps)

### Single Instance Verdict: ✅ **HANDLES 10M REQUESTS/DAY**

**Optimizations needed:**
- Increase database connection pool to 50-100
- Ensure Redis has sufficient memory (cache ~1M popular URLs = ~100MB)
- Use connection pooling effectively
- Monitor and tune based on actual traffic patterns

### Horizontal Scaling for Higher Load

**For 100M requests/day (1,160 req/sec peak):**

**Multi-Instance Setup:**
- **3-5 application instances** behind load balancer
- **Read replicas**: 2-3 PostgreSQL read replicas for redirect queries
- **Redis Cluster**: 3-node cluster for shared cache
- **Primary DB**: 1 instance for writes (creates)

**Request Distribution:**
- Load balancer distributes requests across instances
- Each instance handles ~300-400 req/sec
- Cache hit ratio maintained (shared Redis)
- Read replicas distribute SELECT queries

**Key Consideration:**
- Rate limiting is per-instance (in-memory)
  - Each instance enforces limit independently
  - Effective limit = limit × instance_count
  - **Solution**: Use Redis-based rate limiting for shared counters

---

## What Happens When Redis Fails

### Failure Scenarios

#### Scenario 1: Redis Connection Failure at Startup

**Behavior:**
1. Application starts normally
2. Redis connection attempt fails
3. `isConnected()` returns `false`
4. **Cache operations return `null`** (treated as cache miss)
5. All requests fall back to database

**Impact:**
- ✅ **No service disruption** - application continues working
- ⚠️ **Increased database load** - all requests hit database
- ⚠️ **Slightly slower responses** - 10-50ms database queries vs <1ms cache

**Graceful Degradation:**
- Cache `getUrlFromCache()` returns `null` (cache miss)
- Application queries database normally
- No errors thrown, no crashes

#### Scenario 2: Redis Fails Mid-Operation

**Behavior:**
1. Cache operation (get/set) throws error
2. Error is caught in `try-catch`
3. `isConnected()` is set to `false`
4. Subsequent operations return `null` (cache miss)
5. All requests fall back to database

**Impact:**
- ✅ **No service disruption** - errors are swallowed, fallback to DB
- ⚠️ **Temporary spike in database load** during transition
- ✅ **Automatic recovery** - if Redis comes back, cache resumes (requires restart or reconnection logic)

**Code Path:**
```javascript
// utils/cache.js
try {
    const cachedData = await redisClient.get(cacheKey);
    // ... handle cache hit
} catch (error) {
    stats.errors++;
    setConnected(false);  // Mark as disconnected
    return null;           // Fallback to database
}
```

#### Scenario 3: Redis Partial Failure (Slow Responses)

**Current Implementation:**
- No timeout configured
- Requests may hang waiting for Redis
- **Vulnerability**: Slow Redis = slow application

**Recommended Addition:**
- Add timeout to Redis operations (e.g., 10ms)
- If timeout exceeded, treat as cache miss
- Fall back to database

#### Scenario 4: Redis Memory Exhaustion

**Behavior:**
- Redis starts evicting keys (if LRU policy configured)
- Cache hit ratio decreases
- More requests hit database
- **No application failure** - gradual degradation

**Mitigation:**
- Monitor Redis memory usage
- Set appropriate `maxmemory` and `maxmemory-policy`
- Scale Redis or increase memory if needed

### Failure Recovery

**Current State:**
- Once Redis is marked disconnected, it stays disconnected
- Requires application restart to reconnect

**Recommended Enhancement:**
- Periodic reconnection attempts (e.g., every 30 seconds)
- Health check endpoint to test Redis connectivity
- Circuit breaker pattern (already implemented) helps prevent repeated failures

### Summary: Redis Failure Handling

| Scenario | Application Behavior | User Impact | Recovery |
|----------|---------------------|-------------|----------|
| Connection failure | Falls back to DB | Slightly slower (10-50ms) | Manual restart |
| Mid-operation failure | Falls back to DB | Slightly slower | Manual restart |
| Partial failure | May hang (no timeout) | Timeout errors | Timeout needed |
| Memory exhaustion | Cache hit ratio drops | Gradual slowdown | Scale Redis |

**Key Takeaway:** ✅ **Application remains functional** - Redis is a performance optimization, not a dependency for correctness.

---

## Database Sharding Strategy

### Why Shard?

**At scale (billions of URLs):**
- Single database becomes bottleneck
- Index size grows (slower queries)
- Storage limits approached
- Single point of failure

**Sharding splits data across multiple databases** (shards) for:
- Higher throughput
- Lower latency
- Better fault tolerance

### Sharding Strategy: Hash-Based on Short Code

#### Approach

**Shard Key: Short Code (Base62 encoded)**

1. **Hash the short code** to determine shard
2. **Consistent hashing** ensures even distribution
3. **Shard count**: Power of 2 (e.g., 2, 4, 8, 16 shards)

**Example:**
```javascript
function getShard(shortCode, shardCount) {
    const hash = hashString(shortCode);
    return hash % shardCount;  // Returns 0 to shardCount-1
}
```

#### Shard Distribution

**URL Creation:**
1. Generate Snowflake ID (includes timestamp)
2. Encode to Base62 short code
3. Hash short code to determine shard
4. INSERT into that shard's database

**URL Lookup:**
1. Receive short code in request
2. Hash short code to determine shard
3. Query that shard's database
4. Return result

#### Advantages

✅ **Even distribution**: Hash function spreads URLs evenly
✅ **Deterministic routing**: Same short code always goes to same shard
✅ **No cross-shard queries**: Each lookup hits only one shard
✅ **Horizontal scaling**: Add shards as needed

#### Challenges

⚠️ **Resharding complexity**: Moving data between shards is difficult
⚠️ **Uneven distribution**: Hash collisions possible (rare)
⚠️ **Shard discovery**: Application must know which shard to query
⚠️ **Cross-shard operations**: Analytics queries need aggregation

### Implementation Architecture

#### Shard Configuration

```javascript
// config/sharding.js
const SHARDS = [
    { id: 0, host: 'shard0.db.example.com', database: 'url_shortener' },
    { id: 1, host: 'shard1.db.example.com', database: 'url_shortener' },
    { id: 2, host: 'shard2.db.example.com', database: 'url_shortener' },
    { id: 3, host: 'shard3.db.example.com', database: 'url_shortener' }
];
```

#### Routing Logic

```javascript
function getShardConnection(shortCode) {
    const shardIndex = getShard(shortCode, SHARDS.length);
    return SHARDS[shardIndex].connection;
}

// In redirect route:
const shard = getShardConnection(shortCode);
const result = await shard.query('SELECT ... WHERE short_code = $1', [shortCode]);
```

#### Cache Strategy with Sharding

**Cache Key**: Include shard ID or use short code only (works across shards)

**Current cache key**: `url:{shortCode}`
- ✅ Works with sharding (short code is unique globally)
- ✅ No changes needed to cache layer

### Alternative: Range-Based Sharding

**Shard by ID range:**
- Shard 0: IDs 0-1B
- Shard 1: IDs 1B-2B
- etc.

**Pros:**
- Easier to understand
- Can shard by creation time

**Cons:**
- Uneven distribution (new shards fill faster)
- Harder to rebalance

**Verdict**: Hash-based is better for URL shorteners.

### Resharding Strategy

**When adding/removing shards:**

1. **Double shards** (e.g., 4 → 8)
   - New shards handle new URLs (hash % 8)
   - Old shards continue serving existing URLs
   - Migration: Gradually move data from old to new shards

2. **Challenges:**
   - During migration: Some URLs may be on wrong shard
   - Solution: Check both old and new shards during transition
   - Or: Use consistent hashing (ring-based) for smoother transitions

3. **Tools:**
   - Use database replication for initial data copy
   - Write migration scripts to move data
   - Monitor both shards during transition

### Analytics with Sharding

**Challenge**: Analytics queries need data from all shards

**Solutions:**

1. **Separate Analytics Database**
   - Stream click events to analytics DB (not sharded)
   - Run analytics queries on analytics DB
   - ✅ Simple, doesn't affect main queries

2. **Federated Queries**
   - Query all shards in parallel
   - Aggregate results in application
   - ⚠️ More complex, slower

3. **Read Replicas with Materialized Views**
   - Each shard has read replica
   - Materialized views aggregate per shard
   - Aggregate across shards
   - ⚠️ Complex setup

**Recommendation**: Use separate analytics database with event streaming.

### Sharding Summary

| Aspect | Hash-Based Sharding |
|--------|-------------------|
| **Shard Key** | Short code (Base62) |
| **Distribution** | Even (hash function) |
| **Routing** | Deterministic (hash) |
| **Scalability** | Linear (add shards) |
| **Complexity** | Medium (resharding hard) |
| **Cache Impact** | None (short code key) |
| **Analytics** | Separate DB recommended |

**When to Shard:**
- ✅ Single DB can't handle write load (>1000 writes/sec)
- ✅ Database size approaching limits (hundreds of GB)
- ✅ Queries slowing down due to index size
- ✅ Need geographic distribution

**Estimated Capacity per Shard:**
- **Writes**: ~500-1000 inserts/sec
- **Reads**: ~2000-5000 selects/sec (with cache)
- **Storage**: ~100M-1B URLs per shard (depends on hardware)

**For 10M requests/day**: ✅ **No sharding needed** (single DB sufficient)
**For 100M+ requests/day**: ⚠️ **Consider sharding** (4-8 shards)

---

## Horizontal Scalability Notes

### Application Layer

**Scaling Strategy: Stateless Application Instances**

✅ **Current architecture is stateless:**
- No session storage in application
- All state in database/cache
- Can run multiple instances behind load balancer

**Deployment:**
```
[Load Balancer]
    ├── [App Instance 1] ← Same code, different server
    ├── [App Instance 2] ← Same code, different server
    └── [App Instance 3] ← Same code, different server
```

**Considerations:**

1. **Rate Limiting** (Current: Per-instance)
   - Each instance enforces limit independently
   - Effective limit = limit × instance_count
   - **Solution**: Use Redis for shared rate limit counters

2. **Circuit Breakers** (Current: Per-instance)
   - Each instance has its own circuit breaker state
   - One instance may mark DB as "open" while others don't
   - **Trade-off**: Acceptable for high availability (some instances still work)

3. **ID Generation** (Current: Snowflake)
   - ✅ **Already distributed-friendly**
   - Each instance has unique machine ID
   - No coordination needed
   - Works perfectly with horizontal scaling

### Database Layer

**Scaling Strategy: Read Replicas + Sharding**

**Read Replicas:**
- Primary: Handles all writes (creates)
- Replicas: Handle reads (redirects)
- Replication lag: ~10-100ms (usually acceptable)

**Configuration:**
```javascript
// config/database.js
const writePool = new Pool({ /* primary DB */ });
const readPool = new Pool({ /* read replica */ });

// In redirect route:
const result = await readPool.query('SELECT ...');  // Use read replica
// In shorten route:
await writePool.query('INSERT ...');                // Use primary
```

**Sharding:** (See "Database Sharding Strategy" section above)

### Cache Layer

**Scaling Strategy: Redis Cluster**

**Single Redis Instance:**
- ✅ Works for single region
- ❌ Single point of failure
- ❌ Limited by single server memory

**Redis Cluster (Recommended for Scale):**
- 3-6 nodes (minimum 3 for quorum)
- Automatic sharding across nodes
- High availability (failover)
- Shared memory pool

**Configuration:**
```javascript
const redisClient = createClient({
    socket: {
        host: 'redis-cluster.example.com',
        port: 6379
    }
});
// Redis Cluster handles sharding automatically
```

### Load Balancer Configuration

**Requirements:**
- Health checks (e.g., `/health` endpoint)
- Session affinity: **NOT needed** (stateless app)
- SSL termination (HTTPS)
- Rate limiting at LB level (optional, additional layer)

**Example (Nginx):**
```nginx
upstream app_servers {
    least_conn;  # Distribute by connection count
    server app1:3000;
    server app2:3000;
    server app3:3000;
}

server {
    listen 80;
    location / {
        proxy_pass http://app_servers;
    }
}
```

### Geographic Distribution

**Multi-Region Deployment:**

1. **Database**: Primary in one region, read replicas in others
   - Writes go to primary (higher latency for some regions)
   - Reads use local replica (low latency)

2. **Cache**: Redis Cluster per region
   - Each region has its own cache
   - Cache invalidation across regions (complex)
   - Or: Accept cache inconsistency (TTL-based expiration)

3. **Application**: Deploy in each region
   - Route users to nearest region (DNS-based)
   - Or: Global load balancer with geo-routing

**Trade-offs:**
- ✅ Lower latency for users
- ⚠️ More complex (cache invalidation, data replication)
- ⚠️ Higher operational cost

---

## Summary: Scale Handling

| Scale | Architecture | Notes |
|-------|-------------|-------|
| **1M req/day** | Single instance, single DB | ✅ Trivial |
| **10M req/day** | Single instance, single DB, Redis cache | ✅ Current setup sufficient |
| **100M req/day** | 3-5 instances, read replicas, Redis Cluster | ⚠️ Add read replicas, scale horizontally |
| **1B+ req/day** | Multiple regions, sharded DB, Redis Cluster | ⚠️ Complex, requires sharding |

**Key Principles:**
1. ✅ **Stateless application** - scales horizontally easily
2. ✅ **Graceful degradation** - Redis failure doesn't break service
3. ✅ **Distributed ID generation** - Snowflake works across instances
4. ⚠️ **Shared state** - Rate limiting and circuit breakers need coordination
5. ⚠️ **Database scaling** - Read replicas first, then sharding

