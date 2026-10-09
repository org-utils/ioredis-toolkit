# Changelog

## 0.1.0

### Major Changes

- e397dd2: This release redraws the package's boundary: one kernel under every module, a facade-only public surface, and Redis server time for everything shared across processes. Imports and configuration written against 0.0.14 break. This entry lists every public name that is gone and every config field that is renamed, and names the two fixes a consumer will notice; the entries under Patch Changes describe each change in full.
  
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

### Patch Changes

- daff038: Encrypted sessions can now be touched, updated, rotated and revoked. With `sessions.encryption.enabled: true` all four failed every time with `SessionStorageError: Redis script execution failed`, because the Lua scripts behind them tried to decode the encrypted record. A default-configured application that touches the session on each request failed on every request once encryption was on.
  
  The record is now read, changed and re-encrypted by the application. `touch`, `update` and `rotate` write it through a script only if the stored value has not changed in the meantime; `revoke` writes unconditionally, so concurrent writers cannot hold a revocation off. An encrypted record stays encrypted through every operation and is re-encrypted under the current key on each write, and a record stored before encryption was switched on becomes encrypted the next time it is written. The stored envelope is unchanged, so existing plain and encrypted sessions read back as before.
  
  What else changes:
  
  - Each of the four operations reads the record once more before writing.
  - `touch`, `update` or `rotate` that loses to concurrent writers on the same session 32 times in a row fails with `SessionStorageError` and leaves the record as it was.
  - Simultaneous touches of one session at the same instant no longer each raise its `version`; the ones that lose the write find the expiry already extended and write nothing.
  - The `touch_session`, `consume_session`, `revoke_session` and `update_session` scripts are gone from `SessionScriptRegistry`, replaced by `replace_session`.
- 76e35ce: The public surface is now facade-only: the module classes, their configuration, input and result types, the error hierarchy and its code unions, the factory functions and the `parse*Config` functions. Every class the client facade constructs on your behalf is internal, so it can be restructured without breaking you.
  
  Breaking: these names are no longer exported from the root, and no subpath exports them.
  
  - The session internals: `SessionService`, `SessionRepository`, `SessionSerializer`, `SessionKeyStrategy`, `SessionTokenManager`, `SessionScriptRegistry`
  - `RedisClientWrapper`, the raw Redis command wrapper. `RedisClient` still carries the same commands, and `RedisCommandClient` names them in a type annotation
  - `NoopMetrics` and `SessionHealthProvider`, with its result type `SessionHealth`. Leaving `metrics` out still records nothing
  - `RedisRevocationStore`. It could only be built from the session key strategy, which is now internal
  - Every validation schema object: `RedisConnectionConfigSchema`, `SessionConfigSchema`, `CacheConfigSchema`, `LockConfigSchema`, `RateLimitConfigSchema`, `PubSubConfigSchema`, `StreamsConfigSchema`. Validate with `parseRedisConnectionConfig`, `parseSessionConfig`, `parseCacheConfig`, `parseLockConfig`, `parseRateLimitConfig`, `parsePubSubConfig` and `parseStreamsConfig`, which apply the same rules and defaults
  - The cluster hash-slot helpers: `redisHashSlot`, `safeUserTag`, `assertSameSlot`
  
  Breaking: constructing a module class directly (`new RedisCache(wrapper, config)`) is no longer supported. Take modules from `createRedisClient`, or a session manager from `createSessionManager` or `createSessionManagerFromRedis`.
  
  No behaviour changes: sessions and the convenience wrappers do what they did.
