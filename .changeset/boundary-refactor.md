---
"ioredis-toolkit": major
---

This release redraws the package's boundary: one kernel under every module, a facade-only public surface, and Redis server time for everything shared across processes. Imports and configuration written against 0.0.14 break. This entry lists every public name that is gone and every config field that is renamed, and names the two fixes a consumer will notice; the entries under Patch Changes describe each change in full.

Breaking: these names are no longer exported from the root, and no subpath exports them.

- `SessionService`, `SessionRepository`, `SessionSerializer`, `SessionKeyStrategy`, `SessionTokenManager`, `SessionScriptRegistry`
- `RedisClientWrapper`
- `NoopMetrics`, `SessionHealthProvider`, `SessionHealth`
- `RedisRevocationStore`
- `RedisConnectionConfigSchema`, `SessionConfigSchema`, `CacheConfigSchema`, `LockConfigSchema`, `RateLimitConfigSchema`, `PubSubConfigSchema`, `StreamsConfigSchema`
- `redisHashSlot`, `safeUserTag`, `assertSameSlot`

Take modules from `createRedisClient` and a session manager from `createSessionManager` or `createSessionManagerFromRedis`, and validate configuration with the `parse*Config` functions. Nothing else is removed: every other name 0.0.14 exported from the root is still exported from it.

Breaking: one subpath is renamed, with no alias.

- `ioredis-toolkit/sessions` is now `ioredis-toolkit/session`

Breaking: two config fields are renamed, with no alias.

- `pubsub.channelPrefix` is now `pubsub.namespace`
- `streams.keyPrefix` is now `streams.namespace`

An old field name is ignored rather than rejected, so a config that still passes one silently reads and writes under the default namespace. Rename both before deploying.

Fixed: two defects a consumer could see.

- Rate limiting holds across application servers whose clocks disagree. Windows were bucketed by each server's own clock, so two servers with skewed clocks counted the same subject in different windows and the configured limit did not hold. Windows are now bucketed by Redis server time.
- `CookieOptions` and `InvalidReason` are exported, from the root and from `ioredis-toolkit/session`. Both were types a consumer could receive (the options `serializeCookie` takes, the `reason` of a failed `validate()`) but could not name in an annotation.

Also breaking, with no name removed: constructing a module class directly is no longer supported; conditions that threw `RangeError`, `TypeError`, `ZodError` or a bare `Error` now throw the module's typed error, and `CacheError` takes a code before its message; `RedisRateLimiter.consume`, `check` and `reset` no longer take `nowSeconds`, and `key()` requires its time argument; and the namespace of every convenience wrapper must match `[A-Za-z0-9:_-]{1,128}`.
