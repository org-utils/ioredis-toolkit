# ioredis-toolkit

Production-grade, type-safe Redis infrastructure for distributed systems: a unified client, cache, rate limiter, distributed lock, pub/sub, health checking, and session management — all working in **standalone**, **sentinel**, and **cluster** modes.

<a name="installation"></a>
## Installation

```bash
npm install ioredis-toolkit ioredis zod
```

<a name="quick-start"></a>
## Quick Start

```ts
import { RedisClientWrapper, Cache, RateLimiter } from 'ioredis-toolkit';

// 1. Create the Redis client (standalone by default)
const client = new RedisClientWrapper({
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
});

// 2. Cache — JSON serialization, TTL, namespaces, compression
const cache = new Cache(client, { defaultTTL: 3600, compressionThreshold: 1024 });
await cache.set('user:1', { name: 'alice' });
const user = await cache.get('user:1');

// 3. Rate limiting — per-route, per-IP, per-user
const limiter = new RateLimiter(client, { limit: 100, duration: 60 });
const result = await limiter.consume('/api/login', 'ip-10.0.0.1');
if (!result.allowed) {
  // HTTP 429, set Retry-After: result.retryAfter
}

// 4. Graceful shutdown
await client.close();
```

<a name="topology"></a>
## Topology & Configuration

Choose the Redis topology via the `mode` config field. All features behave identically across modes; only the underlying connection changes.

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `'standalone' \| 'sentinel' \| 'cluster'` | `'standalone'` | Redis topology |
| `host` | `string` | `'localhost'` | Standalone host |
| `port` | `number` | `6379` | Standalone port |
| `url` | `string` | — | Full Redis URL (e.g. `redis://:pass@host:6379/0`) |
| `password` | `string` | — | Authentication password |
| `username` | `string` | — | Redis ACL username |
| `database` | `number` | `0` | Database index (standalone/sentinel only) |
| `sentinelNodes` | `Array<{host, port}>` | — | Sentinel nodes |
| `sentinelMasterName` | `string` | — | Sentinel master name |
| `clusterNodes` | `Array<{host, port}>` | — | Cluster nodes |
| `maxRetries` | `number` | `3` | Max reconnect attempts |
| `retryDelay` | `number` | `1000` | Base reconnect delay (ms) |
| `connectionTimeout` | `number` | `5000` | Connect timeout (ms) |
| `defaultTTL` | `number` | `3600` | Default cache TTL (seconds) |
| `compressionThreshold` | `number` | `1024` | Cache compression threshold (bytes) |
| `slowCommandThreshold` | `number` | `1000` | Log commands slower than this (ms) |
| `tls` | `boolean` | `false` | Enable TLS (`tlsOptions` for CA/cert/key) |
| `maxFanOutConcurrency` | `number` | `8` | Max concurrent fan-out operations in cluster |
| `maxBatchSize` | `number` | `500` | Max batch size for SCAN operations |

