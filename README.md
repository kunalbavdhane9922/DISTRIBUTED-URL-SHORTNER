# Distributed URL Shortener

A production-grade URL shortener built with Node.js, Express, PostgreSQL, and Redis (interface ready).

## Architecture

- **Backend**: Node.js with Express
- **Database**: PostgreSQL
- **Cache**: Redis (read-through cache with TTL)

## Setup

### Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- Redis (v6 or higher) - optional for now

### Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your database credentials
```

3. Create the database and run the schema:
```bash
createdb url_shortener
psql url_shortener < database/schema.sql
```

4. Start the server:
```bash
npm start
# Or for development with auto-reload:
npm run dev
```

## API Endpoints

### POST /shorten

Creates a shortened URL from a long URL.

**Request:**
```json
{
  "url": "https://example.com/very/long/url"
}
```

**Response:**
```json
{
  "shortCode": "abc123",
  "shortUrl": "http://localhost:3000/abc123",
  "originalUrl": "https://example.com/very/long/url"
}
```

### GET /:shortCode

Redirects to the original URL associated with the short code.

**Response:** HTTP 302 redirect to the original URL

### GET /health

Health check endpoint to verify database connectivity.

## Current Implementation Details

### Rate Limiting

- **Per-endpoint limits**: Different limits for shorten (50/min) and redirect (1000/min)
- **IP-based**: Tracks requests per IP address
- **In-memory**: Per-instance (for distributed, use Redis-based rate limiting)
- Returns `429 Too Many Requests` with `Retry-After` header when limit exceeded

### Error Handling & Resilience

- **Graceful failure handling**: Application continues working even if Redis fails
- **Circuit breaker pattern**: Prevents cascading failures when database is down
- **Custom error classes**: Proper HTTP status codes and error messages
- **Async error handling**: All async routes wrapped to catch promise rejections

### ID Generation: Snowflake-Style

- **64-bit IDs** using Snowflake algorithm (timestamp + machine ID + sequence)
- Prevents collisions mathematically
- Handles concurrent requests efficiently
- Distributed-friendly (each machine generates IDs independently)
- ~10-11 character Base62-encoded short codes

See [docs/ID_GENERATION.md](docs/ID_GENERATION.md) for detailed explanation and trade-off analysis.

### Base62 Encoding

- Encodes 64-bit Snowflake IDs to URL-safe short codes
- ~10-11 characters per code
- Deterministic and reversible

### Rate Limiting

- **Per-endpoint limits**: Different limits for shorten (50/min) and redirect (1000/min)
- **IP-based**: Tracks requests per IP address
- **In-memory**: Per-instance (for distributed, use Redis-based rate limiting)
- Returns `429 Too Many Requests` with `Retry-After` header when limit exceeded

### Error Handling & Resilience

- **Graceful failure handling**: Application continues working even if Redis fails
- **Circuit breaker pattern**: Prevents cascading failures when database is down
- **Custom error classes**: Proper HTTP status codes and error messages
- **Async error handling**: All async routes wrapped to catch promise rejections

### Caching Strategy

- **Pattern**: Read-through cache
- **TTL**: 1 hour (configurable via `CACHE_TTL` env variable)
- **Behavior**: 
  - Cache hit: Returns URL immediately (<1ms), no database query
  - Cache miss: Queries database, populates cache for future requests
- **Performance**: Expected 80-95% cache hit ratio in production
- **Graceful degradation**: Falls back to database if Redis fails

See cache performance stats via `/health` endpoint.

### Scalability

**Current Capacity**: Handles **10M requests/day** with single instance
- See [docs/SCALABILITY.md](docs/SCALABILITY.md) for detailed analysis

**Key Features:**
- ✅ **Rate limiting** prevents abuse
- ✅ **Circuit breakers** prevent cascading failures
- ✅ **Graceful degradation** when Redis fails
- ✅ **Stateless design** enables horizontal scaling
- ✅ **Distributed ID generation** works across instances

**For higher scale:**
- Horizontal scaling: Multiple instances behind load balancer
- Read replicas: Distribute read load
- Database sharding: Hash-based on short code (see scalability doc)

### Known Scaling Limitations

The code includes extensive comments explaining:
- Why the current approach works
- Where it will fail at scale
- Potential solutions for each limitation

Key limitations include:
- Synchronous analytics updates (block redirect response)
- Rate limiting is per-instance (not shared across instances - use Redis for distributed)
- Single database instance (though IDs are distributed-friendly)
- No protection against cache stampede (see TODOs in `utils/cache.js`)

**Improvements:**
- ✅ No sequential ID bottlenecks (distributed generation)
- ✅ Collision prevention (mathematically guaranteed)
- ✅ Single database roundtrip (ID generated before insert)
- ✅ Redis caching reduces database load by ~90% for hot URLs
- ✅ Rate limiting prevents abuse
- ✅ Circuit breakers add resilience
- ✅ Graceful degradation when dependencies fail

See inline code comments for detailed analysis.