- 0629f1e: Every module now has one entry point, and each subpath exports its class together with the types that go with it. A subpath used to export one class and no types, so the config you pass a module and the results it returns could only be named by importing from the root as well.
  
  - `ioredis-toolkit/cache`, `/lock`, `/rate-limit`, `/pubsub` and `/streams` each export the module class, its `parse*Config` function, its error class and code union, and its config, input and result types
  - `ioredis-toolkit/session` exports `SessionManager`, `createSessionManager`, `createSessionManagerFromRedis`, `parseSessionConfig`, the cookie helpers, every `Session*Error`, and the session types. It also exports `RedisConfig`, so the subpath can construct what it returns without the root import
  
  Breaking: the session subpath is renamed to match its module, with no alias.
  
  - `ioredis-toolkit/sessions` is now `ioredis-toolkit/session`
  
  Fixed: types a consumer could receive but not name are now exported.
  
  - `CookieOptions` (the options `serializeCookie` takes) and `InvalidReason` (the `reason` of a failed `validate()`), from the root and from `ioredis-toolkit/session`
  - `StandaloneRedisConfig`, `SentinelRedisConfig` and `ClusterRedisConfig` (the members of `RedisConfig`), from the root
  - `ModuleConfigBase` (the `enabled` and `namespace` fields every module config shares), from the root
  - `RedisPipeline` and `ClusterFanoutOptions` (what the client's `pipeline()` returns and its cluster-aware commands take), from the root
  
  This change removes nothing from the root import, and changes no behaviour.
- 0fa375f: Every error the package raises itself now extends one base, `RedisToolkitError`, and carries a stable machine-readable `code`, so a consumer can catch package errors at one boundary and branch on the failure kind without matching message text.
  
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
- 6c4c350: Every module now takes its namespace from one `namespace` field and builds its keys through one key strategy, so a namespace behaves the same in cache, lock, rate limiting, Pub/Sub, streams and sessions.
  
  Breaking: two config fields are renamed, with no alias.
  
  - `streams.keyPrefix` is now `streams.namespace`
  - `pubsub.channelPrefix` is now `pubsub.namespace`
  
  An old field name is ignored rather than rejected, so a config that still passes one falls back to the default namespace (`stream`, `events`) and reads and writes different keys and channels. Rename the field when upgrading.
  
  Breaking: the namespace of `cache`, `lock`, `rateLimit`, `pubsub` and `streams` must now match `[A-Za-z0-9:_-]{1,128}`, the rule sessions already applied. A namespace carrying a hash tag or a glob character is rejected, because it would decide the Cluster hash slot of every key under it or widen `cache.clear()` into other namespaces.
- 9a97cc0: Rate limiting now buckets windows by Redis server time instead of the application server's clock. Previously two hosts with skewed clocks placed the same subject in different windows, so the configured limit silently failed to hold across them.
  
  Breaking: `RedisRateLimiter.consume`, `check` and `reset` no longer accept a `nowSeconds` argument, and `key()` now requires its time argument instead of defaulting to the local clock. `resetAt` is now reported in Redis server time. Each call reads the server clock first, which costs one extra round trip.
- 163d50a: Lock and rate-limit calls now run their Lua by cached SHA. `lock.release()`, `lock.extend()` and `rateLimiter.consume()` used to send the whole script body on every call; they now send its SHA-1, and send the source again only when the server answers `NOSCRIPT` (first use, a restart, a failover, `SCRIPT FLUSH`).
  
  Sessions already worked this way. The registry that does it now lives in the kernel and all three modules share it. No behaviour changes: results and errors are what they were.

## 0.0.14

### Patch Changes

- 45523b0: `SessionRepository.consume()` now throws `SessionReplayError` (instead of a generic `SessionRotationError`) when the atomic `consume_session` script reports the predecessor was already consumed. This closes a race in `SessionService.rotate()`: the pre-check against `current.status` and the atomic consume happen at different times, so a concurrent rotation racing to consume the same predecessor could previously surface as an unclassified `SessionRotationError` instead of the replay-detection error callers rely on to trigger security response.

## 0.0.13

### Patch Changes

- 09c266a: resolve bug

## 0.0.12

### Patch Changes

- e218550: Removed lua scripts

## 0.0.11

### Patch Changes

- bafbd94: Bump changes

## 0.5.0

### Fixed

- `dist/` is now actually rebuilt as ESM matching `package.json`'s `"type": "module"` and `exports` conditions; the previously committed artifacts were stale CommonJS output. CI now fails if a fresh build doesn't match the committed `dist/`.
- Every Redis connection (including the Pub/Sub subscriber connection) now attaches a default `'error'` listener so a connection failure can no longer crash the process with an uncaught exception.
- Session creation now deletes the actual session and token-index keys for sessions evicted by `maxSessionsPerUser`, instead of only removing them from the user index (which previously left orphaned Redis keys behind). `revoke()` and rotation's `consume()` now also remove the session from the user index immediately instead of relying on lazy self-healing during `list()`.
- `circuitBreaker` session configuration now has a default, matching every other nested config section; omitting it no longer throws.
- `RedisClient`'s `cache`, `lock`, `rateLimiter`, `pubsub`, and `streams` getters now throw when the corresponding module is disabled, matching the session module's existing behavior. Previously `enabled: false` had no effect on these four modules.
- `RedisRevocationStore.revoke()` now takes an explicit `now` parameter (sourced from the same clock as the rest of the session subsystem, e.g. `redis.time()`) instead of using `Date.now()` internally, fixing a clock-skew risk for consumers using it directly. It remains an intentionally standalone utility for JTI-based external credentials (see `docs/README-API.md`) and is not wired into `SessionService`, which treats session state itself as the source of truth.
- `RedisClientConfig` and `RedisClientDependencies` are now exported from the package entry point.
- `RedisPubSub`'s message handler and `RedisCache.get()` no longer crash on a malformed/non-JSON payload; the cache now throws a typed `CacheError` and Pub/Sub silently drops the malformed message.
- Fixed the standalone `src/scripts/*.lua` reference copies that had drifted from the scripts actually executed at runtime (`src/session/script-sources.ts`), and marked each file with the authoritative source it must stay in sync with.
- `RedisStreams.read()` now throws a clear `RangeError` when `group` is supplied without `consumer` instead of silently falling back to a plain, incorrectly-cursored `XREAD`; it also now honors the configured default `blockMs` instead of only blocking when every caller passes it explicitly.
- Session rotation and idle-timeout touch now preserve the originally configured per-session idle-timeout duration instead of re-deriving it from mutable state, which could silently shrink the idle window across repeated rotations.
- Fixed a `StandaloneRedisConfig.mode`/`RedisConnectionConfigSchema` mismatch where the type declared `mode` optional but the schema required the literal, and moved `parseRedisConnectionConfig`'s error type off the session module (`RedisConfigurationError` replaces `SessionConfigurationError` here).
- Cookie names are no longer `encodeURIComponent`-escaped after validation, which previously could silently change several RFC 6265-legal cookie-name characters.
- CI now installs with `bun install --frozen-lockfile` (matching the committed `bun.lock`) instead of `npm install`.

### Changed

- Cache/lock/pubsub/rate-limit/streams `enabled: false` is now enforced (see above) — a **breaking change** for any code that accessed these modules through `RedisClient` while relying on the previous, unintended permissive default.

## 0.4.0

- Corrected TypeScript/ESM interoperability in the Pub/Sub module by using type-only Redis imports.
- Audited the public source graph for strict TypeScript compatibility.
- Regenerated package distribution artifacts.
- Retained complete per-module `usage.md` documentation with method arguments, return values, types, examples, errors, and operational guidance.
- Added a type-safety verification note documenting that dependency-backed compilation must be run with the package dependencies installed.

0.3.0

### Added

- Complete Cache module usage guide.
- Complete Lock module usage guide.
- Complete Rate Limiting module usage guide.
- Complete Pub/Sub module usage guide.
- Complete Streams module usage guide.
- Complete Sessions module usage guide.
- Detailed method/type JSDoc across public modules.
- Unified configuration examples for all modules.
- Fluent merge/replace module configuration documentation.

### Correctness and typing improvements

- Added `mget()` to the shared Redis command abstraction.
- Added explicit Pub/Sub callback types.
- Added cache NX/XX mutual-exclusion validation.
- Added cache TTL validation.
- Added JSON serialization validation for Pub/Sub values.
- Added rate-limit timestamp validation.
- Improved Redis configuration validation typing.
- Regenerated distribution JavaScript and declarations from the current source.

### Documentation

- Root README now documents the complete multi-module configuration model.
- Module READMEs now link to dedicated `usage.md` guides.
- Acceptance report records environment limitations instead of claiming unavailable dependency-backed checks passed.

## 0.2.0

Initial multi-module release.
