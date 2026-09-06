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
| `enabled` | `boolean` | `false` | Enables the module. `redis.rateLimiter` throws `RedisConfigurationError` while disabled; `new RedisRateLimiter(...)` remains directly constructible either way. |
| `namespace` | `string` | `rate-limit` | Counter key prefix. |
| `windowSeconds` | `number` | `60` | Fixed-window duration. |
| `maxRequests` | `number` | `100` | Maximum units per window. |

## Methods

### `key(subject, nowSeconds?)`

Returns the counter key for the current fixed window. Supplying `nowSeconds` makes tests deterministic.

```ts
redis.rateLimiter.key('user:42', 120); // rate-limit:user:42:2 for a 60s window
```

### `consume(subject, cost?, nowSeconds?)`

Atomically increments the current window and creates its TTL on the first increment.

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

### `check(subject, nowSeconds?)`

Reads the current counter without incrementing it.

```ts
const state = await redis.rateLimiter.check('user:42');
console.log(state.remaining, state.resetAt);
```

`check()` is advisory. A concurrent `consume()` can change the result immediately afterward.

### `reset(subject, nowSeconds?)`

Deletes the current window counter.

```ts
await redis.rateLimiter.reset('user:42');
```

## Result type

`RateLimitResult` contains:

- `allowed`: whether the operation fits within the limit.
- `limit`: configured maximum.
- `remaining`: remaining units, never below zero.
- `resetAt`: estimated Unix timestamp when the current window expires.
- `retryAfterSeconds`: TTL to wait when denied, otherwise `0`.
- `count`: current consumed units.

## Fixed-window behavior

A fixed window can allow bursts at a boundary. For example, a request near the end of one window and another immediately after the boundary count against different windows. If smoother traffic shaping is required, use a different algorithm rather than assuming this module is a sliding-window limiter.

## Overrides

```ts
redis.withRateLimit({ maxRequests: 500 });
redis.withRateLimit({ namespace: 'login' }, 'replace');
```
