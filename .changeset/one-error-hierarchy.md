---
"ioredis-toolkit": patch
---

Every error the package raises itself now extends one base, `RedisToolkitError`, and carries a stable machine-readable `code`, so a consumer can catch package errors at one boundary and branch on the failure kind without matching message text.

`SessionError` (and its subclasses), `CacheError` and `RedisConfigurationError` now extend `RedisToolkitError`. A failure reported by Redis or the connection still passes through the convenience wrappers as ioredis raised it. `LockError`, `RateLimitError`, `PubSubError` and `StreamsError` are new, with a code union exported beside each class (`CacheErrorCode`, `LockErrorCode`, `RateLimitErrorCode`, `PubSubErrorCode`, `StreamsErrorCode`). `RedisConfigurationError` reports `REDIS_CONFIGURATION`.

Breaking: conditions that threw a built-in or validation-library error now throw the module's typed error. All of them still extend `Error`, but `instanceof RangeError`, `instanceof TypeError` and `instanceof ZodError` checks no longer match.

- `cache.set()`: `nx` with `xx`, or an invalid `ttl`, was `RangeError`, now `CacheError` `CACHE_INPUT`; a value JSON cannot encode was `TypeError`, now `CACHE_SERIALIZATION`; a value over `maxValueBytes` was `RangeError`, now `CACHE_LIMIT`
- `lock.acquire()` / `lock.extend()`: a TTL out of bounds was `RangeError`, now `LockError` `LOCK_INPUT` (not positive) or `LOCK_LIMIT` (over `maxTtl`)
- `lock.using()`: a lock already held was `Error`, now `LockError` `LOCK_HELD`
- `rateLimiter.consume()`: an invalid cost was `RangeError`, now `RateLimitError` `RATE_LIMIT_INPUT`
- `pubsub.publish()`: a value JSON cannot encode was `TypeError`, now `PubSubError` `PUBSUB_SERIALIZATION`; a message over `maxMessageBytes` was `RangeError`, now `PUBSUB_LIMIT`
- `streams.read()`: a `group` without a `consumer` was `RangeError`, now `StreamsError` `STREAMS_INPUT`
- `parseCacheConfig`, `parseLockConfig`, `parseRateLimitConfig`, `parsePubSubConfig`, `parseStreamsConfig`, and so `createRedisClient` and the `with*()` overrides: an invalid configuration was `ZodError`, now the module's error with code `CACHE_CONFIGURATION`, `LOCK_CONFIGURATION`, `RATE_LIMIT_CONFIGURATION`, `PUBSUB_CONFIGURATION` or `STREAMS_CONFIGURATION`. The message lists each issue as `path: message`; the `issues` array is gone
- `serializeCookie()` / `serializeDeletionCookie()`: an invalid cookie name, or `SameSite=None` without `Secure`, was `Error`, now `SessionInputError` `SESSION_INPUT`

Breaking: `new CacheError(message)` is now `new CacheError(code, message)`.
