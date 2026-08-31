import { RedisClientWrapper } from "./client.js";

import { RedisConfig, CacheOptions, CacheInputConfig } from "./types.js";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { defaultLogger, LoggerLike } from "./logger.js";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Cache layer on top of {@link RedisClientWrapper} with JSON serialization,
 * optional gzip compression and namespace support.
 *
 * Works in all three modes (standalone, sentinel, cluster): multi-key operations
 * are slot-aware and pattern scans cover every cluster node.
 *
 * @example
 * ```ts
 * const cache = new Cache(client, { defaultTTL: 3600, compressionThreshold: 1024 });
 * await cache.set('user:1', { name: 'alice' });
 * const user = await cache.get('user:1');
 * ```
 */
export class Cache {
  private client: RedisClientWrapper;
  private logger: LoggerLike;
  // private config: RedisConfig;
  private defaultTTL: number;
  private compressionThreshold: number;
  private namespace: string;

  /**
   * Creates a cache bound to a Redis client.
   *
   * **Parameters:**
   * - `client` - The underlying {@link RedisClientWrapper}. All cache operations
   *   delegate to this client.
   * - `config` - Configuration object with the following fields:
   *   - `defaultTTL` (number, optional, default: `3600`) - Default TTL in seconds
   *     applied when no per-call TTL is specified.
   *   - `compressionThreshold` (number, optional, default: `1024`) - Byte threshold
   *     above which values are gzip-compressed transparently.
   *   - `namespace` (string, optional, default: `''`) - Namespace prefix for all keys.
   * - `logger` - Optional pino-compatible logger. Supports `trace/debug/info/warn/error/fatal`
   *   levels and `child()` for namespace logging. Defaults to `console`.
   *
   * **Type Parameters:**
   * - `T` - The type of values stored/retrieved from the cache.
   *
   * **Example:**
   * ```ts
   * const cache = new Cache(client, { defaultTTL: 600, compressionThreshold: 2048, namespace: 'myapp' });
   * ```
   */
  constructor(
    client: RedisClientWrapper,
    config: CacheInputConfig,
    logger: LoggerLike = defaultLogger
  ) {
    this.client = client;
    this.logger = logger.child({ component: "Cache" });
    // this.config = config;
    this.defaultTTL = config.defaultTTL || 3600;
    this.compressionThreshold = config.compressionThreshold || 1024;
    this.namespace = config.namespace || "";
  }

