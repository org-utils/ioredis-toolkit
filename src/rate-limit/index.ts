/** The rate-limit module's entry point: its class, with the configuration, result and error types a consumer needs beside it. */
export { RedisRateLimiter } from './rate-limiter.js';
export { parseRateLimitConfig } from './config.js';
export { RateLimitError } from './types.js';
export type { RateLimitConfig, RateLimitResult, RateLimitErrorCode } from './types.js';
