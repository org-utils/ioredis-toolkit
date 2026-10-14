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
| `enabled` | `boolean` | `false` | Enables the module. `redis.lock` throws `RedisConfigurationError` while disabled. |
| `namespace` | `string` | `lock` | Namespace: the first segment of every lock key. Letters, digits, `:`, `_` and `-` only, at most 128 characters. |
| `defaultTtl` | `number` | `30` | Default lease in seconds. Must not exceed `maxTtl`. |
| `maxTtl` | `number` | `300` | Maximum permitted lease. |

`parseLockConfig()` rejects a configuration where `defaultTtl > maxTtl` at config-parse time, instead of letting every `acquire()`/`extend()` call using the default TTL throw later.

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

Acquires a lock, executes the callback, and releases the lock afterwards. The callback receives the ownership token so it can extend the lease.

`using()` resolves with the callback's result, or rejects with the callback's error, even if releasing the lock fails. A failed release is reported to the client's `onError` hook with source `lock-release` instead of replacing the outcome, and the lock then lapses at the end of its TTL.

```ts
const result = await redis.lock.using('report:daily', async token => {
  // token is available if the job needs an extension.
  return await generateReport();
}, 60);
```

If acquisition fails, `using()` throws a `LockError` with code `LOCK_HELD` instead of executing the callback.

## Important semantics

This is a lease, not a consensus protocol. If the process pauses longer than the TTL, another owner may acquire the lock. Choose TTLs that safely cover the critical section and extend them when necessary.

The lock runs on a single Redis node: it is one key on the primary that owns it, not Redlock across independent nodes. Replication to replicas is asynchronous, so if the primary fails over before the lock key reaches a replica, the promoted replica does not hold it and a second caller can acquire the same lock while the first still believes it holds it. For that brief window two holders can exist.

There is no fencing token. The ownership token `acquire()` returns is random, not monotonically increasing, so a resource cannot use it to reject writes from a holder whose lease has lapsed. Do not use the lock as proof that a database transaction committed. When an external resource requires strict stale-writer protection, issue fencing tokens from a store that guarantees them and have the resource check them.

## Errors

Every error this module raises itself is a `LockError`, which extends the package-wide `RedisToolkitError` and carries a stable `code`. A failure reported by Redis or the connection passes through as ioredis raised it.

| Code | Thrown when |
|---|---|
| `LOCK_CONFIGURATION` | the lock configuration is invalid |
| `LOCK_INPUT` | `acquire()` or `extend()` is given a TTL that is not a finite positive number (including `NaN`), or is not a whole number of milliseconds (such as `0.0001`), checked before anything is sent |
| `LOCK_LIMIT` | `acquire()` or `extend()` is given a TTL longer than `maxTtl` |
| `LOCK_HELD` | `using()` finds the lock already held |

## Overrides

```ts
redis.withLock({ defaultTtl: 10, maxTtl: 60 });
redis.withLock({ namespace: 'maintenance' }, 'replace');
```
