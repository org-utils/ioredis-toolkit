# Cache Module — Complete Usage Guide

`RedisCache` is a namespaced JSON cache built on the package's shared `RedisClientWrapper`. It supports TTLs, conditional writes, bounded value sizes, and cluster-aware invalidation.

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
| `enabled` | `boolean` | `false` | Enables the module. `redis.cache` throws `RedisConfigurationError` while disabled; `new RedisCache(...)` remains directly constructible either way. |
| `namespace` | `string` | `cache` | Prefix placed before every cache key. |
| `defaultTtl` | `number` | `300` | Default TTL in seconds. |
| `maxValueBytes` | `number` | `1048576` | Maximum UTF-8 encoded JSON size. |

## 3. Methods

### `key(key)`

Returns the physical Redis key. Example: `cache:user:42`.

```ts
redis.cache.key('user:42');
```

### `get<T>(key)`

Returns `{ hit, value }`. A miss returns `{ hit: false, value: null }`. A cached value that is not valid JSON (for example, written directly by another, non-conforming client) throws a typed `CacheError` rather than crashing with an uncaught `SyntaxError` or silently returning a miss.

```ts
import { CacheError } from 'ioredis-toolkit';

try {
  const result = await redis.cache.get<User>('user:42');
  if (result.hit) console.log(result.value.email);
} catch (error) {
  if (error instanceof CacheError) {
    // The stored value could not be decoded as JSON.
  }
}
```

### `getValue<T>(key)`

Convenience form returning the decoded value or `null`.

```ts
const user = await redis.cache.getValue<User>('user:42');
if (!user) {
  // cache miss
}
```

### `set<T>(key, value, options?)`

Stores a JSON value. `ttl` is in seconds. `nx` means create only when absent; `xx` means update only when present. `nx` and `xx` cannot both be true.

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

Deletes one or more entries. Cluster mode groups keys by Redis hash slot so a cross-slot `DEL` is not issued.

```ts
await redis.cache.delete('user:1', 'user:2', 'user:3');
await redis.cache.del('user:4');
```

### `clear(pattern?)`

Scans the cache namespace and deletes matching entries. It never uses `KEYS` or `FLUSHALL`.

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

Values must be JSON-serializable. `undefined`, functions, symbols, cyclic structures, and values that cannot be represented by JSON are rejected. The encoded UTF-8 payload must not exceed `maxValueBytes`.

## 6. Per-client overrides

Global configuration can be merged or replaced:

```ts
redis.withCache({ defaultTtl: 60 });
// namespace and maxValueBytes remain unchanged.

redis.withCache({ namespace: 'short-cache' }, 'replace');
// Unspecified values return to module defaults.
```
