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
| `defaultTtl` | `number` | `30` | Default lease in seconds. A positive integer. Must not exceed `maxTtl`. |
| `maxTtl` | `number` | `300` | Maximum permitted lease in seconds. A positive integer. |

The namespace must not overlap another enabled module's: two namespaces overlap when they are equal or one is a `:`-delimited prefix of the other (`app` and `app:locks`). `createRedisClient()` and `withLock()` throw `RedisConfigurationError` for an overlapping namespace.

`parseLockConfig()` rejects a configuration where `defaultTtl > maxTtl` at config-parse time, instead of letting every `acquire()`/`extend()` call using the default TTL throw later. It returns the normalized `LockConfig`, and throws `LockError` with code `LOCK_CONFIGURATION` for an invalid one. `RedisLock`, `parseLockConfig`, `LockError` and the types `LockConfig`, `LockAcquireResult` and `LockErrorCode` are exported from both `ioredis-toolkit` and `ioredis-toolkit/lock`.

## Methods

### `key(name)`

Builds the physical lock key.

```ts
redis.lock.key('order:123'); // myapp:locks:order:123
```

### `acquire(name, ttl?)`

Attempts an atomic `SET ... NX PX`. `ttl` is in seconds and may be fractional, down to whole milliseconds. Returns a `LockAcquireResult`, `{ acquired, token }`. The returned token proves ownership and must be treated as a secret. A token is returned even when `acquired` is `false`; it is a fresh one that owns nothing.

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

Deletes the lock only if the current Redis value equals the supplied ownership token. This prevents an expired lock from being deleted by a previous owner. Returns `true` when it deleted the lock and `false` when the token no longer owned it.

```ts
const lock = await redis.lock.acquire('invoice:42');
if (lock.acquired) await redis.lock.release('invoice:42', lock.token);
```

### `extend(name, token, ttl?)`

Atomically resets the lease to `ttl` seconds from now, only for the current owner. It does not add to the time left: extending a lock with 5 seconds left by 20 leaves 20. Returns `true` when the token still owned the lock and `false` otherwise.

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

If acquisition fails, `using()` throws a `LockError` with code `LOCK_HELD` instead of executing the callback. A TTL that `acquire()` would reject throws `LOCK_INPUT` or `LOCK_LIMIT` the same way, before anything is sent.

## Important semantics

This is a lease, not a consensus protocol. If the process pauses longer than the TTL, another owner may acquire the lock. Choose TTLs that safely cover the critical section and extend them when necessary.

The lock runs on a single Redis node: it is one key on the primary that owns it, not Redlock across independent nodes. Replication to replicas is asynchronous, so if the primary fails over before the lock key reaches a replica, the promoted replica does not hold it and a second caller can acquire the same lock while the first still believes it holds it. The first holder is not told until its next `extend()` or `release()` returns `false`, and `using()` does not report a `release()` that returns `false`. Until then two holders can exist, for up to the first holder's remaining lease when the TTL covers its work, as it should.

The old primary can also go on answering for a while after the promotion, and what it acknowledges then is lost: an `acquire()`, or an `extend()` that returns `true` although the promoted replica holds no key. On Sentinel, where the primary is the master, [Sentinel failover](../../DEPLOYMENT.md#sentinel-failover) says how long that window lasts. On Cluster, where it is the master that owns the key's slot, [Cluster failover](../../DEPLOYMENT.md#cluster-failover) says what is known of it.

A holder that must not overlap another for long can call `extend()` before each step that matters and stop when it returns `false`, as in the `extend()` example above. The overlap then lasts at most one step, plus the time the old primary goes on answering.

There is no fencing token. The ownership token `acquire()` returns is random, not monotonically increasing, so a resource cannot use it to reject writes from a holder whose lease has lapsed. Do not use the lock as proof that a database transaction committed. When an external resource requires strict stale-writer protection, issue fencing tokens from a store that guarantees them and have the resource check them.

## Errors

Every error this module raises itself is a `LockError`, which extends the package-wide `RedisToolkitError` and carries a stable `code`, typed `LockErrorCode`. A failure reported by Redis or the connection passes through as ioredis raised it.

| Code | Thrown when |
|---|---|
| `LOCK_CONFIGURATION` | the lock configuration is invalid |
| `LOCK_INPUT` | `acquire()`, `extend()` or `using()` is given a TTL that is not a finite positive number (including `NaN`), or is not a whole number of milliseconds (such as `0.0001`), checked before anything is sent |
| `LOCK_LIMIT` | `acquire()`, `extend()` or `using()` is given a TTL longer than `maxTtl` |
| `LOCK_HELD` | `using()` finds the lock already held |

## Overrides

```ts
redis.withLock({ defaultTtl: 10, maxTtl: 60 });
redis.withLock({ enabled: true, namespace: 'maintenance' }, 'replace');
```

`'replace'` resets every option it is not given to its default, `enabled: false` included, so pass `enabled: true` or `redis.lock` throws `RedisConfigurationError` afterwards. `withlock()` is an alias of `withLock()`.
