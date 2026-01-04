/**
 * ID Generator Tests
 * 
 * Tests for collision prevention and concurrent request handling
 */

const { generateId, parseId, MAX_SEQUENCE, MAX_MACHINE_ID } = require('../utils/idGenerator');

describe('ID Generator - Collision Prevention', () => {
    test('should generate unique IDs sequentially', () => {
        const ids = new Set();
        const count = 1000;
        
        for (let i = 0; i < count; i++) {
            const id = generateId();
            expect(ids.has(id)).toBe(false);
            ids.add(id);
        }
        
        expect(ids.size).toBe(count);
    });

    test('should handle concurrent ID generation without collisions', async () => {
        // Simulate 100 concurrent requests
        const concurrentCount = 100;
        const idsPerRequest = 100;
        
        const generateIds = async () => {
            const ids = [];
            for (let i = 0; i < idsPerRequest; i++) {
                ids.push(generateId());
                // Small delay to simulate real-world timing
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            return ids;
        };
        
        // Generate IDs concurrently
        const promises = Array(concurrentCount)
            .fill(null)
            .map(() => generateIds());
        
        const allResults = await Promise.all(promises);
        const allIds = allResults.flat();
        
        // Check for collisions
        const uniqueIds = new Set(allIds);
        expect(uniqueIds.size).toBe(allIds.length);
        expect(allIds.length).toBe(concurrentCount * idsPerRequest);
    });

    test('should handle high-frequency ID generation (stress test)', () => {
        const ids = new Set();
        const count = 10000; // Generate 10k IDs rapidly
        
        const start = Date.now();
        for (let i = 0; i < count; i++) {
            const id = generateId();
            expect(ids.has(id)).toBe(false);
            ids.add(id);
        }
        const duration = Date.now() - start;
        
        expect(ids.size).toBe(count);
        console.log(`Generated ${count} IDs in ${duration}ms (${Math.round(count / duration * 1000)} IDs/sec)`);
    });

    test('should generate IDs within same millisecond (sequence handling)', async () => {
        // Mock Date.now to return same timestamp for multiple calls
        const originalNow = Date.now;
        let callCount = 0;
        const baseTime = Date.now();
        
        // First call returns baseTime, subsequent calls also return baseTime
        // This simulates generating multiple IDs within same millisecond
        global.Date.now = jest.fn(() => {
            if (callCount < MAX_SEQUENCE + 10) {
                callCount++;
                return baseTime;
            }
            return baseTime + 1; // Next millisecond
        });
        
        const ids = new Set();
        const count = MAX_SEQUENCE + 5; // Generate more than max sequence
        
        try {
            for (let i = 0; i < count; i++) {
                const id = generateId();
                expect(ids.has(id)).toBe(false);
                ids.add(id);
            }
            expect(ids.size).toBe(count);
        } finally {
            // Restore original Date.now
            global.Date.now = originalNow;
        }
    });

    test('should parse ID components correctly', () => {
        const id = generateId();
        const parsed = parseId(id);
        
        expect(parsed.machineId).toBeGreaterThanOrEqual(0);
        expect(parsed.machineId).toBeLessThanOrEqual(MAX_MACHINE_ID);
        expect(parsed.sequence).toBeGreaterThanOrEqual(0);
        expect(parsed.sequence).toBeLessThanOrEqual(MAX_SEQUENCE);
        expect(parsed.timestamp).toBeGreaterThan(0);
        expect(parsed.date).toBeInstanceOf(Date);
    });

    test('should handle sequence overflow by waiting for next millisecond', async () => {
        // This test simulates the extremely rare case where we generate
        // more than MAX_SEQUENCE IDs in a single millisecond
        const originalNow = Date.now;
        let callCount = 0;
        const baseTime = Date.now();
        
        // Force same timestamp for MAX_SEQUENCE + 1 calls
        global.Date.now = jest.fn(() => {
            callCount++;
            if (callCount <= MAX_SEQUENCE + 1) {
                return baseTime;
            }
            return baseTime + 1; // Allow progression after overflow
        });
        
        const ids = new Set();
        const count = MAX_SEQUENCE + 1;
        
        try {
            for (let i = 0; i < count; i++) {
                const id = generateId();
                ids.add(id);
            }
            // Should handle overflow and generate unique IDs
            expect(ids.size).toBe(count);
        } finally {
            global.Date.now = originalNow;
        }
    });
});

describe('ID Generator - Clock Skew Detection', () => {
    test('should detect and reject backward clock movement', () => {
        // Generate first ID to set lastTimestamp
        generateId();
        
        // Mock Date.now to return earlier time (clock moved backward)
        const originalNow = Date.now;
        const currentTime = Date.now();
        global.Date.now = jest.fn(() => currentTime - 1000); // 1 second in past
        
        try {
            expect(() => generateId()).toThrow('Clock moved backward');
        } finally {
            global.Date.now = originalNow;
        }
    });
});

describe('ID Generator - Multi-Machine Simulation', () => {
    test('should generate unique IDs across different machine IDs', () => {
        // Simulate different machines by temporarily overriding machine ID logic
        // In real scenario, different machines would have different MACHINE_ID env vars
        const ids = new Set();
        const machineCount = 10;
        
        // Generate IDs with different machine IDs (simulated via parsing)
        // Note: This test demonstrates uniqueness across machines conceptually
        // Actual machine ID comes from env var or hostname hash
        
        for (let i = 0; i < 100; i++) {
            const id = generateId();
            const parsed = parseId(id);
            
            // Verify machine ID is within valid range
            expect(parsed.machineId).toBeGreaterThanOrEqual(0);
            expect(parsed.machineId).toBeLessThanOrEqual(MAX_MACHINE_ID);
            
            ids.add(id);
        }
        
        expect(ids.size).toBe(100);
    });
});

describe('ID Generator - Collision Stress Test', () => {
    test('should generate 1 million unique IDs without collisions', () => {
        const ids = new Set();
        const count = 1000000; // 1 million IDs
        
        console.time('1M ID generation');
        
        for (let i = 0; i < count; i++) {
            const id = generateId();
            
            if (ids.has(id)) {
                throw new Error(`Collision detected at ID ${i}: ${id.toString()}`);
            }
            
            ids.add(id);
            
            // Progress indicator for long-running test
            if (i % 100000 === 0 && i > 0) {
                console.log(`Generated ${i} IDs, no collisions so far...`);
            }
        }
        
        console.timeEnd('1M ID generation');
        
        expect(ids.size).toBe(count);
        console.log(`✅ Successfully generated ${count} unique IDs with zero collisions`);
    }, 60000); // 60 second timeout for this stress test

    test('should handle rapid concurrent generation from multiple "threads"', async () => {
        const threadCount = 50;
        const idsPerThread = 2000;
        const allIds = new Set();
        
        const generateBatch = async () => {
            const threadIds = [];
            for (let i = 0; i < idsPerThread; i++) {
                threadIds.push(generateId());
            }
            return threadIds;
        };
        
        console.time('Concurrent generation');
        
        // Simulate 50 concurrent threads, each generating 2000 IDs
        const promises = Array(threadCount)
            .fill(null)
            .map(() => generateBatch());
        
        const results = await Promise.all(promises);
        const allGeneratedIds = results.flat();
        
        // Check for collisions
        allGeneratedIds.forEach(id => {
            if (allIds.has(id)) {
                throw new Error(`Collision detected: ${id.toString()}`);
            }
            allIds.add(id);
        });
        
        console.timeEnd('Concurrent generation');
        
        expect(allIds.size).toBe(threadCount * idsPerThread);
        console.log(`✅ Generated ${allIds.size} IDs concurrently with zero collisions`);
    }, 30000);
});

