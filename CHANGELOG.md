# Changelog

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
