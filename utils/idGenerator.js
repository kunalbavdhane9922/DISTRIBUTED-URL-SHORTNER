/**
 * ID Generator - Snowflake-style Implementation
 * 
 * TRADE-OFF ANALYSIS: Hashing vs Counters vs Snowflake-style IDs
 * 
 * ==============================================================================
 * 1. HASHING APPROACH
 * ==============================================================================
 * Strategy: Generate hash from URL + timestamp/salt (e.g., SHA-256, then truncate)
 * 
 * PROS:
 * - No coordination needed between instances (perfect for distributed systems)
 * - Deterministic for same URL (can prevent duplicates if URL is included in hash)
 * - Stateless - each request can generate independently
 * - No database sequence contention
 * 
 * CONS:
 * - Collision risk exists (birthday paradox: ~50% chance at sqrt(2^bits) hashes)
 *   For 64-bit: ~5.4 billion hashes before 50% collision chance
 *   Must implement collision detection and retry logic
 * - Longer codes: 64-bit hash = ~11 Base62 characters vs ~6-7 for sequential
 * - Non-sequential: Bad for database performance (B-tree fragmentation)
 * - Not cryptographically secure: Truncated hashes are predictable
 * - Storage overhead: Longer codes mean more storage per URL
 * 
 * SCALING CHARACTERISTICS:
 * - Write performance: Excellent (no coordination)
 * - Read performance: Good (with proper indexing, but index fragmentation)
 * - Collision handling: Complex (need retry logic, exponential backoff)
 * 
 * ==============================================================================
 * 2. COUNTERS (Current Auto-increment Approach)
 * ==============================================================================
 * Strategy: Database auto-increment sequence (BIGSERIAL/SERIAL)
 * 
 * PROS:
 * - Guaranteed unique (database enforces)
 * - Short codes (sequential = compact Base62 encoding)
 * - Simple implementation
 * - Sequential = good for database performance (B-tree efficiency)
 * - No collision risk (database handles)
 * 
 * CONS:
 * - Sequence bottleneck: All writes contend on single sequence
 *   At 10k+ writes/sec, sequence becomes bottleneck (lock contention)
 * - Requires coordination: All instances must hit same database
 * - Not distributed-friendly: Can't scale writes horizontally easily
 * - Predictable: Sequential IDs reveal volume and are enumerable (security risk)
 * 
 * SCALING CHARACTERISTICS:
 * - Write performance: Poor at scale (sequence contention)
 * - Read performance: Excellent (sequential = optimal B-tree layout)
 * - Collision handling: Not needed (database guarantees)
 * 
 * ==============================================================================
 * 3. SNOWFLAKE-STYLE IDs (CHOSEN APPROACH)
 * ==============================================================================
 * Strategy: 64-bit ID = timestamp (41 bits) + machine ID (10 bits) + sequence (12 bits)
 * Inspired by Twitter's Snowflake system, used at scale by Twitter, Discord, etc.
 * 
 * PROS:
 * - Distributed-friendly: Each machine generates IDs independently
 * - No coordination needed: Timestamp + machine ID + sequence guarantee uniqueness
 * - Roughly sequential: Good for database performance (B-tree friendly)
 * - Short codes: 64-bit = ~10-11 Base62 characters (acceptable)
 * - Time-ordered: IDs are roughly time-sorted (useful for analytics)
 * - Proven at scale: Used by Twitter (generating millions of IDs/sec)
 * - No collision risk: 12-bit sequence (4096 IDs/ms/machine) with timestamp prevents collisions
 * 
 * CONS:
 * - Requires machine ID coordination: Must ensure unique machine IDs (0-1023)
 *   Solution: Use environment variable or configuration service (Consul, etcd)
 * - Sequence coordination per machine: Still need to coordinate sequence within same millisecond
 *   But contention is 1/1024th of counter approach (only within same machine)
 * - Clock skew risk: If system clock goes backward, could generate duplicate IDs
 *   Solution: Detect clock skew and reject IDs, use NTP for clock synchronization
 * - Slightly more complex: Need to manage machine ID and handle edge cases
 * 
 * SCALING CHARACTERISTICS:
 * - Write performance: Excellent (minimal coordination, 4096 IDs/ms/machine capacity)
 * - Read performance: Excellent (roughly sequential = good B-tree layout)
 * - Collision handling: Not needed (mathematically guaranteed unique with proper implementation)
 * 
 * ==============================================================================
 * DECISION: SNOWFLAKE-STYLE IDs
 * ==============================================================================
 * 
 * WHY SNOWFLAKE WINS:
 * 1. Handles concurrent requests naturally (timestamp + sequence)
 * 2. Prevents collisions mathematically (with proper implementation)
 * 3. Distributed-friendly (each machine independent)
 * 4. Good database performance (roughly sequential)
 * 5. Proven at scale (Twitter, Discord use similar)
 * 6. Better than hashing: No collision risk, shorter codes, sequential
 * 7. Better than counters: No sequence bottleneck, distributed-friendly
 * 
 * TRADE-OFF ACCEPTED:
 * - Slightly longer codes (10-11 chars vs 6-7) - acceptable for distributed capability
 * - Requires machine ID coordination - acceptable (simple env var or config service)
 * - Need clock synchronization - standard practice in distributed systems (NTP)
 * 
 * CAPACITY:
 * - 41-bit timestamp: ~69 years from epoch (until 2039 from 1970)
 * - 10-bit machine ID: 1024 unique machines
 * - 12-bit sequence: 4096 IDs per millisecond per machine
 * - Total capacity: 4096 IDs/ms * 1024 machines = 4.2 million IDs/second
 *   More than sufficient for even the largest URL shorteners
 */

