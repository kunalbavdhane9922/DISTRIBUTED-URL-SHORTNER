/**
 * Circuit Breaker Pattern
 * 
 * Prevents cascading failures by detecting when a service is down
 * and failing fast instead of waiting for timeouts
 * 
 * STATES:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Service is failing, requests fail fast without calling service
 * - HALF_OPEN: Testing if service has recovered, allows limited requests
 * 
 * HORIZONTAL SCALABILITY NOTE:
 * - Current implementation is per-instance (in-memory)
 * - Each instance maintains its own circuit breaker state
 * - For distributed circuit breaking, use shared state (Redis) or service mesh
 * - Trade-off: Per-instance is simpler but less coordinated
 */

const CIRCUIT_STATES = {
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN'
};

class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;    // Open after 5 failures
        this.successThreshold = options.successThreshold || 2;    // Close after 2 successes
        this.timeout = options.timeout || 60000;                   // Try again after 60s
        this.resetTimeout = options.resetTimeout || 30000;         // Half-open after 30s
        
        this.state = CIRCUIT_STATES.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.name = options.name || 'circuit-breaker';
    }

    /**
     * Execute a function with circuit breaker protection
     * 
     * @param {Function} fn - Function to execute
     * @param {Function} fallback - Fallback function if circuit is open (optional)
     * @returns {Promise} Result of function or fallback
     */
    async execute(fn, fallback) {
        // Check circuit state
        if (this.state === CIRCUIT_STATES.OPEN) {
            // Circuit is open - check if we should try half-open
            if (Date.now() - this.lastFailureTime > this.resetTimeout) {
                this.state = CIRCUIT_STATES.HALF_OPEN;
                this.successCount = 0;
            } else {
                // Still open - fail fast with fallback or error
                if (fallback) {
                    return fallback();
                }
                throw new Error(`${this.name} circuit breaker is OPEN`);
            }
        }

        try {
            // Execute the function
            const result = await fn();
            
            // Success - reset counters
            if (this.state === CIRCUIT_STATES.HALF_OPEN) {
                this.successCount++;
                if (this.successCount >= this.successThreshold) {
                    // Enough successes - close the circuit
                    this.state = CIRCUIT_STATES.CLOSED;
                    this.failureCount = 0;
                    this.successCount = 0;
                }
            } else {
                // Closed state - reset failure count on success
                this.failureCount = 0;
            }
            
            return result;
        } catch (error) {
            // Failure - increment counter
            this.failureCount++;
            this.lastFailureTime = Date.now();
            
            if (this.failureCount >= this.failureThreshold) {
                // Too many failures - open the circuit
                this.state = CIRCUIT_STATES.OPEN;
                console.warn(`${this.name} circuit breaker OPENED after ${this.failureCount} failures`);
            }
            
            // If we have a fallback and circuit is open, use it
            if (this.state === CIRCUIT_STATES.OPEN && fallback) {
                return fallback();
            }
            
            // Re-throw the error
            throw error;
        }
    }

    /**
     * Get current circuit breaker state
     */
    getState() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            lastFailureTime: this.lastFailureTime
        };
    }

    /**
     * Manually reset circuit breaker (for testing/admin)
     */
    reset() {
        this.state = CIRCUIT_STATES.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
    }
}

// Export singleton instances for common use cases

// Database circuit breaker
const dbCircuitBreaker = new CircuitBreaker({
    name: 'database',
    failureThreshold: 5,
    successThreshold: 2,
    resetTimeout: 30000
});

// Redis circuit breaker
const redisCircuitBreaker = new CircuitBreaker({
    name: 'redis',
    failureThreshold: 5,
    successThreshold: 2,
    resetTimeout: 30000
});

module.exports = {
    CircuitBreaker,
    dbCircuitBreaker,
    redisCircuitBreaker
};

