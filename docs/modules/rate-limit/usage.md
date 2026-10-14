# Rate Limiting Module — Complete Usage Guide

`RedisRateLimiter` implements an atomic fixed-window counter. It is suitable for request, API-key, user, IP, job, or other subject-based quotas.

## Setup

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,
  rateLimit: {
    enabled: true,
    namespace: 'api:limit',
    windowSeconds: 60,
    maxRequests: 100,
  },
});
```

`rateLimit.enabled` defaults to `false`. Accessing `redis.rateLimiter` while disabled throws `RedisConfigurationError`; set `enabled: true` to use the module.

## Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `enabled` | `boolean` | `false` | Enables the module. `redis.rateLimiter` throws `RedisConfigurationError` while disabled. |
| `namespace` | `string` | `rate-limit` | Namespace: the first segment of every counter key. Letters, digits, `:`, `_` and `-` only, at most 128 characters. |
| `windowSeconds` | `number` | `60` | Fixed-window duration. |
| `maxRequests` | `number` | `100` | Maximum units per window. |

## Methods

### `key(subject)`

Returns the key that counts the subject's current window. Each subject has one key: a hash holding the number of the window it counts and that window's count. When a new window starts, the next `consume()` starts the count again from its own cost, and `check()` reads the window as empty.

```ts
redis.rateLimiter.key('user:42'); // rate-limit:{user:42}
```

The subject is the key's Redis Cluster hash tag. A subject must not be empty or start with `}`; such a subject throws `RATE_LIMIT_INPUT`.

`key(subject, serverSeconds)` is deprecated: earlier versions gave every window a key of its own, and the second argument named the window. It is still accepted and has no effect.

### `consume(subject, cost?)`

Atomically adds `cost` to the current window, in one round trip. Whatever the cost, a window's counter expires when the window ends.

```ts
const decision = await redis.rateLimiter.consume('user:42');
if (!decision.allowed) {
  throw new Error(`Rate limited; retry in ${decision.retryAfterSeconds}s`);
}
```

Weighted costs are useful for expensive operations:

```ts
const decision = await redis.rateLimiter.consume('user:42', 5);
```

### `check(subject)`

Reads the current counter without incrementing it.

```ts
const state = await redis.rateLimiter.check('user:42');
console.log(state.remaining, state.resetAt);
```

`check()` is advisory. A concurrent `consume()` can change the result immediately afterward.

### `reset(subject)`

Deletes the subject's key, which resets the current window, in one round trip.

```ts
await redis.rateLimiter.reset('user:42');
```

## Result type

`RateLimitResult` contains:

- `allowed`: whether the operation fits within the limit.
- `limit`: configured maximum.
- `remaining`: remaining units, never below zero.
- `resetAt`: Unix timestamp, in Redis server time, at which the current window ends: `(window + 1) × windowSeconds`.
- `retryAfterSeconds`: when denied, seconds from now until the window ends; otherwise `0`.

`check()` and `consume()` report the same `resetAt` for the same subject and window.
- `count`: current consumed units.

## Clock

Windows are bucketed by Redis server time, never the application server's clock, so every host places a subject in the same window however far its own clock has drifted. `consume` and `check` read the server clock inside the script that does the work, so each is one round trip; `reset` needs no clock, since a subject's windows share one key. None of them accepts a caller-supplied time. On Redis Cluster the clock is that of the node holding the subject's hash slot, so the nodes' own clocks must be kept in sync. See [ADR-0002](../../adr/0002-redis-server-time-is-authoritative.md).

## Fixed-window behavior

A fixed window can allow bursts at a boundary. Requests just before a window ends and just after it count against different windows, so for a brief time around a boundary a subject can reach up to twice `maxRequests`. If smoother traffic shaping is required, use a different algorithm rather than assuming this module is a sliding-window limiter.

Denied requests still count against the window: `consume()` adds its cost whether or not the result is `allowed`. A client that keeps retrying while denied keeps the count above the limit, but can never extend the window, which ends on schedule.

## Errors

Every error this module raises itself is a `RateLimitError`, which extends the package-wide `RedisToolkitError` and carries a stable `code`. A failure reported by Redis or the connection passes through as ioredis raised it.

| Code | Thrown when |
|---|---|
| `RATE_LIMIT_CONFIGURATION` | the rate-limit configuration is invalid |
| `RATE_LIMIT_INPUT` | `consume()` is given a cost that is not a positive integer, or a method is given a subject that is empty or starts with `}` |

A denied request is not an error: `consume()` returns `allowed: false`.

## Overrides

```ts
redis.withRateLimit({ maxRequests: 500 });
redis.withRateLimit({ namespace: 'login' }, 'replace');
```
