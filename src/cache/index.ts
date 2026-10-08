/** The cache module's entry point: its class, with the configuration, input, result and error types a consumer needs beside it. */
export { RedisCache } from './cache.js';
export { parseCacheConfig } from './config.js';
export { CacheError } from './types.js';
export type { CacheConfig, CacheSetOptions, CacheResult, CacheErrorCode } from './types.js';
