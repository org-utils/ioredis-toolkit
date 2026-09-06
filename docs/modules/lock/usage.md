# Lock Module — Complete Usage Guide

`RedisLock` provides a small distributed-lock primitive based on a random ownership token and atomic compare-and-delete/compare-and-expire Lua operations.

## Setup

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,
  lock: { enabled: true, namespace: 'myapp:locks', defaultTtl: 30, maxTtl: 300 },
});
```

`lock.enabled` defaults to `false`. Accessing `redis.lock` while disabled throws `RedisConfigurationError`; set `enabled: true` to use the module.

## Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `enabled` | `boolean` | `false` | Enables the module. `redis.lock` throws `RedisConfigurationError` while disabled; `new RedisLock(...)` remains directly constructible either way. |
| `namespace` | `string` | `lock` | Physical key prefix. |
| `defaultTtl` | `number` | `30` | Default lease in seconds. Must not exceed `maxTtl`. |
| `maxTtl` | `number` | `300` | Maximum permitted lease. |

`parseLockConfig()` rejects a configuration where `defaultTtl > maxTtl` at config-parse time, instead of letting every `acquire()`/`extend()` call using the default TTL throw a `RangeError` later.

## Methods

### `key(name)`

Builds the physical lock key.

```ts
redis.lock.key('order:123'); // lock:order:123
```

### `acquire(name, ttl?)`

Attempts an atomic `SET ... NX PX`. The returned token proves ownership and must be treated as a secret.

```ts
const result = await redis.lock.acquire('order:123', 15);
if (!result.acquired) {
  return; // another worker owns it
}
try {
  await processOrder();
} finally {
  await redis.lock.release('order:123', result.token);
}
```

### `release(name, token)`

Deletes the lock only if the current Redis value equals the supplied ownership token. This prevents an expired lock from being deleted by a previous owner.

```ts
const lock = await redis.lock.acquire('invoice:42');
if (lock.acquired) await redis.lock.release('invoice:42', lock.token);
```

### `extend(name, token, ttl?)`

Atomically extends the lease only for the current owner.

```ts
const lock = await redis.lock.acquire('long-job', 20);
if (lock.acquired) {
  await doFirstPart();
  const extended = await redis.lock.extend('long-job', lock.token, 20);
  if (!extended) throw new Error('Lock ownership was lost');
  await doSecondPart();
  await redis.lock.release('long-job', lock.token);
}
```

### `using(name, fn, ttl?)`

Acquires a lock, executes the callback, and releases the lock in `finally`. The callback receives the ownership token so it can extend the lease.

```ts
const result = await redis.lock.using('report:daily', async token => {
  // token is available if the job needs an extension.
  return await generateReport();
}, 60);
```

If acquisition fails, `using()` throws instead of executing the callback.

## Important semantics

This is a lease, not a consensus protocol. If the process pauses longer than the TTL, another owner may acquire the lock. Choose TTLs that safely cover the critical section and extend them when necessary.

Do not use the lock as proof that a database transaction committed. Prefer fencing tokens when an external resource requires strict stale-writer protection.

## Overrides

```ts
redis.withLock({ defaultTtl: 10, maxTtl: 60 });
redis.withLock({ namespace: 'maintenance' }, 'replace');
```