  private async serialize<T>(
    value: T
  ): Promise<{ data: Buffer; compressed: boolean }> {
    // Convert to Buffer
    let data: Buffer;
    if (Buffer.isBuffer(value)) {
      data = value;
    } else if (typeof value === "string") {
      data = Buffer.from(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      data = Buffer.from(String(value));
    } else {
      // JSON for objects
      data = Buffer.from(JSON.stringify(value));
    }

    // Compress if large enough
    if (data.length > this.compressionThreshold) {
      try {
        const compressed = await gzip(data);
        return { data: compressed, compressed: true };
      } catch (error) {
        this.logger.warn("Compression failed, storing uncompressed");
        return { data, compressed: false };
      }
    }

    return { data, compressed: false };
  }

  private async deserialize<T>(data: Buffer, compressed: boolean): Promise<T> {
    let buffer = data;
    if (compressed) {
      try {
        buffer = await gunzip(data);
      } catch (error) {
        this.logger.warn("Decompression failed, trying raw data");
        // Attempt to use raw data if decompression fails
      }
    }

    // Try to parse as JSON if it looks like JSON
    const str = buffer.toString();
    try {
      if (str.startsWith("{") || str.startsWith("[")) {
        return JSON.parse(str);
      }
    } catch {
      // Not JSON, return as string
    }

    return str as T;
  }

  private get getNamespace(): string {
    return this.namespace?.trim() ? `${this.namespace}:` : "";
  }

  private getKey(key: string, namespace?: string): string {
    if (namespace?.trim()) {
      return `${this.getNamespace}${namespace.trim()}:${key}`;
    }
    return `${this.getNamespace}${key}`;
  }

  /**
   * Reads a cached value.
   *
   * Objects are parsed from JSON and compressed values are transparently
   * decompressed. Strings that are not JSON are returned as-is.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix (`namespace:key`).
   * @returns The stored value, or `null` when missing.
   *
   * @example
   * ```ts
   * const user = await cache.get<User>('user:1');
   * const token = await cache.get('token', 'auth');
   * ```
   */
  /**
   * Reads a cached value.
   *
   * **Behavior:**
   * - Objects are parsed from JSON when stored as JSON.
   * - Values larger than `compressionThreshold` bytes are transparently
   *   decompressed (gzip) when reading.
   * - Strings that are not JSON are returned as-is.
   * - If the key does not exist, returns `null`.
   *
   * **Type Parameters:**
   * - `T` - The expected return type. When the stored value is a JSON object/array,
   *   it will be parsed and returned as `T`. When it's a primitive (string/number/bool),
   *   it is returned as-is and typed as `T`.
   *
   * **Returns:**
   * - The stored value, parsed as `T` when possible, or `null` when the key is missing.
   *
   * **Example:**
   * ```ts
   * // Store an object
   * await cache.set('user:1', { name: 'alice', age: 30 });
   *
   * // Read it back with type coercion
   * const user: { name: string; age: number } | null = await cache.get<UserProfile>('user:1');
   * // user === { name: 'alice', age: 30 }
   *
   * // Read a string value
   * const token = await cache.get('token'); // 'abc' | null
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key.
   * - `namespace` - Optional namespace prefix (`namespace:key`). When provided,
   *   the key is internally transformed to `${namespace}:${key}`.
   *
   * @returns The stored value, or `null` when missing.
   */
  async get<T = any>(key: string, namespace?: string): Promise<T | null> {
    const fullKey = this.getKey(key, namespace);
    const raw = await this.client.get(fullKey);

    if (!raw) return null;

    try {
      // Check if stored with metadata
      const parsed = JSON.parse(raw);
      if (parsed._compressed && parsed._data) {
        const data = Buffer.from(parsed._data, "base64");
        return this.deserialize<T>(data, parsed._compressed);
      }
      // Legacy format - try to parse as JSON
      return JSON.parse(raw);
    } catch {
      // Raw string value
      return raw as T;
    }
  }

  /**
   * Stores a value in the cache.
   *
   * @param key - Cache key.
   * @param value - Any serializable value (string, number, boolean, Buffer, object).
   * @param options - `ttl` in seconds (defaults to `defaultTTL`), `namespace`,
   *   and `compress` (default `true`). Values larger than `compressionThreshold`
   *   bytes are gzip-compressed.
   * @returns `true` when stored successfully.
   *
   * @example
   * ```ts
   * await cache.set('user:1', user, { ttl: 300 });
   * await cache.set('token', 'abc', { namespace: 'auth', compress: false });
   * ```
   */
  /**
   * Stores a value in the cache.
   *
   * **Behavior:**
   * - Values are JSON-serialized when they are objects, arrays, or booleans/strings/numbers
   *   are stored as-is.
   * - Values larger than `compressionThreshold` bytes are gzip-compressed transparently.
   *   The compressed form is stored with metadata (`_compressed: true`, `_data: base64`) so
   *   it is transparently decompressed on read.
   * - Set `compress: false` to disable compression for a single write, regardless of size.
   * - Per-call TTL overrides the cache's `defaultTTL`.
   * - Per-call `namespace` overrides the cache's configured namespace for that operation.
   *
   * **Type Parameters:**
   * - `T` - The type of the value being stored. Can be any serializable JavaScript value.
   *
   * **Returns:**
   * - `true` when the value was stored successfully (`result === 'OK'`).
   *
   * **Example:**
   * ```ts
   * // Store an object with a custom TTL
   * await cache.set('user:1', { name: 'alice' }, { ttl: 300 });
   *
   * // Store with compression disabled
   * await cache.set('token', 'abc123', { compress: false });
   *
   * // Store with a namespace
   * await cache.set('token', 'abc', { namespace: 'auth' });
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key.
   * - `value` - Any serializable value (string, number, boolean, Buffer, or object).
   * - `options` - Optional configuration:
   *   - `ttl` (number, optional) - TTL in seconds. Falls back to `defaultTTL`.
   *   - `namespace` (string, optional) - Namespace prefix. Falls back to cache config.
   *   - `compress` (boolean, optional) - Force compression or disable it. Defaults to `true`.
   *
   * @returns `true` when stored successfully.
   */
  async set<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const fullKey = this.getKey(key, options.namespace);
    const ttl = options.ttl || this.defaultTTL;
    const shouldCompress =
      options.compress !== undefined ? options.compress : true;

    try {
      let rawValue: string | Buffer;

      if (shouldCompress) {
        const { data, compressed } = await this.serialize(value);
        if (compressed) {
          // Store with metadata
          rawValue = JSON.stringify({
            _compressed: true,
            _data: data.toString("base64"),
          });
        } else {
          rawValue = data;
        }
      } else {
        if (typeof value === "string") {
          rawValue = value;
        } else if (Buffer.isBuffer(value)) {
          rawValue = value;
        } else {
          rawValue = JSON.stringify(value);
        }
      }

      const result = await this.client.set(fullKey, rawValue, ttl);
      this.logger.debug("Cache set", {
        key: fullKey,
        ttl,
        compressed: shouldCompress,
      });
      return result === "OK";
    } catch (error) {
      this.logger.error("Cache set failed:", error as Record<string, any>);
      return false;
    }
  }

