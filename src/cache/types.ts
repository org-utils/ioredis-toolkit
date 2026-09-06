/** Thrown when a cached value cannot be decoded, or when the module is used while disabled. */
export class CacheError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'CacheError'; }
}

/** Normalized configuration for {@link RedisCache}. */
export interface CacheConfig {
  /** Whether the application has enabled the module. The class remains directly constructible when false; {@link RedisClient}'s `cache` getter throws when disabled. */
  enabled: boolean;
  /** Prefix used for every physical cache key. */
  namespace: string;
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