const MACHINE_ID_BITS = 10;  // 1024 machines max
const SEQUENCE_BITS = 12;     // 4096 IDs per ms per machine

const MAX_MACHINE_ID = (1 << MACHINE_ID_BITS) - 1;  // 1023
const MAX_SEQUENCE = (1 << SEQUENCE_BITS) - 1;      // 4095

// Custom epoch: January 1, 2020 00:00:00 UTC
// Gives us 69 years from this point (until 2089)
const EPOCH = new Date('2020-01-01T00:00:00Z').getTime();

let sequence = 0;
let lastTimestamp = -1;

// Machine ID from environment variable, defaults to hash of hostname
// In production, should be set explicitly via env var or config service
function getMachineId() {
    if (process.env.MACHINE_ID !== undefined) {
        const id = parseInt(process.env.MACHINE_ID, 10);
        if (id < 0 || id > MAX_MACHINE_ID) {
            throw new Error(`MACHINE_ID must be between 0 and ${MAX_MACHINE_ID}`);
        }
        return id;
    }
    
    // Fallback: hash hostname to get consistent machine ID
    // Not perfect, but works for single-machine deployments
    const os = require('os');
    const hostname = os.hostname();
    let hash = 0;
    for (let i = 0; i < hostname.length; i++) {
        const char = hostname.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) & MAX_MACHINE_ID;
}

const machineId = getMachineId();

/**
 * Generates a unique 64-bit ID using Snowflake algorithm
 * 
 * ID Structure (64 bits total):
 * - Bit 63-23 (41 bits): Timestamp in milliseconds since epoch
 * - Bit 22-13 (10 bits): Machine ID (0-1023)
 * - Bit 12-0  (12 bits): Sequence number (0-4095)
 * 
 * COLLISION PREVENTION:
 * - Timestamp ensures uniqueness across time
 * - Machine ID ensures uniqueness across machines
 * - Sequence ensures uniqueness within same millisecond on same machine
 * - Clock skew detection prevents duplicates from backward time
 * 
 * CONCURRENT REQUEST HANDLING:
 * - Sequence counter is incremented atomically within same millisecond
 * - If same millisecond, sequence wraps to 0 and waits for next millisecond
 * - This ensures no collisions even with concurrent requests
 * 
 * @returns {bigint} 64-bit unique ID
 * @throws {Error} If clock moves backward (clock skew detected)
 */
function generateId() {
    let timestamp = Date.now() - EPOCH;
    
    // Clock skew detection: If clock moved backward, reject
    // This prevents duplicate IDs from clock adjustments
    if (timestamp < lastTimestamp) {
        const skew = lastTimestamp - timestamp;
        throw new Error(`Clock moved backward. Refusing to generate ID for ${skew}ms`);
    }
    
    // If same millisecond, increment sequence
    // If sequence overflows (4096 IDs in same ms), wait for next millisecond
    if (timestamp === lastTimestamp) {
        sequence = (sequence + 1) & MAX_SEQUENCE;
        
        // Sequence overflow: We've generated 4096 IDs in this millisecond
        // Wait for next millisecond (this is extremely rare, but handle it)
        if (sequence === 0) {
            timestamp = waitNextMillis(lastTimestamp);
            // New millisecond after overflow, reset sequence to 0
            // (sequence is already 0 from overflow, but be explicit)
            sequence = 0;
        }
    } else {
        // New millisecond, reset sequence
        sequence = 0;
    }
    
    lastTimestamp = timestamp;
    
    // Construct 64-bit ID
    // Shift and combine: timestamp (41 bits) + machine (10 bits) + sequence (12 bits)
    const id = (BigInt(timestamp) << BigInt(MACHINE_ID_BITS + SEQUENCE_BITS)) |
               (BigInt(machineId) << BigInt(SEQUENCE_BITS)) |
               BigInt(sequence);
    
    return id;
}

/**
 * Waits until next millisecond to handle sequence overflow
 * This should be extremely rare (only if generating >4096 IDs/ms on single machine)
 * 
 * @param {number} lastTimestamp - Last timestamp used
 * @returns {number} Next timestamp
 */
function waitNextMillis(lastTimestamp) {
    let timestamp = Date.now() - EPOCH;
    while (timestamp <= lastTimestamp) {
        // Busy wait (should be <1ms, acceptable for this rare case)
        timestamp = Date.now() - EPOCH;
    }
    return timestamp;
}

/**
 * Extracts components from a Snowflake ID (for debugging/analytics)
 * 
 * @param {bigint} id - Snowflake ID
 * @returns {Object} { timestamp, machineId, sequence, date }
 */
function parseId(id) {
    const timestamp = Number((id >> BigInt(MACHINE_ID_BITS + SEQUENCE_BITS)) & BigInt(0x1FFFFFFFFFF));
    const machineId = Number((id >> BigInt(SEQUENCE_BITS)) & BigInt(MAX_MACHINE_ID));
    const sequence = Number(id & BigInt(MAX_SEQUENCE));
    const date = new Date(timestamp + EPOCH);
    
    return { timestamp, machineId, sequence, date };
}

module.exports = {
    generateId,
    parseId,
    MACHINE_ID_BITS,
    SEQUENCE_BITS,
    MAX_MACHINE_ID,
    MAX_SEQUENCE,
    EPOCH
};

