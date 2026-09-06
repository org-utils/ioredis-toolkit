import type { RedisClientWrapper } from '../redis/wrapper.js';
import { CacheError, type CacheConfig, type CacheResult, type CacheSetOptions } from './types.js';

/** JSON-based, namespaced Redis cache with TTL and conditional writes. */
export class RedisCache {
  /** Creates a cache bound to the shared Redis client. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: CacheConfig) {}

  /** Builds the physical Redis key for a logical cache key. */
  key(key: string): string { return `${this.config.namespace}:${key}`; }

  /** Reads and JSON-decodes a cached value. */
  async get<T>(key: string): Promise<CacheResult<T>> {
    const raw = await this.redis.get(this.key(key));
    if (raw === null) return { hit: false, value: null };
    try { return { hit: true, value: JSON.parse(raw) as T }; }
    catch (error) { throw new CacheError(`Cached value for "${key}" is not valid JSON`, { cause: error }); }
  }

  /** Reads a cached value and returns null on a miss. */
  async getValue<T>(key: string): Promise<T | null> { return (await this.get<T>(key)).value; }

  /** Stores a JSON-serializable value with optional TTL and NX/XX semantics. */
  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<boolean> {
    if (options.nx && options.xx) throw new RangeError('Cache set options nx and xx are mutually exclusive');
    if (options.ttl !== undefined && (!Number.isInteger(options.ttl) || options.ttl <= 0)) throw new RangeError('Cache TTL must be a positive integer');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Cache values must be JSON-serializable');
    if (Buffer.byteLength(encoded, 'utf8') > this.config.maxValueBytes) throw new RangeError('Cache value exceeds maxValueBytes');
    const args: string[] = ['EX', String(options.ttl ?? this.config.defaultTtl)];
    if (options.nx) args.push('NX');
    if (options.xx) args.push('XX');
    const result = await this.redis.set(this.key(key), encoded, ...args);
    return result === 'OK';
  }

  /** Deletes one or more cache entries. */
  async delete(...keys: string[]): Promise<number> { return this.redis.del(...keys.map(k => this.key(k))); }

  /** Removes one cache entry. Alias for delete. */
  async del(key: string): Promise<number> { return this.delete(key); }

  /** Checks whether a cache entry exists. */
  async has(key: string): Promise<boolean> { return (await this.redis.exists(this.key(key))) === 1; }

  /** Returns the remaining TTL in seconds. */
  async ttl(key: string): Promise<number> { return this.redis.ttl(this.key(key)); }

  /** Stores a value only when the key is absent. */
  async setIfAbsent<T>(key: string, value: T, ttl?: number): Promise<boolean> { return this.set(key, value, ttl === undefined ? { nx: true } : { ttl, nx: true }); }

  /** Invalidates all entries matching a namespaced pattern using cluster-aware scanning. */
  async clear(pattern = '*'): Promise<number> { return this.redis.deletePatternClusterAware(this.key(pattern)); }
}
