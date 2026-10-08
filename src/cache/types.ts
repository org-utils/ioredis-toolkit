import { RedisToolkitError, type ModuleConfigBase } from '../redis/index.js';

/** Stable machine-readable error codes emitted by the cache. */
export type CacheErrorCode = 'CACHE_CONFIGURATION' | 'CACHE_INPUT' | 'CACHE_SERIALIZATION' | 'CACHE_LIMIT';

/** Thrown when cache configuration is invalid, a write is malformed or over the byte cap, or a value cannot be encoded to or decoded from JSON. */
export class CacheError extends RedisToolkitError {
  declare readonly code: CacheErrorCode;
  constructor(code: CacheErrorCode, message: string, options?: ErrorOptions) { super(code, message, options); this.name = 'CacheError'; }
}

/** Normalized configuration for {@link RedisCache}. */
export interface CacheConfig extends ModuleConfigBase {
  /** TTL in seconds used when a write does not provide an explicit TTL. */
  defaultTtl: number;
  /** Maximum UTF-8 encoded JSON payload size accepted by a write. */
  maxValueBytes: number;
}

/** Options controlling a single cache write. */
export interface CacheSetOptions {
  /** Explicit TTL in seconds. Must be a positive integer when supplied. */
  ttl?: number;
  /** Write only when the key does not already exist. Mutually exclusive with {@link xx}. */
  nx?: boolean;
  /** Write only when the key already exists. Mutually exclusive with {@link nx}. */
  xx?: boolean;
}

/** Result of a cache lookup. */
export interface CacheResult<T> {
  /** True when Redis contained the requested key. */
  hit: boolean;
  /** Decoded value on a hit, otherwise `null`. */
  value: T | null;
}