Configurations are validated with Zod (`RedisConfigSchema`). See [mode-specific configs](#mode-configs) below.

### Mode-Specific Configurations

#### Standalone

```ts
const client = new RedisClientWrapper({
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
  password: 'secret',
  database: 0,
});

// Or with a URL:
const client = new RedisClientWrapper({ mode: 'standalone', url: 'redis://:secret@localhost:6379/0' });
```

#### Sentinel

```ts
const client = new RedisClientWrapper({
  mode: 'sentinel',
  sentinelNodes: [
    { host: 'sentinel1', port: 26379 },
    { host: 'sentinel2', port: 26380 },
  ],
  sentinelMasterName: 'mymaster',
  password: 'secret',
});
```

#### Cluster

```ts
const client = new RedisClientWrapper({
  mode: 'cluster',
  clusterNodes: [
    { host: 'redis1', port: 7000 },
    { host: 'redis2', port: 7001 },
    { host: 'redis3', port: 7002 },
  ],
  password: 'secret',
});
```

<a name="redisclient"></a>
## RedisClientWrapper — The Unified Client

The `RedisClientWrapper` is the core of the library. It automatically adapts to the configured topology (standalone, sentinel, or cluster) and lazily creates and shares sub-components: `cache`, `pubsub`, `lock`, `rateLimiter`, and `session`.

### Flow Diagram

```text
+--------------------+     +----------------------+     +---------------------+
|  RedisClientWrapper| --- |  Sub-components      | --- |  Redis (underlying) |
|  (config mode)     |     |  cache/pubsub/lock   |     |  ioredis client     |
+--------------------+     +----------------------+     +---------------------+
         ^                          ^                          |
         |                          |                          |
   lazy init                   lazy init                   lazy init
         |                          |                          |
   +-----v------+           +-----v-------+           +-----v-------+
   |  get cache |           |   get lock  |           |  get rateLimiter|
   +------------+           +-------------+           +---------------+
```

### Convenience Accessors

`RedisClientWrapper` lazily creates and shares one instance of each sub-component. Access them as properties — no manual wiring needed:

```ts
// Shared instances (created on first access)
client.cache;        // Cache
client.pubsub;       // PubSub
client.lock;         // DistributedLock
client.rateLimiter;  // RateLimiter

// Use them directly:
await client.cache.set('user:1', { name: 'alice' });
const ok = await client.lock.acquire('order:42');
const { allowed } = await client.rateLimiter.consume('/api', 'ip-1', { limit: 5, duration: 60 });

// Replace with custom instances:
client.cache = new Cache(client, { defaultTTL: 600 });
client.rateLimiter = new RateLimiter(client, { limit: 50, duration: 10 });
```

### Configuration

```ts
interface RedisClientOptions {
  config: RedisConfigInput;
  logger?: LoggerLike;
}
```

### Basic Commands

#### Strings & Keys

```ts
await client.set('name', 'alice');              // SET
await client.set('session', 'x', 3600);         // SET ... EX
await client.setexnx('job:1', 'w', 60);         // SET ... EX NX (only if missing)
await client.setnx('lock:1', 'owner', 30);      // SETNX + EXPIRE, returns 1|0
await client.get('name');                       // 'alice' | null
await client.getdel('queue:job');               // GETDEL
await client.exists('name');                    // 1 | 0
await client.del('a', 'b');                     // number deleted
await client.expire('session', 3600);           // set TTL
await client.ttl('session');                    // seconds left
await client.incr('visits');                    // counters
await client.decr('stock:sku-1');
```

#### Batch Operations (Cluster-Safe)

```ts
await client.mset(['user:1', 'alice'], ['user:2', 'bob']); // grouped by hash slot
const [a, b] = await client.mget('user:1', 'user:2');      // routed per slot
```

#### Hashes, Sets, Sorted Sets

```ts
await client.hset('user:1', 'name', 'alice');
await client.hget('user:1', 'name');
await client.hgetall('user:1');

await client.sadd('tags:1', 'redis', 'typescript');
await client.smembers('tags:1');
await client.sismember('tags:1', 'redis');
await client.srem('tags:1', 'redis');

await client.zadd('leaderboard', 100, 'p1');
await client.zrange('leaderboard', 0, 9);
await client.zrem('leaderboard', 'p1');
```

#### Scanning & Pipelines

```ts
// Scans every node in cluster mode
for await (const key of client.scanIterator('session:*')) {
  console.log(key);
}
await client.deletePattern('temp:*'); // delete by glob, cluster-safe

// Pipelines (cluster mode: keys must share a hash slot)
const pipeline = client.pipeline();
pipeline.set('a', '1');
pipeline.incr('b');
const results = await pipeline.exec();
```

#### Cluster Helpers

```ts
client.isCluster();                  // boolean
client.getClusterNodes();            // raw node clients
client.getClusterSlots();            // raw slot map
client.getSlotRanges();              // Map<slot, host:port[]>
client.calculateSlot('{user}:a');    // CRC16 slot, honors hash tags
await client.getNodeForKey('user:1');// node serving a key
await client.isKeyServed('user:1');  // slot is served
await client.executeOnNode('user:1', 'get', 'user:1'); // run on owning node
await client.mgetClusterAware([...]); // slot-grouped multi-get
client.getClusterInfo();             // topology snapshot
```

#### Lua Scripts (Atomic Server-Side Logic)

```ts
// EVAL: the first numKeys arguments are KEYS, everything else is ARGV.
// Cluster mode: every key touched inside the script must be declared in KEYS and share one hash slot.
const script = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;
await client.set('lock:job', 'owner-1');
await client.eval(script, 1, 'lock:job', 'owner-1'); // 1 (deleted)

// SCRIPT LOAD + EVALSHA: avoid re-sending the script body on every call.
// evalsha falls back to EVAL automatically when the server cache was flushed.
const sha = await client.scriptLoad(script);
await client.evalsha(sha, script, 1, 'lock:job', 'owner-2'); // 0 (not owner)
```

#### Convenience Accessors (Session, PubSub, Lock, Cache)

```ts
client.cache;        // shared Cache (created on first access)
client.pubsub;       // shared PubSub
client.lock;         // shared DistributedLock
client.rateLimiter;  // shared RateLimiter

// Session subsystem:
const { token, session } = await manager.service.create({ userId: 'user-42' });
const result = await manager.service.validate(token, { userId: 'user-42' });
```

### Lifecycle

```ts
await client.ping();            // boolean
await client.close();           // graceful QUIT
client.raw;                     // raw ioredis client
```

<a name="cache"></a>
## Cache

The `Cache` layer provides JSON serialization, optional gzip compression, namespaces, TTLs, hash helpers, and pattern-based cleanup. Works in all three modes.

### Class: Cache

```ts
constructor(client: RedisClientWrapper, config: CacheInputConfig, logger: LoggerLike = defaultLogger)
```

| Param | Type | Description |
|---|---|---|
| `client` | `RedisClientWrapper` | The underlying Redis client |
| `config` | `CacheInputConfig` | `defaultTTL` (seconds) and `compressionThreshold` (bytes) |
| `logger` | `LoggerLike` | Optional pino-compatible logger; defaults to `console` |

#### basic usage

```ts
const cache = new Cache(client, { defaultTTL: 3600, compressionThreshold: 1024 });

await cache.set('user:1', { name: 'alice' }, { ttl: 300 });
const user = await cache.get('user:1');

await cache.delete('user:1');
await cache.exists('user:1');
await cache.expire('user:1', 60);
await cache.ttl('user:1');
```

#### Namespaces

Values stored under a namespace are prefixed with `namespace:`, keeping keys isolated.

```ts
await cache.set('token', 'abc', { namespace: 'auth' });
await cache.get('token', 'auth');          // 'abc'
await cache.get('token');                  // null (no namespace)

await cache.clearNamespace('sessions');    // delete every 'sessions:*' key
await cache.keys('session:*');             // list keys (cluster-safe)
await cache.deletePattern('temp:*');       // delete by pattern
```

#### Atomic & Batch Operations

```ts
await cache.setNX('job:1', 'worker-1', { ttl: 60 });   // only if missing
await cache.setEXNX('lock:1', 'txn', { ttl: 30 });     // atomic with TTL

await cache.increment('stats:visits');                 // 1, 2, 3, ...
await cache.decrement('stock:sku-1');

await cache.mset({ 'user:1': alice, 'user:2': bob }, { ttl: 300 }); // slot-grouped
const [a, b] = await cache.mget(['user:1', 'user:2']);
```

#### Hash Helpers

```ts
await cache.hset('user:1', 'age', 30);
await cache.hget('user:1', 'age');       // 30
await cache.hgetall('user:1');           // { age: 30, ... }
```

#### Compression

Values larger than `compressionThreshold` bytes are gzip-compressed transparently. Set `compress: false` to disable compression for a single write.

```ts
await cache.set('large-data', bigBufferOrObject, { compress: false });
```

### Cache Interface — Method Documentation

| Method | Description | Args | Returns |
|---|---|---|---|
| `set(key, value, options?)` | Store a value in cache | `key: string`, `value: T`, `options: CacheOptions = {}` | `Promise<boolean>` — `true` when stored |
| `get(key, namespace?)` | Read a cached value | `key: string`, `namespace?: string` | `Promise<T \| null>` — parsed value or `null` |
| `setNX(key, value, options?)` | Store only if key does not exist | `key: string`, `value: T`, `options: CacheOptions = {}` | `Promise<boolean>` — `true` only when stored |
| `setEXNX(key, value, options?)` | Store atomically with TTL (SET ... EX NX) | `key: string`, `value: T`, `options: CacheOptions = {}` | `Promise<boolean>` — `true` only when stored |
| `mget(keys, namespace?)` | Read multiple keys (cluster-safe) | `keys: string[]`, `namespace?: string` | `Promise<(T \| null)[]>` — values in input order |
| `mset(entries, options?)` | Store multiple entries (cluster-safe, one pipeline per slot) | `entries: Record<string, T>`, `options: CacheOptions = {}` | `Promise<boolean>` — `true` when all stored |
| `delete(key, namespace?)` | Delete a cache key | `key: string`, `namespace?: string` | `Promise<boolean>` — `true` if key existed |
| `exists(key, namespace?)` | Check if key exists | `key: string`, `namespace?: string` | `Promise<boolean>` — `true` if key exists |
| `expire(key, ttl, namespace?)` | Set TTL on existing key | `key: string`, `ttl: number`, `namespace?: string` | `Promise<boolean>` — `true` if TTL applied |
| `ttl(key, namespace?)` | Get remaining TTL in seconds | `key: string`, `namespace?: string` | `Promise<number>` — seconds left (`-2` if missing, `-1` if no TTL) |
| `increment(key, by?, namespace?)` | Atomically increment counter | `key: string`, `by?: number` (default `1`), `namespace?: string` | `Promise<number>` — new counter value |
| `decrement(key, by?, namespace?)` | Atomically decrement counter | `key: string`, `by?: number` (default `1`), `namespace?: string` | `Promise<number>` — new counter value |
| `hget(key, field, namespace?)` | Read a hash field | `key: string`, `field: string`, `namespace?: string` | `Promise<T \| null>` — field value JSON-parsed or raw string |
| `hset(key, field, value, namespace?)` | Write a hash field | `key: string`, `field: string`, `value: any`, `namespace?: string` | `Promise<boolean>` — `true` if new field created |
| `hgetall(key, namespace?)` | Read all hash fields | `key: string`, `namespace?: string` | `Promise<Record<string, T>>` — field-value map JSON-parsed |
| `deletePattern(pattern, namespace?)` | Delete keys matching glob pattern (cluster-safe) | `pattern: string`, `namespace?: string` | `Promise<number>` — number of deleted keys |
| `keys(pattern, namespace?)` | List keys matching glob pattern (cluster-safe) | `pattern: string`, `namespace?: string` | `Promise<string[]>` — matching keys |
| `clearNamespace(namespace?)` | Delete every key inside a namespace | `namespace: string` | `Promise<number>` — number of deleted keys |

<a name="ratelimiter"></a>
## RateLimiter

Generic rate limiting for any resource — routes, API endpoints, users, IPs, API keys, database writes, email sends, webhooks...

### Algorithm Selection

| Algorithm | Key Type | Characteristics |
|---|---|---|
| `sliding` (default) | sorted set + atomic Lua | Smoothest; precise rolling window |
| `fixed` | counter (`INCR`/`EXPIRE`) | Cheapest; window resets at fixed boundaries |

```ts
// Sliding window (default)
const limiter = new RateLimiter(client, { limit: 100, duration: 60 });

// Fixed window
const fixed = new RateLimiter(client, { limit: 10, duration: 1, algorithm: 'fixed' });
```

### RateLimiter — Type Documentation

#### Class: RateLimiter

```ts
constructor(client: RedisClientWrapper, options: RateLimitOptionsInput = {}, logger: LoggerLike = defaultLogger)
```

| Param | Type | Default | Description |
|---|---|---|---|
| `client` | `RedisClientWrapper` | — | The underlying Redis client |
| `options.limit` | `number` | `100` | Maximum allowed requests within `duration` |
| `options.duration` | `number` | `60` | Window length in seconds |
| `options.algorithm` | `'fixed' \| 'sliding'` | `'sliding'` | Window algorithm |
| `options.namespace` | `string` | `'ratelimit'` | Redis key prefix |

#### RateLimitOptions type

```ts
interface RateLimitOptions {
  limit?: number;    // Max allowed requests within duration
  duration?: number; // Window length in seconds
  algorithm?: RateLimitAlgorithm; // 'fixed' | 'sliding'
  namespace?: string; // Key prefix
}
```

#### RateLimitResult type

```ts
interface RateLimitResult {
  allowed: boolean;    // request may proceed
  limit: number;       // configured max
  used: number;        // requests in current window
  remaining: number;   // left in the window (limit - used, floored at 0)
  resetAt: number;     // epoch ms when the window resets
  retryAfter: number;  // seconds to wait (0 when allowed)
}
```

#### RateLimitAlgorithm type

```ts
type RateLimitAlgorithm = 'fixed' | 'sliding';
```

### RateLimiter Methods

| Method | Description | Args | Returns |
|---|---|---|---|
| `consume(resource, identifier, options?)` | Consume one unit of capacity | `resource: string`, `identifier: string`, `options: RateLimitOptions = {}` | `Promise<RateLimitResult>` — limit state |
| `check(resource, identifier, options?)` | Peek at current limit state (no consumption) | `resource: string`, `identifier: string`, `options: RateLimitOptions = {}` | `Promise<RateLimitResult>` — current limit state |
| `reset(resource, identifier, namespace?)` | Reset counter, grant full capacity | `resource: string`, `identifier: string`, `namespace?: string` | `Promise<boolean>` — `true` if counter existed and was removed |
| `makeKey(resource, identifier, namespace?)` | Build the Redis key for a resource + identifier | `resource: string`, `identifier: string`, `namespace?: string` | `string` — e.g. `'ratelimit:/api/login:ip-10.0.0.1'` |

#### Private Methods (algorithmic)

| Method | Description |
|---|---|
| `consumeFixed(key, limit, duration)` | Fixed-window: `INCR`/`EXPIRE` based |
| `consumeSliding(key, limit, duration)` | Sliding-window: atomic Lua over sorted set |
| `checkFixed(key, limit, duration)` | Fixed-window peek |
| `checkSliding(key, limit, duration)` | Sliding-window peek |

<a name="lock"></a>
## DistributedLock

Atomic distributed mutual-exclusion lock backed by Redis. Works in standalone, sentinel, and cluster modes.

### Class: DistributedLock

```ts
constructor(client: RedisClientWrapper, logger: LoggerLike = defaultLogger, options: Partial<DistributedLockOptions> = {})
```

| Param | Type | Default | Description |
|---|---|---|---|
| `client` | `RedisClientWrapper` | — | The underlying Redis client |
| `logger` | `LoggerLike` | `defaultLogger` | Optional pino-compatible logger |
| `options.ttl` | `number` | `30000` | Lock TTL in milliseconds |
| `options.retryCount` | `number` | `3` | Number of acquisition attempts |
| `options.retryDelay` | `number` | `200` | Base delay between retries (ms), grows exponentially |

#### DistributedLockOptions type

```ts
type DistributedLockOptions = {
  ttl?: number;        // Lock TTL in milliseconds. Default: `30000`.
  retryCount?: number; // Number of acquisition attempts. Default: `3`.
  retryDelay?: number; // Base delay between retries in ms (grows exponentially). Default: `200`.
};
```

#### LockInfo type

```ts
type LockInfo = {
  locked: boolean;     // Whether the lock is currently held
  ttl?: number;        // Remaining TTL in seconds (when held and TTL set)
  lockId?: string;     // Unique owner id of the lock
};
```

### DistributedLock Methods

| Method | Description | Args | Returns |
|---|---|---|---|
| `acquire(key, ttl?)` | Attempt to acquire the lock | `key: string`, `ttl?: number` (ms) | `Promise<boolean>` — `true` when acquired |
| `release(key)` | Release the lock (owner-checked) | `key: string` | `Promise<boolean>` — `true` if released, `false` if not owned or missing |
| `releaseForce(key)` | Force-release without ownership check | `key: string` | `Promise<boolean>` — `true` if a lock existed and was deleted |
| `extend(key, ttl?)` | Extend the lock TTL (owner-checked) | `key: string`, `ttl?: number` (ms) | `Promise<boolean>` — `true` if extended |
| `isLocked(key)` | Check if lock is held | `key: string` | `Promise<boolean>` — `true` if lock exists |
| `getLockInfo(key)` | Get lock details | `key: string` | `Promise<LockInfo>` — `{ locked, ttl, lockId }` |
| `getLockOwner(key)` | Get the lock owner ID | `key: string` | `Promise<string \| null>` — lock id or `null` |
| `getLockTTL(key)` | Get remaining TTL in seconds | `key: string` | `Promise<number>` — seconds left (`0` when not held or expired) |
| `withLock(key, fn, options?)` | Acquire lock, run critical section, auto-extend, always release | `key: string`, `fn: () => Promise<T>`, `options: DistributedLockOptions = {}` | `Promise<T>` — return value of `fn` |
| `cleanupAll()` | Delete every lock key (`lock:*`) from Redis | — | `Promise<number>` — number of deleted locks |

<a name="pubsub"></a>
## Pub/Sub

Redis Pub/Sub with a dedicated publisher and subscriber connection. Messages are JSON-serialized on publish and auto-parsed on delivery. Extends `EventEmitter` and emits `'error'` on subscriber failures.

### Class: PubSub

```ts
constructor(publisher: RedisClientWrapper, logger: LoggerLike = defaultLogger)
```

| Param | Type | Description |
|---|---|---|
| `publisher` | `RedisClientWrapper` | A Redis client used for publishing |
| `logger` | `LoggerLike` | Optional pino-compatible logger; defaults to `console` |

### PubSub — Type Documentation

#### Event Map

| Event | Payload |
|---|---|
| `message` | `{ channel: string, message: string }` |
| `pmessage` | `{ pattern: string, channel: string, message: string }` |
| `subscribe` | `{ channel: string, count: number }` |
| `unsubscribe` | `{ channel: string, count: number }` |
| `psubscribe` | `{ pattern: string, count: number }` |
| `punsubscribe` | `{ pattern: string, count: number }` |
| `error` | `Error` |

### PubSub Methods

| Method | Description | Args | Returns |
|---|---|---|---|
| `connectSubscriber(config)` | Open a dedicated subscriber connection (idempotent) | `config: RedisConfig` | `Promise<void>` |
| `publish(channel, message)` | Publish a message to a channel | `channel: string`, `message: T` (string or JSON-serializable) | `Promise<number>` — number of subscribers that received the message |
| `subscribe(channel, handler)` | Subscribe a handler to a channel | `channel: string`, `handler: (data: T) => void` | `Promise<void>` |
| `unsubscribe(channel, handler?)` | Remove a handler (or all handlers) from a channel | `channel: string`, `handler?: (data: T) => void` | `Promise<void>` |
| `psubscribe(pattern, handler)` | Subscribe to all channels matching a glob pattern | `pattern: string`, `handler: (data: { channel: string; message: T }) => void` | `Promise<void>` |
| `punsubscribe(pattern, handler?)` | Remove a handler from a pattern subscription | `pattern: string`, `handler?: (data: any) => void` | `Promise<void>` |
| `close()` | Close the subscriber connection and clear all subscriptions | — | `Promise<void>` — closes subscriber only; publisher is not closed |
| `getStats()` | Return subscription statistics | — | `PubSubStats` — `{ subscriptions, patternSubscriptions, connected }` |

#### PubSubStats type

```ts
type PubSubStats = {
  subscriptions: number;
  patternSubscriptions: number;
  connected: boolean;
};
```

#### PubSubMessage type

```ts
type PubSubMessage<T = unknown> = {
  channel: string;
  message: T;
};
```

<a name="health"></a>
## HealthChecker

Periodic health monitoring with callbacks.

### Class: HealthChecker

```ts
constructor(client: RedisClientWrapper, logger: LoggerLike = defaultLogger)
```

| Param | Type | Description |
|---|---|---|
| `client` | `RedisClientWrapper` | The underlying Redis client |
| `logger` | `LoggerLike` | Optional pino-compatible logger; defaults to `console` |

### HealthChecker Methods

| Method | Description | Args | Returns |
|---|---|---|---|
| `start(interval?)` | Start periodic health checks | `interval?: number` (ms, default `10000`) | `void` |
| `stop()` | Stop the health checker | — | `void` |
| `check()` | Run a single health check (ping + latency) | — | `Promise<HealthStatus>` — current health status |
| `getStatus()` | Get the most recent health check result | — | `HealthStatus \| null` — last result (null before first check) |
| `onChange(callback)` | Register a callback for status changes | `callback: (status: HealthStatus) => void` | `void` |
| `waitForHealthy(timeout?)` | Wait until healthy (polling) | `timeout?: number` (ms, default `30000`) | `Promise<boolean>` — `true` if became healthy within timeout |

#### HealthStatus type

```ts
type HealthStatus = {
  healthy: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;        // ms
  timestamp: Date;
  details: {
    ping: boolean;
    connections?: number;
    memory?: string;
  };
};
```

<a name="session"></a>
## Session Subsystem

The production session stack (`createSessionManager`): validation with fail-closed semantics, rotation with retry-safe idempotency, throttled touches, idle/absolute expiry, per-user eviction ceilings, security versioning, optional AES-256-GCM encryption at rest, fail-closed circuit breaker, metrics and health. Cluster-safe by construction.

### Function: createSessionManager

```ts
createSessionManager(options: SessionManagerOptions): SessionManager
```

| Param | Type | Description |
|---|---|---|
| `options.client` | `RedisClientWrapper` | The underlying Redis client |
| `options.config` | `PartialSessionConfig` | Session configuration (see SessionConfig type) |
| `options.encryptionKeyProvider?` | `SessionKeyProvider` | REQUIRED when `config.encryption.enabled` is true |
| `options.revocationStore?` | `RevocationStore` | External revocation store (JWT jti denylists etc.) |
| `options.metricsAdapter?` | `SessionMetricsAdapter` | Metrics adapter (no-op without it) |
| `options.circuitBreaker?` | `SessionCircuitBreaker` | Optional circuit breaker |
| `options.now?` | `() => number` | Injectable clock for tests |

#### SessionManagerOptions type

```ts
type SessionManagerOptions = {
  client: RedisClientWrapper;
  config?: PartialSessionConfig;
  encryptionKeyProvider?: SessionKeyProvider;
  revocationStore?: RevocationStore;
  metricsAdapter?: SessionMetricsAdapter;
  circuitBreaker?: SessionCircuitBreaker;
  now?: () => number;
}
```

#### WithSessionManagerOptions type

```ts
type WithSessionManagerOptions = {
  config?: PartialSessionConfig;
  encryptionKeyProvider?: SessionKeyProvider;
  metricsAdapter?: SessionMetricsAdapter;
  now?: () => number;
}
```

### SessionManager class

```ts
new SessionManager(options: SessionManagerOptions)
```

Properties:
- `config: SessionConfig` — normalized configuration
- `service: SessionService` — the application-facing API
- `repository: SessionRepository` — low-level data access
- `metrics: SessionMetrics` — metrics tracking
- `circuitBreaker: SessionCircuitBreaker \| null` — circuit breaker (or null)
- `health: SessionHealthChecker` — health checking
- `cookies: SessionCookieManager` — cookie helpers
- `token: SessionTokenManager` — token generation/hashing
- `keys: SessionKeyStrategy` — key strategy for userId mapping

### SessionConfig type documentation

```ts
type SessionConfig = {
  enabled: boolean;              // Explicit opt-in; manager refuses to construct otherwise
  namespace: string;             // Key prefix (e.g. 'authcore')
  ttl: number;                   // Absolute session lifetime in seconds (default: 2592000 = 30d)
  idleTimeout: number | null;    // Rolling idle timeout in seconds (default: 86400 = 24h, null disables)
  rolling: boolean;              // touch extends the idle boundary (default: true)
  touchInterval: number;         // Minimum seconds between touch writes (default: 300)
  maxSessionsPerUser: number;    // Eviction ceiling, enforced atomically (default: 20)
  securityVersion: {              // Global per-user version; bump invalidates older sessions
    enabled: boolean;
  };
  encryption: {                  // AES-256-GCM envelopes
    enabled: boolean;
    encryptionKeyProvider: SessionKeyProvider;
  };
  jtiIndex: {                    // jti -> userId map so validate/touch/rotate work without userId
    enabled: boolean;
  };
  checkRevocationStore: boolean; // Consult revocation store during validation (default: false)
  bindingPolicy: 'disabled' | 'strict' | 'advisory'; // strict rejects on mismatch, advisory reports it
  circuitBreaker: {              // Circuit breaker config
    failureThreshold: number;    // default: 10
    resetTimeoutMs: number;      // default: 30_000
    halfOpenMaxRequests: number; // default: 5
  };
  enableCreateIdempotency: boolean; // Idempotent create() via idempotencyKey (default: false)
  retainConsumedTombstones: boolean; // Keep consumed records (TTL-bounded) for replay detection (default: true)
  limits: {                      // Hard limits
    maxMetadataSize: number;     // max size of metadata in bytes
    maxSessionsPerUserHardCap: number; // hard cap for listing sessions
  };
  health: {                      // Health check config
    // ...
  };
};
```

### Session Service Methods

| Method | Description | Args | Returns |
|---|---|---|---|
| `create(input)` | Create a session | `SessionCreateInput` | `Promise<CreatedSession>` — `{ token, session, replayed? }` |
| `validate(token, options?)` | Validate a session token | `token: string`, `options: ValidateOptions = {}` | `Promise<SessionValidationResult>` — `{ valid: true, session? }` or `{ valid: false, reason }` |
| `touch(token, options?)` | Refresh activity (throttled) | `token: string`, `options: TouchOptions = {}` | `Promise<TouchOutcome>` — outcome code |
| `rotate(token, options?)` | Rotate to a new session (idempotent via nonce) | `token: string`, `options: RotateOptions = {}` | `Promise<RotatedSession>` — `{ token?, session, replayed }` |
| `update(token, patch, options?)` | Patch update (optimistic concurrency) | `token: string`, `patch: SessionUpdatePatch`, `options: UpdateOptions = {}` | `Promise<SessionRecord>` |
| `destroy(token, options?)` | Physically delete a session (idempotent) | `token: string`, `options: { userId?: string } = {}` | `Promise<boolean>` |
| `revoke(token, options?)` | Logically revoke a session | `token: string`, `options: { userId?: string } = {}` | `Promise<string>` — outcome (`'revoked' \| 'already_revoked' \|\| 'not_found'`) |
| `revokeAll(userId)` | Revoke every session of a user | `userId: string` | `Promise<number>` — number revoked |
| `deleteByUser(userId)` | Delete every session of a user (physical) | `userId: string` | `Promise<string[]>` — deleted JTIs |
| `findByUser(userId, options?)` | List a user's sessions (oldest first) | `userId: string`, `options: ListOptions = {}` | `Promise<SessionRecord[]>` |
| `list(userId, options?)` | Alias of findByUser | `userId: string`, `options: ListOptions = {}` | `Promise<SessionRecord[]>` |
| `setSecurityVersion(userId, version?)` | Bump security version, invalidate old sessions | `userId: string`, `version?: number` | `Promise<number>` — new version |
| `getSecurityVersion(userId)` | Get current security version | `userId: string` | `Promise<number \| null>` |
| `health()` | Dependency health check | — | `Promise<ReturnType<SessionHealthChecker['check']>>` |

#### SessionCreateInput type

```ts
type SessionCreateInput = {
  userId: string;
  deviceId?: string;             // stored when config.storeDeviceId is true
  ipAddress?: string;            // stored when config.storeIpAddress is true
  userAgent?: string;            // stored when config.storeUserAgent is true
  metadata?: Record<string, unknown>; // bounded by config.maxMetadataSize
  idempotencyKey?: string;      // when provided + enableCreateIdempotency, enables idempotent create
};
```

#### CreatedSession type

```ts
type CreatedSession = {
  token: string;                 // The raw session token. Give to client; store nowhere.
  session: SessionRecord;        // The persisted session record (contains only jti, never the token)
  replayed?: boolean;            // True when create was an idempotent replay
};
```

#### SessionValidationResult type

```ts
type SessionValidationResult =
  | { valid: true; session: SessionRecord; binding?: BindingMismatch }
  | { valid: false; reason: SessionInvalidReason; session?: never };
```

#### SessionInvalidReason type

```ts
type SessionInvalidReason =
  | 'not_found'
  | 'expired'
  | 'idle_timeout'
  | 'absolute_timeout'
  | 'revoked'
  | 'invalid'
  | 'binding_mismatch';
```

#### TouchOutcome type

```ts
type TouchOutcome =
  | 'touched'
  | 'skipped_throttled'
  | 'skipped_stale'
  | 'not_found'
  | 'consumed'
  | 'expired'
  | 'idle_expired';
```

#### TouchOptions type

```ts
type TouchOptions = {
  force?: boolean;   // Force a write regardless of touchInterval
  userId?: string;   // When known, avoids JTI lookup index round trip
};
```

#### RotateOptions type

```ts
type RotateOptions = {
  rotationNonce?: string;  // Client-supplied random nonce for retry-safe rotation
  userId?: string;         // Skip pre-flight GET, let Lua script be authoritative
  expectedVersion?: number; // Optimistic concurrency: only rotate when version matches
};
```

#### UpdateOptions type

```ts
type UpdateOptions = {
  expectedVersion?: number; // Optimistic concurrency: only update when version matches
  userId?: string;          // When known, avoids JTI lookup index round trip
};
```

#### ListOptions type

```ts
type ListOptions = {
  limit?: number;           // Max sessions to return (default: 100)
  offset?: number;          // Skip first N sessions (oldest first)
  includeInactive?: boolean; // Include consumed/revoked records (default: false)
};
```

#### BindingMismatch type

```ts
type BindingMismatch = {
  ipAddress: boolean;     // IP address mismatch
  userAgent: boolean;     // User agent mismatch
  deviceId: boolean;      // Device ID mismatch
};
```

<a name="revocation"></a>
## RedisRevocationStore

Supports refresh-token revocation workflows: short-lived entries (`revoked:{jti}`) so rotated/logged-out tokens are rejected for their remaining lifetime. Framework-independent, works identically on standalone, Sentinel and Cluster, never stores raw tokens — only ids (`jti`).

### Class: RedisRevocationStore

```ts
new RedisRevocationStore(options: RedisRevocationStoreOptions)
```

| Param | Type | Description |
|---|---|---|
| `options.client` | `RedisClientWrapper` | The underlying Redis client |
| `options.keyPrefix` | `string` | Key prefix (e.g. `'authcore:revoked:'`) |

#### RedisRevocationStoreOptions type

```ts
interface RedisRevocationStoreOptions {
  client: RedisClientWrapper;
  keyPrefix: string;
}
```

### RedisRevocationStore Methods

| Method | Description | Args | Returns |
|---|---|---|---|
| `revoke(record)` | Revoke a single jti | `record: RevocationRecord` | `Promise<void>` |
| `revokeMany(records)` | Revoke multiple jtis (batch) | `records: RevocationRecord[]` | `Promise<void>` — throws `RevocationBatchError` on failure |
| `isRevoked(jti)` | Check if a single jti is revoked | `jti: string` | `Promise<boolean>` |
| `isRevokedMany(jtis)` | Check multiple jtis (batch) | `jtis: string[]` | `Promise<Set<string>>` — set of revoked jtis that were found; throws `RevocationBatchError` on partial failure |

#### RevocationRecord type

```ts
type RevocationRecord = {
  jti: string;            // The JWT jti (base64url-encoded SHA-256 of the token)
  expiresAt: number;      // Unix seconds after which this entry may be garbage collected
  reason?: string;        // e.g. 'logout', 'logout-all', 'password-change'
};
```

#### RevocationBatchError type

Thrown when a batched command fails (Redis error, timeout, ...). Carries the exact jtis that failed — a check can never silently treat a token as "not revoked" when its status is unknown.

<a name="lua-scripts"></a>
## Lua Scripts (`eval` / `evalsha`)

Atomic server-side logic. Cluster-safe when keys share a hash slot.

### Usage

```ts
// EVAL: the first numKeys arguments are KEYS, everything else is ARGV.
const script = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;
await client.set('lock:job', 'owner-1');
await client.eval(script, 1, 'lock:job', 'owner-1'); // 1 (deleted)

// SCRIPT LOAD + EVALSHA
const sha = await client.scriptLoad(script);
await client.evalsha(sha, script, 1, 'lock:job', 'owner-2'); // 0 (not owner)
```

### Key Rules

- **EVAL**: The first `numKeys` arguments are `KEYS`, everything else is `ARGV`.
- **Cluster mode**: Every key touched inside the script must be declared in `KEYS` and share one hash slot (honored via hash tags `{tag}:...`).
- **evalsha fallback**: If the script cache was flushed, `evalsha` automatically falls back to `EVAL`.

<a name="errors"></a>
## Errors

### RedisError

```ts
import { RedisError } from 'ioredis-toolkit';

try {
  await client.select(1);
} catch (error) {
  if (error instanceof RedisError && error.code === 'CLUSTER_MODE') {
    // SELECT is not available in cluster mode
  }
}
```

### Common Error Codes

| Code | When It Occurs |
|---|---|
| `CLUSTER_MODE` | Operations unavailable in cluster mode (e.g. `SELECT`) |
| `LOCK_ACQUISITION_FAILED` | Lock could not be acquired after retries |
| `LOCK_LOST` | Lock was lost during `withLock` execution |
| `SessionStorageError` | Infra failure (503) — only one that trips the circuit breaker |
| `SessionNotFoundError` | Session not found |
| `SessionExpiredError` | Session absolute TTL passed |
| `SessionInvalidError` | Session invalid (corrupt, cyclic metadata, etc.) |
| `SessionRevokedError` | Session explicitly revoked |
| `SessionRotationError` | Rotation failed (version conflict, successor collision, etc.) |
| `SessionConcurrencyError` | Optimistic concurrency violation (version mismatch) |
| `SessionSerializationError` | Session deserialization failed |
| `SessionConfigurationError` | Invalid session configuration |
| `SessionBindingError` | Binding policy mismatch (when strict) |

<a name="logging"></a>
## Logging

Every component accepts a pino-compatible logger (`trace/debug/info/warn/error/fatal` + `child`). Defaults to `console`.

```ts
import { createLogger } from 'pino';
const logger = createLogger();
const client = new RedisClientWrapper(config, logger);
```

<a name="mode-compatibility"></a>
## Mode Compatibility

| Operation | Standalone | Sentinel | Cluster |
|---|---|---|---|
| Single-key commands (get/set/hash/set/zset/incr/...) | ✅ | ✅ | ✅ |
| `mget` / `mset` / `mgetClusterAware` | ✅ | ✅ | ✅ slot-grouped |
| `scanIterator` / `deletePattern` / `keys` | ✅ | ✅ | ✅ all nodes scanned |
| Pipelines | ✅ | ✅ | ✅ (same-slot keys per pipeline) |
| Lua scripts (`eval` / `evalsha` / `scriptLoad`) | ✅ | ✅ | ✅ (keys declared in `KEYS`, one slot) |
| `RedisRevocationStore` | ✅ | ✅ | ✅ batch ops slot-grouped |
| `createSessionManager` | ✅ | ✅ | ✅ hash-tagged Lua scripts, slot-grouped fan-out |
| `select(database)` | ✅ | ✅ | ❌ (Redis limitation) |
| Hash-tag keys `{tag}:...` | ✅ | ✅ | ✅ same slot |

<a name="development"></a>
## Development

```bash
npm install          # install dependencies
npm run build        # tsc + asset copy (Lua scripts land in dist/session/scripts)
npm run typecheck    # src + test + scripts (tsconfig.test.json)
npm test             # vitest
npm run test:watch   # vitest watch mode
npm run format       # prettier --write 'src/**/*.ts'
```

The test suite covers the client, cache and rate limiter (including cluster-mode behavior) using in-memory fakes — no Redis server required. The session suites are gated: they run against real Redis (`localhost:6379`, or `REDIS_MODE=cluster` / `REDIS_MODE=sentinel` with the compose topologies in `test/infra/`) and skip cleanly when it is unreachable.

<a name="types"></a>
## Type Exports

The package exports comprehensive types for all modules. Key type exports:

### Core Client Types

| Type | Description |
|---|---|
| `RedisClientWrapper` | The unified client wrapper (standalone/sentinel/cluster) |
| `createRedisClient` | Factory function: `createRedisClient(config)` — creates client for specified mode |
| `RedisConfig` | Normalized Redis configuration (after Zod validation) |
| `RedisConfigInput` | User-facing configuration input (validated with Zod) |
| `RedisMode` | `'standalone' \| 'sentinel' \| 'cluster'` |
| `RedisConfigForMode<M>` | Mode-specific config type |

### Cache Types

| Type | Description |
|---|---|
| `Cache` | Cache layer with JSON serialization, TTL, namespaces, compression |
| `CacheOptions` | Options for cache operations (`ttl`, `compress`, `namespace`) |
| `CacheInputConfig` | Constructor config (`defaultTTL`, `compressionThreshold`) |

### Rate Limiting Types

| Type | Description |
|---|---|
| `RateLimiter` | Rate limiter instance |
| `RateLimitAlgorithm` | `'fixed' \| 'sliding'` |
| `RateLimitOptions` | Options with defaults materialized (limit, duration, algorithm, namespace) |
| `RateLimitResult` | Result of consume/check: allowed, limit, used, remaining, resetAt, retryAfter |

### Distributed Lock Types

| Type | Description |
|---|---|
| `DistributedLock` | Distributed lock instance |
| `DistributedLockOptions` | Constructor options (ttl, retryCount, retryDelay) |
| `LockInfo` | Lock info: `{ locked, ttl?, lockId? }` |

### Pub/Sub Types

| Type | Description |
|---|---|
| `PubSub` | Pub/sub instance |
| `PubSubMessage<T>` | `{ channel: string; message: T }` |
| `PubSubStats` | `{ subscriptions, patternSubscriptions, connected }` |

### Health Types

| Type | Description |
|---|---|
| `HealthStatus` | `{ healthy, status, latency, timestamp, details }` |

### Session Types

| Type | Description |
|---|---|
| `SessionManager` | Session manager composition root |
| `SessionService` | Application-facing session API |
| `SessionRecord` | Persisted session record |
| `SessionCreateInput` | Input for `create()` |
| `CreatedSession` | Result of `create()`: `{ token, session, replayed? }` |
| `SessionValidationResult` | Result of `validate()` |
| `SessionInvalidReason` | Invalid reason discriminant |
| `TouchOutcome` | Touch outcome codes |
| `RotateOptions` | Options for `rotate()` |
| `UpdateOptions` | Options for `update()` |
| `ListOptions` | Options for `findByUser`/`list()` |
| `BindingMismatch` | Binding mismatch details |
| `SessionStatus` | `'active' \| 'consumed' \| 'revoked'` |
| `SessionStatus` | Session lifecycle state |
| `RevocationRecord` | Revocation store record |
| `RevocationStore` | Storage-agnostic revocation interface |

### Configuration Types

| Type | Description |
|---|---|
| `RedisCommonConfig` | Common config shared by all topologies |
| `StandaloneRedisConfig` | Standalone-specific config |
| `SentinelRedisConfig` | Sentinel-specific config |
| `ClusterRedisConfig` | Cluster-specific config |
| `RedisConfigInputSchema` | Zod schema for config validation |
| `BaseRedisConfigSchema` | Base config schema (password, username, database, tls, etc.) |

### Utility Types

| Type | Description |
|---|---|
| `RedisError` | Base Redis error type |
| `calculateRedisClusterSlot` | CRC16 slot calculation for cluster keys |
| `hashTag` | Extract hash tag from key (`{tag}:key`) |

<a name="changelog"></a>
## Changelog

See [CHANGELOG.md](CHANGELOG.md) for recent changes.

---
*Generated with ioredis-toolkit v0.0.4*