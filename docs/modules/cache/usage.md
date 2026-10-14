# Cache Module — Complete Usage Guide

`RedisCache` is a namespaced JSON cache built on the package's shared Redis client. It supports TTLs, conditional writes, bounded value sizes, and cluster-aware invalidation.

## 1. Setup

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,
  cache: {
    enabled: true,
    namespace: 'myapp:cache',
    defaultTtl: 300,
    maxValueBytes: 1024 * 1024,
  },
});
```

The module uses the same Redis connection as the rest of the package. Do not create a second Redis client just for caching.

`cache.enabled` defaults to `false`. Accessing `redis.cache` while disabled throws `RedisConfigurationError`; set `enabled: true` to use the module.

## 2. Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `enabled` | `boolean` | `false` | Enables the module. `redis.cache` throws `RedisConfigurationError` while disabled. |
| `namespace` | `string` | `cache` | Namespace: the first segment of every cache key. Letters, digits, `:`, `_` and `-` only, at most 128 characters. |
| `defaultTtl` | `number` | `300` | Default TTL in seconds. A positive integer. |
| `maxValueBytes` | `number` | `1048576` | Maximum UTF-8 encoded JSON size in bytes. A positive integer, at most `16777216` (16 MiB). |

The namespace must not overlap another enabled module's: two namespaces overlap when they are equal or one is a `:`-delimited prefix of the other (`app` and `app:cache`). `createRedisClient()` and `withCache()` throw `RedisConfigurationError` for an overlapping namespace.

`parseCacheConfig(input)` validates a configuration and returns the normalized `CacheConfig`, throwing `CacheError` with code `CACHE_CONFIGURATION` when it is invalid. `RedisCache`, `parseCacheConfig`, `CacheError` and the types `CacheConfig`, `CacheSetOptions`, `CacheResult` and `CacheErrorCode` are exported from both `ioredis-toolkit` and `ioredis-toolkit/cache`.

## 3. Methods

### `key(key)`

Returns the physical Redis key: the namespace, then the logical key.

```ts
redis.cache.key('user:42'); // myapp:cache:user:42
```

### `get<T>(key)`

Returns a `CacheResult<T>`, `{ hit, value }`. A miss returns `{ hit: false, value: null }`. A cached value that is not valid JSON (for example, written directly by another, non-conforming client) throws a typed `CacheError` (code `CACHE_SERIALIZATION`) rather than crashing with an uncaught `SyntaxError` or silently returning a miss.

```ts
import { CacheError } from 'ioredis-toolkit';

try {
  const result = await redis.cache.get<User>('user:42');
  if (result.hit && result.value !== null) console.log(result.value.email);
} catch (error) {
  if (error instanceof CacheError) {
    // The stored value could not be decoded as JSON.
  }
}
```

`value` is typed `T | null` whether or not `hit` is `true`, so narrow on `value` itself before reading from it.

### `getValue<T>(key)`

Convenience form returning the decoded value or `null`. A cached JSON `null` also returns `null`; use `get()` when a miss and a stored `null` must be told apart.

```ts
const user = await redis.cache.getValue<User>('user:42');
if (!user) {
  // cache miss
}
```

### `set<T>(key, value, options?)`

Stores a JSON value. `options` is a `CacheSetOptions`. `ttl` is in seconds. `nx` means create only when absent; `xx` means update only when present. `nx` and `xx` cannot both be true. Every write sets an expiry, `ttl` when given and `defaultTtl` otherwise, so this module never writes a key that does not expire.

```ts
await redis.cache.set('user:42', { id: '42', name: 'Anwar' }, { ttl: 600 });
await redis.cache.set('config', { version: 4 }, { nx: true, ttl: 60 });
await redis.cache.set('config', { version: 5 }, { xx: true, ttl: 60 });
```

Returns `true` when Redis accepted the write and `false` for a failed NX/XX condition.

### `setIfAbsent<T>(key, value, ttl?)`

Atomic create-if-absent helper.

```ts
const acquired = await redis.cache.setIfAbsent('job:123', { state: 'queued' }, 30);
```

### `has(key)`

Checks whether the physical key exists.

```ts
if (await redis.cache.has('user:42')) {
  console.log('cached');
}
```

### `ttl(key)`

Returns Redis TTL in seconds using normal Redis semantics (`-1` means no expiration and `-2` means missing).

```ts
const seconds = await redis.cache.ttl('user:42');
```

### `delete(...keys)` / `del(key)`

Deletes one or more entries and returns how many existed. Cluster mode groups keys by Redis hash slot so a cross-slot `DEL` is not issued. Called with no keys, it returns `0` without contacting Redis.

```ts
await redis.cache.delete('user:1', 'user:2', 'user:3');
await redis.cache.del('user:4');
```

### `clear(pattern?)`

Scans the cache namespace and deletes matching entries, returning how many it deleted. It never uses `KEYS` or `FLUSHALL`. Each page the scan returns is deleted before the next is fetched, in `DEL`s of at most 500 keys, grouped by hash slot on Cluster, so neither memory nor any one command grows with the number of matching keys.

```ts
await redis.cache.clear();
await redis.cache.clear('user:*');
```

For production, keep patterns bounded and avoid calling large namespace clears on latency-sensitive request paths.

## 4. Typed values

The generic parameter describes the value you expect to receive; Redis itself does not store TypeScript type information.

```ts
type Product = { id: string; price: number };
await redis.cache.set<Product>('product:1', { id: '1', price: 19.99 });
const product = await redis.cache.getValue<Product>('product:1');
```

## 5. Serialization limits

Values are encoded with `JSON.stringify`. A value is rejected with `CACHE_SERIALIZATION` when encoding throws (a cyclic structure, or a `BigInt` anywhere in it) or produces nothing (`undefined`, a function or a symbol as the value itself). Anything else is encoded by JSON's own rules, without an error: inside an object, a property holding `undefined`, a function or a symbol is dropped; inside an array, such an element becomes `null`; `NaN` and `Infinity` become `null`; and a `Date` becomes its ISO string. `get()` then returns the encoded shape, not the value that was written. The encoded UTF-8 payload must not exceed `maxValueBytes`.

## 6. Errors

Every error this module raises itself is a `CacheError`, which extends the package-wide `RedisToolkitError` and carries a stable `code`, typed `CacheErrorCode`. A failure reported by Redis or the connection passes through as ioredis raised it.

| Code | Thrown when |
|---|---|
| `CACHE_CONFIGURATION` | the cache configuration is invalid |
| `CACHE_INPUT` | `set()` is given both `nx` and `xx`, or a `ttl` that is not a positive integer |
| `CACHE_SERIALIZATION` | `set()` is given a value `JSON.stringify` throws on or encodes as nothing (see section 5), or `get()` reads a value that is not valid JSON |
| `CACHE_LIMIT` | the encoded value exceeds `maxValueBytes` |

## 7. Per-client overrides

Global configuration can be merged or replaced:

```ts
redis.withCache({ defaultTtl: 60 });
// namespace and maxValueBytes remain unchanged.

redis.withCache({ enabled: true, namespace: 'short-cache' }, 'replace');
// Unspecified values return to module defaults.
```

`'replace'` resets every option it is not given to its default, `enabled: false` included, so pass `enabled: true` or `redis.cache` throws `RedisConfigurationError` afterwards.
