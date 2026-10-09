---
"ioredis-toolkit": patch
---

The public surface is now facade-only: the module classes, their configuration, input and result types, the error hierarchy and its code unions, the factory functions and the `parse*Config` functions. Every class the client facade constructs on your behalf is internal, so it can be restructured without breaking you.

Breaking: these names are no longer exported from the root, and no subpath exports them.

- The session internals: `SessionService`, `SessionRepository`, `SessionSerializer`, `SessionKeyStrategy`, `SessionTokenManager`, `SessionScriptRegistry`
- `RedisClientWrapper`, the raw Redis command wrapper. `RedisClient` still carries the same commands, and `RedisCommandClient` names them in a type annotation
- `NoopMetrics` and `SessionHealthProvider`, with its result type `SessionHealth`. Leaving `metrics` out still records nothing
- `RedisRevocationStore`. It could only be built from the session key strategy, which is now internal
- Every validation schema object: `RedisConnectionConfigSchema`, `SessionConfigSchema`, `CacheConfigSchema`, `LockConfigSchema`, `RateLimitConfigSchema`, `PubSubConfigSchema`, `StreamsConfigSchema`. Validate with `parseRedisConnectionConfig`, `parseSessionConfig`, `parseCacheConfig`, `parseLockConfig`, `parseRateLimitConfig`, `parsePubSubConfig` and `parseStreamsConfig`, which apply the same rules and defaults
- The cluster hash-slot helpers: `redisHashSlot`, `safeUserTag`, `assertSameSlot`

Breaking: constructing a module class directly (`new RedisCache(wrapper, config)`) is no longer supported. Take modules from `createRedisClient`, or a session manager from `createSessionManager` or `createSessionManagerFromRedis`.

No behaviour changes: sessions and the convenience wrappers do what they did.
