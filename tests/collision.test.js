/**
 * Collision Simulation Tests
 * 
 * These tests specifically simulate collision scenarios to ensure
 * the ID generation strategy prevents them in all edge cases.
 */

const { generateId, parseId } = require('../utils/idGenerator');
const { encodeBase62 } = require('../utils/base62');

describe('Collision Simulation Tests', () => {
    describe('Same Millisecond Collision Prevention', () => {
        test('should prevent collisions when generating IDs in same millisecond', () => {
            // Simulate generating multiple IDs within the same millisecond
            // The sequence counter should prevent collisions
            
            const originalNow = Date.now;
            const fixedTime = Date.now();
            let callCount = 0;
            
            // Force same timestamp for multiple calls
            global.Date.now = jest.fn(() => {
                callCount++;
                return fixedTime; // Always return same time
            });
            
            const ids = new Set();
            const count = 100;
            
            try {
                for (let i = 0; i < count; i++) {
                    const id = generateId();
                    
                    // Check for collision
                    if (ids.has(id)) {
                        throw new Error(`Collision detected at iteration ${i}: ${id.toString()}`);
                    }
                    
                    ids.add(id);
                    
                    // Verify sequence is incrementing
                    const parsed = parseId(id);
                    expect(parsed.sequence).toBe(i);
                }
                
                expect(ids.size).toBe(count);
                
                // All IDs should have same timestamp but different sequences
                const parsedIds = Array.from(ids).map(id => parseId(id));
                const timestamps = new Set(parsedIds.map(p => p.timestamp));
                const sequences = new Set(parsedIds.map(p => p.sequence));
                
                expect(timestamps.size).toBe(1); // All same timestamp
                expect(sequences.size).toBe(count); // All different sequences
                
            } finally {
                global.Date.now = originalNow;
            }
        });
    });

    describe('Concurrent Request Collision Simulation', () => {
        test('should handle simultaneous ID generation requests without collisions', async () => {
            // Simulate 1000 concurrent requests all trying to generate IDs at once
            const concurrentRequests = 1000;
            const ids = new Set();
            const collisions = [];
            
            const generateSingleId = () => {
                try {
                    return generateId();
                } catch (error) {
                    return { error: error.message };
                }
            };
            
            // Generate all IDs "simultaneously" (as much as JS allows)
            const promises = Array(concurrentRequests)
                .fill(null)
                .map(() => Promise.resolve(generateSingleId()));
            
            const results = await Promise.all(promises);
            
            // Check for collisions
            results.forEach((id, index) => {
                if (id.error) {
                    collisions.push({ index, error: id.error });
                    return;
                }
                
                if (ids.has(id)) {
                    collisions.push({ index, id: id.toString() });
                }
                ids.add(id);
            });
            
            if (collisions.length > 0) {
                throw new Error(`Found ${collisions.length} collisions: ${JSON.stringify(collisions)}`);
            }
            
            expect(ids.size).toBe(concurrentRequests);
        });

        test('should handle rapid-fire requests without collisions', async () => {
            // Simulate rapid-fire requests (like a burst of traffic)
            const burstSize = 5000;
            const ids = new Set();
            
            // Generate IDs as fast as possible
            const generateRapidly = async () => {
                const batch = [];
                for (let i = 0; i < burstSize; i++) {
                    batch.push(generateId());
                    // No delay - maximum speed
                }
                return batch;
            };
            
            const startTime = Date.now();
            const allIds = await generateRapidly();
            const duration = Date.now() - startTime;
            
            // Check for collisions
            allIds.forEach((id, index) => {
                if (ids.has(id)) {
                    throw new Error(`Collision at index ${index}: ${id.toString()}`);
                }
                ids.add(id);
            });
            
            expect(ids.size).toBe(burstSize);
            console.log(`Generated ${burstSize} IDs in ${duration}ms (${Math.round(burstSize / duration * 1000)} IDs/sec)`);
        });
    });

    describe('Base62 Encoding Collision Prevention', () => {
        test('should ensure Base62 encoding does not create collisions', () => {
            // Generate IDs and check their Base62 encodings are unique
            const idToCode = new Map();
            const codeToId = new Map();
            const count = 10000;
            
            for (let i = 0; i < count; i++) {
                const id = generateId();
                const code = encodeBase62(id);
                
                // Check for encoding collisions (different IDs -> same code)
                if (codeToId.has(code)) {
                    const existingId = codeToId.get(code);
                    throw new Error(`Encoding collision: IDs ${existingId} and ${id} both encode to ${code}`);
                }
                
                // Check for reverse collisions (same ID -> different codes)
                if (idToCode.has(id.toString())) {
                    const existingCode = idToCode.get(id.toString());
                    if (existingCode !== code) {
                        throw new Error(`Reverse collision: ID ${id} encodes to both ${existingCode} and ${code}`);
                    }
                }
                
                idToCode.set(id.toString(), code);
                codeToId.set(code, id);
            }
            
            expect(idToCode.size).toBe(count);
            expect(codeToId.size).toBe(count);
        });
    });

    describe('Time Boundary Collision Prevention', () => {
        test('should handle millisecond boundary transitions without collisions', async () => {
            // Test transition from one millisecond to the next
            const originalNow = Date.now;
            let currentTime = Date.now();
            let callCount = 0;
            
            global.Date.now = jest.fn(() => {
                callCount++;
                // First 50 calls at time T, next 50 at time T+1
                if (callCount <= 50) {
                    return currentTime;
                } else if (callCount <= 100) {
                    return currentTime + 1;
                } else {
                    return currentTime + 2;
                }
            });
            
            const ids = new Set();
            
            try {
                // Generate IDs that span millisecond boundary
                for (let i = 0; i < 100; i++) {
                    const id = generateId();
                    
                    if (ids.has(id)) {
                        throw new Error(`Collision at boundary transition: ${id.toString()}`);
                    }
                    
                    ids.add(id);
                }
                
                expect(ids.size).toBe(100);
                
                // Verify sequences reset at boundary
                const parsedIds = Array.from(ids).map(id => parseId(id));
                const firstHalf = parsedIds.slice(0, 50);
                const secondHalf = parsedIds.slice(50, 100);
                
                // Sequences in first half should be 0-49
                firstHalf.forEach((parsed, index) => {
                    expect(parsed.sequence).toBe(index);
                });
                
                // Sequences in second half should reset to 0-49 (new millisecond)
                secondHalf.forEach((parsed, index) => {
                    expect(parsed.sequence).toBe(index);
                });
                
            } finally {
                global.Date.now = originalNow;
            }
        });
    });

    describe('Real-World Collision Simulation', () => {
        test('should simulate realistic URL shortening load without collisions', async () => {
            // Simulate realistic load: bursts of requests with varying delays
            const simulationDuration = 2000; // 2 seconds
            const requestRate = 100; // requests per second
            const totalRequests = Math.floor(simulationDuration / 1000 * requestRate);
            
            const ids = new Set();
            const startTime = Date.now();
            
            const generateWithDelay = async (delay) => {
                await new Promise(resolve => setTimeout(resolve, delay));
                return generateId();
            };
            
            // Generate requests with realistic timing
            const promises = [];
            for (let i = 0; i < totalRequests; i++) {
                const delay = (i / requestRate) * 1000; // Spread requests over time
                promises.push(generateWithDelay(delay));
            }
            
            const results = await Promise.all(promises);
            const endTime = Date.now();
            
            // Check for collisions
            results.forEach((id, index) => {
                if (ids.has(id)) {
                    throw new Error(`Collision at request ${index}: ${id.toString()}`);
                }
                ids.add(id);
            });
            
            expect(ids.size).toBe(totalRequests);
            console.log(`Simulated ${totalRequests} requests over ${endTime - startTime}ms with zero collisions`);
        });
    });
});

