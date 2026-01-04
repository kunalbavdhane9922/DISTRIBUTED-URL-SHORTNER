/**
 * Rate Limiting Middleware
 * 
 * Prevents abuse and DoS attacks by limiting requests per IP address
 * 
 * Strategy: Simple in-memory token bucket (sliding window)
 * - Each IP gets a limited number of requests per time window
 * - Requests beyond limit return 429 Too Many Requests
 * 
 * HORIZONTAL SCALABILITY NOTE:
 * - Current implementation uses in-memory storage (per-instance)
 * - Works for single-instance deployments
 * - For multi-instance: Use Redis-based rate limiting or distributed rate limiter
 * - Each instance maintains its own counters (can lead to higher effective limits)
 * 
 * TODO: DISTRIBUTED RATE LIMITING
 * - Use Redis with INCR and EXPIRE for shared counters across instances
 * - Ensures consistent limits across all instances
 * - Trade-off: Adds Redis dependency for rate limiting
 */

// In-memory storage for rate limit counters
// Structure: { ip: { count: number, resetTime: number } }
const rateLimitStore = new Map();

// Cleanup expired entries every 5 minutes to prevent memory leak
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of rateLimitStore.entries()) {
        if (now > data.resetTime) {
            rateLimitStore.delete(ip);
        }
    }
}, 5 * 60 * 1000);

/**
 * Rate limiter middleware factory
 * 
 * @param {Object} options - Rate limit configuration
 * @param {number} options.windowMs - Time window in milliseconds (default: 1 minute)
 * @param {number} options.maxRequests - Max requests per window (default: 100)
 * @param {string} options.message - Error message (default: 'Too many requests')
 * @returns {Function} Express middleware function
 */
function createRateLimiter(options = {}) {
    const {
        windowMs = 60 * 1000, // 1 minute default
        maxRequests = 100,     // 100 requests per minute default
        message = 'Too many requests, please try again later'
    } = options;

    return (req, res, next) => {
        // Get client IP address
        // Check X-Forwarded-For header for proxy/load balancer scenarios
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   'unknown';

        const now = Date.now();
        const record = rateLimitStore.get(ip);

        if (!record || now > record.resetTime) {
            // First request or window expired - create new record
            rateLimitStore.set(ip, {
                count: 1,
                resetTime: now + windowMs
            });
            return next();
        }

        // Increment counter
        record.count++;

        if (record.count > maxRequests) {
            // Rate limit exceeded
            const retryAfter = Math.ceil((record.resetTime - now) / 1000);
            
            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Limit', maxRequests);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', new Date(record.resetTime).toISOString());
            
            return res.status(429).json({
                error: message,
                retryAfter: `${retryAfter} seconds`
            });
        }

        // Within limit - add headers and continue
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count));
        res.setHeader('X-RateLimit-Reset', new Date(record.resetTime).toISOString());
        
        next();
    };
}

// Export pre-configured rate limiters for common use cases

/**
 * Rate limiter for shorten endpoint
 * More restrictive since URL creation is more resource-intensive
 */
const shortenRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,  // 1 minute
    maxRequests: 50,       // 50 URLs per minute per IP
    message: 'Rate limit exceeded for URL creation. Please try again later.'
});

/**
 * Rate limiter for redirect endpoint
 * More lenient since redirects are lighter operations
 */
const redirectRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,  // 1 minute
    maxRequests: 1000,     // 1000 redirects per minute per IP
    message: 'Rate limit exceeded for redirects. Please try again later.'
});

module.exports = {
    createRateLimiter,
    shortenRateLimiter,
    redirectRateLimiter
};