  /**
   * Stores a value only if the key does not exist yet (`SETNX`).
   *
   * @param key - Cache key.
   * @param value - The value to store.
   * @param options - `ttl` in seconds and `namespace`.
   * @returns `true` only when the value was actually stored.
   *
   * @example
   * ```ts
   * const claimed = await cache.setNX('job:1', 'worker-1', { ttl: 60 });
   * ```
   */
  /**
   * Stores a value only if the key does not exist yet (`SETNX`).
   *
   * **Behavior:**
   * - The value is stored atomically using Redis `SET key value EX ttl NX`.
   * - Returns `true` only when the key did not exist and the value was set.
   * - Per-call TTL overrides the cache's `defaultTTL`.
   * - Per-call `namespace` is applied to the key.
   *
   * **Type Parameters:**
   * - `T` - The type of the value being stored. Will be JSON-stringified if not a string.
   *
   * **Returns:**
   * - `true` only when the value was actually stored (Redis SETNX returned `1`).
   *
   * **Example:**
   * ```ts
   * const claimed = await cache.setNX('job:1', 'worker-1', { ttl: 60 });
   * // claimed === true (job was claimed by this worker)
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key.
   * - `value` - The value to store. String stored as-is; objects are JSON-stringified.
   * - `options` - Optional configuration:
   *   - `ttl` (number, optional) - TTL in seconds. Falls back to `defaultTTL`.
   *   - `namespace` (string, optional) - Namespace prefix.
   *
   * @returns `true` only when the value was actually stored.
   */
  async setNX<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const fullKey = this.getKey(key, options.namespace);
    const ttl = options.ttl || this.defaultTTL;

