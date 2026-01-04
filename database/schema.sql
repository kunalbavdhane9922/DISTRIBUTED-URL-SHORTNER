-- Database schema for URL shortener
-- This schema supports Snowflake-style ID generation

-- URLs table stores the mapping between short codes and original URLs
CREATE TABLE IF NOT EXISTS urls (
    -- Using BIGINT instead of BIGSERIAL since we generate IDs in application
    -- Snowflake IDs are 64-bit integers generated deterministically
    id BIGINT PRIMARY KEY,
    -- Short code is the Base62-encoded value derived from the ID
    -- Storing it separately allows for indexing and faster lookups
    -- However, this creates redundancy - we could derive it from ID
    short_code VARCHAR(255) UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    click_count BIGINT DEFAULT 0
);

-- Index on short_code for fast lookups (O(log n) instead of O(n))
-- This is critical for GET /:shortCode endpoint performance
CREATE INDEX IF NOT EXISTS idx_short_code ON urls(short_code);

-- Index on created_at for analytics queries (optional, but useful)
CREATE INDEX IF NOT EXISTS idx_created_at ON urls(created_at);

-- SCALING ISSUES WITH THIS SCHEMA:
-- 1. Using BIGSERIAL for ID means we're limited to ~9.2 quintillion records
--    This is actually fine for most use cases, but not truly infinite
-- 2. Storing short_code separately creates redundancy and storage overhead
--    At billions of URLs, this could add significant storage costs
-- 3. No partitioning - as the table grows, inserts and queries slow down
--    Need table partitioning by date or hash for true scale
-- 4. No read replicas configured - all reads hit the primary database
--    At high read volumes, this becomes a bottleneck
-- 5. click_count updates will cause row-level locks and contention
--    Should use separate analytics table or async updates

