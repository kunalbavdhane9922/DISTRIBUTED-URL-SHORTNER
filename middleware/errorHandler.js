/**
 * Error Handling Middleware
 * 
 * Centralized error handling with graceful failure patterns
 * 
 * GRACEFUL FAILURE STRATEGY:
 * - Catch all errors before they crash the application
 * - Return appropriate HTTP status codes
 * - Log errors for monitoring and debugging
 * - Never expose internal error details to clients (security)
 */

/**
 * Custom error classes for better error handling
 */
class AppError extends Error {
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational; // Operational errors vs programming errors
        Error.captureStackTrace(this, this.constructor);
    }
}

class DatabaseError extends AppError {
    constructor(message, originalError) {
        super(message, 503, true); // Service Unavailable
        this.originalError = originalError;
    }
}

class CacheError extends AppError {
    constructor(message, originalError) {
        super(message, 200, true); // Don't fail request if cache fails
        this.originalError = originalError;
    }
}

/**
 * Error handler middleware
 * Must be added AFTER all routes
 */
function errorHandler(err, req, res, next) {
    // Log error for monitoring
    const errorDetails = {
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        statusCode: err.statusCode || 500,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
    };

    // Log to console (in production, use proper logging service)
    if (err.isOperational) {
        console.warn('Operational error:', errorDetails);
    } else {
        console.error('Application error:', errorDetails);
    }

    // Determine status code
    const statusCode = err.statusCode || 500;

    // Don't expose internal error details in production
    const message = err.isOperational || process.env.NODE_ENV === 'development'
        ? err.message
        : 'Internal server error';

    // Send error response
    res.status(statusCode).json({
        error: message,
        ...(process.env.NODE_ENV === 'development' && { details: errorDetails })
    });
}

/**
 * Async handler wrapper to catch promise rejections in async route handlers
 * Prevents unhandled promise rejections from crashing the application
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Not found handler (404)
 * Must be added AFTER all routes, BEFORE error handler
 */
function notFoundHandler(req, res, next) {
    res.status(404).json({
        error: 'Resource not found',
        path: req.path
    });
}

module.exports = {
    AppError,
    DatabaseError,
    CacheError,
    errorHandler,
    asyncHandler,
    notFoundHandler
};