    try {
      const rawValue =
        typeof value === "string" ? value : JSON.stringify(value);
      const result = await this.client.setnx(fullKey, rawValue, ttl);
      return result === 1;
    } catch (error) {
      this.logger.error("Cache setNX failed:", error as Record<string, any>);
      return false;
    }
  }
  /**
   * Stores a value only if the key does not exist yet, atomically with the TTL
   * (`SET ... EX NX`).
   *
   * @param key - Cache key.
   * @param value - The value to store.
   * @param options - `ttl` in seconds and `namespace`.
   * @returns `true` only when the value was actually stored.
   *
   * @example
   * ```ts
   * const locked = await cache.setEXNX('lock:order:42', 'txn-id', { ttl: 30 });
   * ```
   */
  /**
   * Stores a value only if the key does not exist yet, atomically with the TTL
   * (`SET ... EX NX`).
   *
   * **Behavior:**
   * - The value is stored atomically using Redis `SET key value EX ttl NX`.
   * - This is the atomic equivalent of calling `SET key value EX ttl` followed by
   *   `SET key value NX` - but done in a single Redis call.
   * - Returns `true` only when the key did not exist and the value was set with TTL.
   * - Per-call TTL overrides the cache's `defaultTTL`.
   * - Per-call `namespace` is applied to the key.
   *
   * **Type Parameters:**
   * - `T` - The type of the value being stored. Will be JSON-stringified if not a string.
   *
   * **Returns:**
   * - `true` only when the value was actually stored (Redis SET returned `OK`).
   *
   * **Example:**
   * ```ts
   * const locked = await cache.setEXNX('lock:order:42', 'txn-id', { ttl: 30 });
   * // locked === true (lock was acquired with 30s TTL)
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key.
   * - `value` - The value to store. String stored as-is; objects are JSON-stringified.
   * - `options` - Optional configuration:
   *   - `ttl` (number, optional) - TTL in seconds. Falls back to `defaultTTL`.
   *   - `namespace` (string, optional) - Namespace prefix.
   *
   * @returns `true` only when the value was actually stored.
   */
  async setEXNX<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const fullKey = this.getKey(key, options.namespace);
    const ttl = options.ttl || this.defaultTTL;

    try {
      const rawValue =
        typeof value === "string" ? value : JSON.stringify(value);
      const result = await this.client.setexnx(fullKey, rawValue, ttl);
      return result === "OK";
    } catch (error) {
      this.logger.error("Cache setEXNX failed:", error as Record<string, any>);
      return false;
    }
  }

  // Old mget - CROSSSLOT error in cluster mode when keys span different slots
  // async mget<T = any>(keys: string[], namespace?: string): Promise<(T | null)[]> {
  //   const fullKeys = keys.map(k => this.getKey(k, namespace));
  //   const raw = await this.client.mget(...fullKeys);
  //
  //   return Promise.all(
  //     raw.map(async (item) => {
  //       if (!item) return null;
  //       try {
  //         const parsed = JSON.parse(item);
  //         if (parsed._compressed && parsed._data) {
  //           const data = Buffer.from(parsed._data, 'base64');
  //           return this.deserialize<T>(data, parsed._compressed);
  //         }
  //         return parsed;
  //       } catch {
  //         return item as T;
  //       }
  //     })
  //   );
  // }
  // Cluster-safe: groups keys by slot via mgetClusterAware

  /**
   * Reads multiple cache keys in one call.
   *
   * Cluster-safe: keys are grouped by hash slot under the hood.
   *
   * @param keys - Cache keys to read.
   * @param namespace - Optional namespace prefix applied to every key.
   * @returns Values in input order; `null` for missing keys.
   *
   * @example
   * ```ts
   * const [a, b] = await cache.mget(['user:1', 'user:2']);
   * ```
   */
  /**
   * Reads multiple cache keys in one call.
   *
   * **Behavior:**
   * - Cluster-safe: keys are grouped by hash slot under the hood, avoiding CROSS-SLOT errors.
   * - Values are deserialized from JSON when stored as JSON. Strings/numbers/buffers
   *   are returned as-is.
   * - Missing keys return `null` in the corresponding position.
   *
   * **Type Parameters:**
   * - `T` - The expected type of each returned value. When the stored value is JSON,
   *   it will be parsed and coerced to `T`.
   *
   * **Returns:**
   * - An array of values in the same order as the input `keys`. Each element is `T | null`.
   *   `null` indicates the key did not exist.
   *
   * **Example:**
   * ```ts
   * const [a, b] = await cache.mget(['user:1', 'user:2']);
   * // a === { name: 'alice' }, b === { name: 'bob' }
   * ```
   *
   * **Parameters:**
   * - `keys` - Cache keys to read. Will have the namespace prefix applied automatically
   *   if a namespace is configured.
   * - `namespace` - Optional namespace prefix applied to every key. When provided,
   *   each key is internally transformed to `${namespace}:${key}`.
   *
   * @returns Values in input order; `null` for missing keys.
   */
  async mget<T = any>(
    keys: string[],
    namespace?: string
  ): Promise<(T | null)[]> {
    const fullKeys = keys.map((k) => this.getKey(k, namespace));
    const raw = await this.client.mgetClusterAware(fullKeys);

    return Promise.all(
      raw.map(async (item) => {
        if (!item) return null;
        try {
          const parsed = JSON.parse(item);
          if (parsed._compressed && parsed._data) {
            const data = Buffer.from(parsed._data, "base64");
            return this.deserialize<T>(data, parsed._compressed);
          }
          return parsed;
        } catch {
          return item as T;
        }
      })
    );
  }

  // Old mset - a pipeline whose keys span different slots is rejected in cluster mode
  // async mset<T>(
  //   entries: Record<string, T>,
  //   options: CacheOptions = {}
  // ): Promise<boolean> {
  //   const ttl = options.ttl || this.defaultTTL;
  //   const namespace = options.namespace;
  //
  //   try {
  //     const pipeline = this.client.pipeline();
  //
  //     for (const [key, value] of Object.entries(entries)) {
  //       const fullKey = this.getKey(key, namespace);
  //       const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
  //       pipeline.set(fullKey, rawValue, 'EX', ttl);
  //     }
  //
  //     const results = await pipeline.exec();
  //     return !!results?.every((result: any) => result[1] === 'OK');
  //   } catch (error) {
  //     this.logger.error('Cache mset failed:', error as Record<string, any>);
  //     return false;
  //   }
  // }
  // Cluster-safe: one pipeline per hash slot
  /**
   * Stores multiple key/value entries in one call.
   *
   * Cluster-safe: entries are grouped by hash slot, one pipeline per slot.
   *
   * @param entries - Object mapping cache keys to values.
   * @param options - `ttl` in seconds (defaults to `defaultTTL`) and `namespace`.
   * @returns `true` when every entry was stored.
   *
   * @example
   * ```ts
   * await cache.mset({ 'user:1': alice, 'user:2': bob }, { ttl: 300 });
   * ```
   */
  /**
   * Stores multiple key/value entries in one call.
   *
   * **Behavior:**
   * - Cluster-safe: entries are grouped by hash slot, one pipeline per slot.
   *   This avoids CROSS-SLOT errors that would occur if keys spanned multiple slots in a
   *   single pipeline.
   * - Values are JSON-serialized when they are objects; strings/buffers are stored as-is.
   * - Per-call TTL overrides the cache's `defaultTTL`.
   * - Per-call `namespace` is applied to all keys.
   *
   * **Type Parameters:**
   * - `T` - The type of values being stored. Objects are JSON-stringified; strings/buffers
   *   are stored as-is.
   *
   * **Returns:**
   * - `true` when every entry was stored successfully.
   * - `false` if any entry failed to store.
   *
   * **Example:**
   * ```ts
   * await cache.mset({ 'user:1': alice, 'user:2': bob }, { ttl: 300 });
   * // Both entries stored with a 5-minute TTL
   * ```
   *
   * **Parameters:**
   * - `entries` - Object mapping cache keys to values.
   * - `options` - Optional configuration:
   *   - `ttl` (number, optional) - TTL in seconds. Falls back to `defaultTTL`.
   *   - `namespace` (string, optional) - Namespace prefix. Applied to all keys.
   *
   * @returns `true` when every entry was stored.
   */
  async mset<T>(
    entries: Record<string, T>,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const ttl = options.ttl || this.defaultTTL;
    const namespace = options.namespace;

    try {
      const groups = new Map<number, Array<[string, string | Buffer]>>();
      for (const [key, value] of Object.entries(entries)) {
        const fullKey = this.getKey(key, namespace);
        const rawValue =
          typeof value === "string" ? value : JSON.stringify(value);
        const slot = this.client.calculateSlot(fullKey);
        if (!groups.has(slot)) {
          groups.set(slot, []);
        }
        groups.get(slot)!.push([fullKey, rawValue]);
      }

      for (const group of groups.values()) {
        const pipeline = this.client.pipeline();
        for (const [fullKey, rawValue] of group) {
          pipeline.set(fullKey, rawValue, "EX", ttl);
        }
        const results = await pipeline.exec();
        if (!results?.every((result: any) => result[1] === "OK")) {
          return false;
        }
      }
      return true;
    } catch (error) {
      this.logger.error("Cache mset failed:", error as Record<string, any>);
      return false;
    }
  }

  /**
   * Deletes a cache key.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix.
   * @returns `true` if the key existed and was deleted.
   *
   * @example
   * ```ts
   * const removed = await cache.delete('user:1');
   * ```
   */
  /**
   * Deletes a cache key.
   *
   * **Behavior:**
   * - Deletes the full key (including any namespace prefix).
   * - Returns `true` only when the key existed and was deleted (Redis DEL returned `1`).
   *
   * **Returns:**
   * - `true` if the key existed and was deleted.
   *
   * **Example:**
   * ```ts
   * const removed = await cache.delete('user:1');
   * // removed === true
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key.
   * - `namespace` - Optional namespace prefix.
   *
   * @returns `true` if the key existed and was deleted.
   */
  async delete(key: string, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.del(fullKey);
    return result > 0;
  }

  /**
   * Checks whether a cache key exists.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix.
   * @returns `true` if the key exists.
   *
   * @example
   * ```ts
   * const cached = await cache.exists('user:1');
   * ```
   */
  /**
   * Checks whether a cache key exists.
   *
   * **Returns:**
   * - `true` if the key exists in Redis.
   * - `false` if the key does not exist.
   *
   * **Example:**
   * ```ts
   * const cached = await cache.exists('user:1');
   * // cached === true when 'user:1' has been set
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key.
   * - `namespace` - Optional namespace prefix.
   *
   * @returns `true` if the key exists.
   */
  async exists(key: string, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.exists(fullKey);
    return result === 1;
  }

  /**
   * Sets the TTL of an existing cache key.
   *
   * @param key - Cache key.
   * @param ttl - TTL in seconds.
   * @param namespace - Optional namespace prefix.
   * @returns `true` if the TTL was applied.
   *
   * @example
   * ```ts
   * const extended = await cache.expire('session:42', 3600);
   * ```
   */
  /**
   * Sets the TTL of an existing cache key.
   *
   * **Returns:**
   * - `true` if the TTL was applied (Redis EXPIRE returned `1`).
   * - `false` if the key did not exist.
   *
   * **Example:**
   * ```ts
   * const extended = await cache.expire('session:42', 3600);
   * // extended === true (TTL was set to 1 hour)
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key.
   * - `ttl` - TTL in seconds.
   * - `namespace` - Optional namespace prefix.
   *
   * @returns `true` if the TTL was applied.
   */
  async expire(key: string, ttl: number, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.expire(fullKey, ttl);
    return result === 1;
  }

  /**
   * Returns the remaining TTL of a cache key in seconds.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix.
   * @returns Remaining TTL in seconds (`-2` if missing, `-1` if no TTL).
   *
   * @example
   * ```ts
   * const secondsLeft = await cache.ttl('session:42');
   * ```
   */
  /**
   * Returns the remaining TTL of a cache key in seconds.
   *
   * **Returns:**
   * - The remaining TTL in seconds.
   * - `-2` if the key does not exist.
   * - `-1` if the key exists but has no TTL set.
   *
   * **Example:**
   * ```ts
   * const secondsLeft = await cache.ttl('session:42');
   * // secondsLeft === 2500 (approximately 42 minutes remaining)
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key.
   * - `namespace` - Optional namespace prefix.
   *
   * @returns Remaining TTL in seconds (`-2` if missing, `-1` if no TTL).
   */
  async ttl(key: string, namespace?: string): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.ttl(fullKey);
  }

  /**
   * Atomically increments a cache counter.
   *
   * @param key - Counter key.
   * @param by - Amount to increment by (default `1`; ignored by Redis, kept for API parity).
   * @param namespace - Optional namespace prefix.
   * @returns The new counter value.
   *
   * @example
   * ```ts
   * const visits = await cache.increment('stats:visits');
   * ```
   */
  /**
   * Atomically increments a cache counter.
   *
   * **Behavior:**
   * - Uses Redis `INCR` command on the full key (including namespace if set).
   * - The counter starts at `0` if the key does not exist, then increments to `1`.
   * - The `by` parameter is passed to Redis but note: Redis `INCR` always increments
   *   by `1`. The `by` parameter is kept for API parity with other cache implementations
   *   but has no effect on the actual Redis command result.
   *
   * **Returns:**
   * - The new counter value (the value after incrementing).
   *
   * **Example:**
   * ```ts
   * const visits = await cache.increment('stats:visits');
   * // visits === 1 (first increment)
   * const more = await cache.increment('stats:visits', 5); // by parameter ignored
   * // more === 2
   * ```
   *
   * **Parameters:**
   * - `key` - Counter key.
   * - `by` - Amount to increment by (default `1`). Note: Redis `INCR` always increments
   *   by `1`; this parameter is kept for API parity.
   * - `namespace` - Optional namespace prefix.
   *
   * @returns The new counter value.
   */
  async increment(
    key: string,
    by: number = 1,
    namespace?: string
  ): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.incr(fullKey);
  }

  /**
   * Atomically decrements a cache counter.
   *
   * @param key - Counter key.
   * @param by - Amount to decrement by (default `1`; ignored by Redis, kept for API parity).
   * @param namespace - Optional namespace prefix.
   * @returns The new counter value.
   *
   * @example
   * ```ts
   * const stock = await cache.decrement('inventory:sku-1');
   * ```
   */
  /**
   * Atomically decrements a cache counter.
   *
   * **Behavior:**
   * - Uses Redis `DECR` command on the full key (including namespace if set).
   * - The `by` parameter is passed to Redis but note: Redis `DECR` always decrements
   *   by `1`. The `by` parameter is kept for API parity with other cache implementations
   *   but has no effect on the actual Redis command result.
   *
   * **Returns:**
   * - The new counter value (the value after decrementing).
   *
   * **Example:**
   * ```ts
   * const stock = await cache.decrement('inventory:sku-1');
   * // stock === 99 (started at 100, decremented by 1)
   * ```
   *
   * **Parameters:**
   * - `key` - Counter key.
   * - `by` - Amount to decrement by (default `1`). Note: Redis `DECR` always decrements
   *   by `1`; this parameter is kept for API parity.
   * - `namespace` - Optional namespace prefix.
   *
   * @returns The new counter value.
   */
  async decrement(
    key: string,
    by: number = 1,
    namespace?: string
  ): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.decr(fullKey);
  }

  // Hash helpers
  /**
   * Reads a field from a hash-style cache key.
   *
   * @param key - Cache key.
   * @param field - Hash field.
   * @param namespace - Optional namespace prefix.
   * @returns The field value (JSON-parsed when possible), or `null`.
   *
   * @example
   * ```ts
   * const name = await cache.hget('user:1', 'name');
   * ```
   */
  /**
   * Reads a field from a hash-style cache key.
   *
   * **Behavior:**
   * - The field value is retrieved from the Redis hash.
   * - When the stored value is a JSON string, it is parsed and returned as the typed result.
   * - When the stored value is not JSON, it is returned as a raw string, typed as `T`.
   *
   * **Returns:**
   * - The field value, parsed as `T` when possible, or `null` when the key or field does not exist.
   *
   * **Example:**
   * ```ts
   * const name = await cache.hget('user:1', 'name');
   * // name === 'alice' | null
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key (hash key in Redis).
   * - `field` - Hash field to read.
   * - `namespace` - Optional namespace prefix. Applied to the key.
   *
   * @returns The field value, or `null`.
   */
  async hget<T = any>(
    key: string,
    field: string,
    namespace?: string
  ): Promise<T | null> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.hget(fullKey, field);
    if (!result) return null;
    try {
      return JSON.parse(result);
    } catch {
      return result as T;
    }
  }

  /**
   * Writes a field into a hash-style cache key.
   *
   * @param key - Cache key.
   * @param field - Hash field.
   * @param value - Any serializable value (JSON-stringified unless it is a string).
   * @param namespace - Optional namespace prefix.
   * @returns `true` if a new field was created.
   *
   * @example
   * ```ts
   * await cache.hset('user:1', 'age', 30);
   * ```
   */
  /**
   * Writes a field into a hash-style cache key.
   *
   * **Behavior:**
   * - The value is JSON-stringified when it is not a string (objects, arrays, etc.).
   *   Strings are stored as-is.
   * - Returns `true` only when a new field was created (Redis HSET returned `1`).
   *   If the field already exists, its value is overwritten and `true` is still returned.
   *
   * **Returns:**
   * - `true` if a new field was created.
   *
   * **Example:**
   * ```ts
   * await cache.hset('user:1', 'age', 30);
   * // Field 'age' set to '30' (stringified) in hash 'user:1'
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key (hash key in Redis).
   * - `field` - Hash field to write.
   * - `value` - Any serializable value. Strings stored as-is; objects are JSON-stringified.
   * - `namespace` - Optional namespace prefix. Applied to the key.
   *
   * @returns `true` if a new field was created.
   */
  async hset(
    key: string,
    field: string,
    value: any,
    namespace?: string
  ): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const rawValue = typeof value === "string" ? value : JSON.stringify(value);
    const result = await this.client.hset(fullKey, field, rawValue);
    return result === 1;
  }

  /**
   * Returns every field of a hash-style cache key.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix.
   * @returns Object mapping fields to values (JSON-parsed when possible).
   *
   * @example
   * ```ts
   * const profile = await cache.hgetall('user:1');
   * ```
   */
  /**
   * Returns every field of a hash-style cache key.
   *
   * **Behavior:**
   * - Retrieves all fields and values from the Redis hash.
   * - Each value is parsed from JSON when possible. Non-JSON values are returned as raw strings.
   * - Returns an empty object `{}` when the key does not exist or has no fields.
   *
   * **Returns:**
   * - An object mapping field names to their values, with values parsed as `T` when possible.
   *
   * **Example:**
   * ```ts
   * const profile = await cache.hgetall('user:1');
   * // profile === { age: 30, name: 'alice' }
   * ```
   *
   * **Parameters:**
   * - `key` - Cache key (hash key in Redis).
   * - `namespace` - Optional namespace prefix. Applied to the key.
   *
   * @returns Object mapping fields to values (JSON-parsed when possible).
   */
  async hgetall<T = any>(
    key: string,
    namespace?: string
  ): Promise<Record<string, T>> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.hgetall(fullKey);

    const parsed: Record<string, T> = {};
    for (const [field, value] of Object.entries(result)) {
      try {
        parsed[field] = JSON.parse(value);
      } catch {
        parsed[field] = value as T;
      }
    }
    return parsed;
  }

  // Delete by pattern
  /**
   * Deletes every cache key matching a glob pattern.
   *
   * Cluster-safe: scans every node before deleting.
   *
   * @param pattern - Glob pattern, e.g. `'user:*'`.
   * @param namespace - Optional namespace prefix (`namespace:pattern`).
   * @returns The number of deleted keys.
   *
   * @example
   * ```ts
   * const removed = await cache.deletePattern('temp:*');
   * ```
   */
  /**
   * Deletes every cache key matching a glob pattern.
   *
   * **Behavior:**
   * - Cluster-safe: scans every node before deleting.
   * - Uses `SCAN` iteratively to avoid blocking the Redis server on large datasets.
   * - Each matching key is individually deleted via `DEL`.
   * - The `batchSize` and `scanCount` options control the scan batching.
   *
   * **Returns:**
   * - The number of deleted keys.
   *
   * **Example:**
   * ```ts
   * const removed = await cache.deletePattern('temp:*');
   * // removed === number of keys matching 'temp:*' that were deleted
   * ```
   *
   * **Parameters:**
   * - `pattern` - Glob pattern, e.g. `'temp:*'`.
   * - `namespace` - Optional namespace prefix. The pattern is transformed to
   *   `${namespace}:${pattern}` before scanning.
   *
   * @returns The number of deleted keys.
   */
  async deletePattern(pattern: string, namespace?: string): Promise<number> {
    const fullPattern = this.getKey(pattern, namespace)
    let deleted = 0;

    for await (const key of this.client.scanIterator(fullPattern)) {
      const result = await this.client.del(key);
      deleted += result;
    }

    return deleted;
  }

  // Get all keys matching pattern
  /**
   * Lists every cache key matching a glob pattern.
   *
   * Cluster-safe: scans every node.
   *
   * @param pattern - Glob pattern, e.g. `'session:*'`.
   * @param namespace - Optional namespace prefix (`namespace:pattern`).
   * @returns Matching keys.
   *
   * @example
   * ```ts
   * const sessions = await cache.keys('session:*');
   * ```
   */
  /**
   * Lists every cache key matching a glob pattern.
   *
   * **Behavior:**
   * - Cluster-safe: scans every node.
   * - Uses `SCAN` iteratively to avoid blocking the Redis server on large datasets.
   * - Returns all keys matching the glob pattern across all nodes (in cluster mode).
   *
   * **Returns:**
   * - An array of matching keys (relative format, without namespace prefix unless
   *   one was provided in the options).
   *
   * **Example:**
   * ```ts
   * const sessions = await cache.keys('session:*');
   * // sessions === ['session:1', 'session:2', ...]
   * ```
   *
   * **Parameters:**
   * - `pattern` - Glob pattern, e.g. `'session:*'`.
   * - `namespace` - Optional namespace prefix. The pattern is transformed to
   *   `${namespace}:${pattern}` before scanning.
   *
   * @returns Matching keys.
   */
  async keys(pattern: string, namespace?: string): Promise<string[]> {
    const fullPattern = this.getKey(pattern, namespace)

    const keys: string[] = [];

    for await (const key of this.client.scanIterator(fullPattern)) {
      keys.push(key);
    }

    return keys;
  }

  // Clear entire namespace
  /**
   * Deletes every key inside a namespace.
   *
   * @param namespace - Namespace to wipe (`namespace:*`).
   * @returns The number of deleted keys.
   *
   * @example
   * ```ts
   * const cleared = await cache.clearNamespace('sessions');
   * ```
   */
  /**
   * Deletes every key inside a namespace.
   *
   * **Behavior:**
   * - Deletes all keys matching the pattern `*` within the specified namespace.
   * - Internally calls {@link deletePattern} with the pattern `*` and the given namespace.
   *
   * **Returns:**
   * - The number of deleted keys.
   *
   * **Example:**
   * ```ts
   * const cleared = await cache.clearNamespace('sessions');
   * // cleared === number of keys deleted in the 'sessions' namespace
   * ```
   *
   * **Parameters:**
   * - `namespace` - Namespace to wipe (e.g. `'sessions'`). Every key of the form
   *   `namespace:*` will be deleted.
   *
   * @returns The number of deleted keys.
   */
  async clearNamespace(namespace: string): Promise<number> {
    return this.deletePattern("*", namespace);
  }
}
