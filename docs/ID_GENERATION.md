# ID Generation Strategy

## Overview

The URL shortener uses **Snowflake-style ID generation** to create unique 64-bit identifiers that prevent collisions and handle concurrent requests efficiently.

## Chosen Approach: Snowflake-Style IDs

### Why Snowflake Over Other Approaches?

See `utils/idGenerator.js` for detailed trade-off analysis comparing:
- **Hashing** (URL + salt)
- **Counters** (Database auto-increment)
- **Snowflake-style IDs** (Timestamp + Machine ID + Sequence) ✅ **CHOSEN**

### ID Structure

64-bit ID format:
```
[41 bits: Timestamp] [10 bits: Machine ID] [12 bits: Sequence]
```

- **Timestamp (41 bits)**: Milliseconds since custom epoch (Jan 1, 2020)
  - Capacity: ~69 years
- **Machine ID (10 bits)**: Unique identifier for each server instance
  - Capacity: 1024 machines
  - Set via `MACHINE_ID` environment variable
- **Sequence (12 bits)**: Incrementing counter per millisecond
  - Capacity: 4096 IDs per millisecond per machine

### Capacity

- **Per machine**: 4,096 IDs/millisecond = 4.1 million IDs/second
- **Total (1024 machines)**: 4.2 billion IDs/second
- More than sufficient for even the largest URL shorteners

## Collision Prevention

Collisions are mathematically prevented by:

1. **Timestamp uniqueness**: Different timestamps = different IDs
2. **Machine ID uniqueness**: Different machines = different IDs (even at same time)
3. **Sequence uniqueness**: Different sequences = different IDs (within same ms on same machine)
4. **Clock skew detection**: Rejects IDs if system clock moves backward

## Concurrent Request Handling

- Each machine maintains a sequence counter
- Same millisecond: Sequence increments (0-4095)
- Sequence overflow: Waits for next millisecond (extremely rare)
- No coordination needed between machines

## Testing

Run collision tests:

```bash
npm test
```

Tests include:
- Sequential ID generation (1M IDs)
- Concurrent generation (100 concurrent requests)
- Same-millisecond collision prevention
- Clock skew detection
- Base62 encoding collision prevention
- Real-world load simulation

## Configuration

Set machine ID via environment variable:

```bash
MACHINE_ID=42 node server.js
```

If not set, uses hash of hostname (works for single-machine deployments).

## Migration Notes

The database schema was updated:
- Changed from `BIGSERIAL` (auto-increment) to `BIGINT` (application-generated)
- IDs are now generated in application before database insert
- Single database roundtrip (improvement over previous approach)

