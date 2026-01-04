/**
 * Base62 Encoding Utility
 * 
 * Base62 uses characters: 0-9, a-z, A-Z (62 characters total)
 * This allows for URL-safe short codes without special characters
 * 
 * Example: ID 1000 -> "g8" (if using base 62)
 */

const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = 62;

/**
 * Encodes a number or BigInt to Base62 string
 * 
 * @param {number|bigint} num - The number to encode (typically a database ID)
 * @returns {string} Base62 encoded string
 * 
 * WHY THIS APPROACH WORKS:
 * - Simple and deterministic: same ID always produces same short code
 * - URL-safe: no special characters that need encoding
 * - Supports BigInt for 64-bit IDs (Snowflake IDs)
 * - Fast: O(log_62(n)) time complexity, very efficient
 * 
 * WHERE IT WILL FAIL AT SCALE:
 * 1. Sequential IDs are predictable - security risk
 *    Attacker can enumerate all URLs by trying consecutive IDs
 *    Solution: Use random codes or hash-based encoding (Snowflake IDs help)
 * 
 * 2. Not collision-resistant for custom short codes
 *    If users can choose custom codes, need collision detection
 *    Current approach assumes auto-generated codes only
 * 
 * 3. Length grows with ID value
 *   - Snowflake 64-bit IDs: ~10-11 chars (acceptable)
 *   - At 62 billion URLs, codes are ~7 chars (still acceptable)
 * 
 * 4. No distributed coordination
 *    Works fine for single database instance
 *    With multiple database instances, need ID coordination
 *    (Snowflake IDs handle this - see idGenerator.js)
 */
function encodeBase62(num) {
    // Handle BigInt (for 64-bit Snowflake IDs)
    const isBigInt = typeof num === 'bigint';
    if (num === 0 || num === 0n) {
        return BASE62_CHARS[0];
    }
    
    let result = '';
    let n = BigInt(num);
    const base = BigInt(BASE);
    
    while (n > 0n) {
        const remainder = Number(n % base);
        result = BASE62_CHARS[remainder] + result;
        n = n / base;
    }
    
    return result;
}

/**
 * Decodes a Base62 string to BigInt
 * 
 * @param {string} str - Base62 encoded string
 * @returns {bigint} The decoded number as BigInt (supports 64-bit IDs)
 * 
 * WHY THIS APPROACH WORKS:
 * - Perfect reverse of encoding - guaranteed to recover original ID
 * - Fast: O(n) where n is string length
 * - Uses BigInt to support 64-bit IDs without precision loss
 * 
 * WHERE IT WILL FAIL AT SCALE:
 * 1. No validation of input format
 *    Malicious input could cause errors or overflow
 *    Need input sanitization and bounds checking
 * 
 * 2. BigInt performance
 *    Slightly slower than Number, but necessary for 64-bit IDs
 *    Performance impact is negligible for URL decoding operations
 */
function decodeBase62(str) {
    let num = 0n;
    const base = BigInt(BASE);
    const len = str.length;
    
    for (let i = 0; i < len; i++) {
        const char = str[i];
        const charIndex = BASE62_CHARS.indexOf(char);
        
        if (charIndex === -1) {
            throw new Error(`Invalid Base62 character: ${char}`);
        }
        
        num = num * base + BigInt(charIndex);
    }
    
    return num;
}

module.exports = {
    encodeBase62,
    decodeBase62
};

