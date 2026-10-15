# Changelog

## 1.1.2

### Patch Changes

- f9f1ff4: The minimum versions of the package's dependencies rise to ioredis 5.11.1 and zod 4.6.7.

## 1.1.1

### Patch Changes

- ecd5153: The README names Node.js as the only supported runtime and warns that under Bun before 1.4 some connections can wait forever (#101).

## 1.1.0

### Minor Changes

- 97dfdc0: `RedisClient` gains `health()`, a health check for readiness and liveness probes (#98). It sends a `PING` with a timeout of its own (`timeoutMs`, default 1000), so it answers in time even while Redis is down, where a plain `ping()` stays queued through ioredis's reconnect retries. A Redis failure resolves as `unhealthy` with the reason in `error`, never as a rejection, and a round trip slower than `degradedMs` (default 100) is `degraded`. On Cluster every master is pinged, and each is reported in `nodes`; the cluster is `unhealthy` when any master is. Its types, `RedisHealth`, `RedisHealthOptions`, `RedisHealthStatus` and `RedisNodeHealth`, are exported from the root. The internal `SessionHealthProvider`, unreachable from the public surface since 1.0.1, is removed.

## 1.0.11

### Patch Changes

- 834f814: The published guides now match the code. The `'replace'` override examples pass `enabled: true`, since `'replace'` resets every option it is not given, `enabled` included. The session `create()` examples pass the `securityVersion` their setup requires, and the cache `get()` example compiles under `strict`. The session error table, the state diagram, `list()` and `rotate()` describe what the code does. The README states which session failures are wrapped as `SESSION_STORAGE`, which error each misconfiguration throws, and the namespace-overlap rule, and shows Sentinel and Cluster connections. The capacity guide counts the security-version key and the consumed and revoked records kept after use. TESTING.md lists the suites that exist and the ones still to be written.
- 1dbfaf7: `streams.read()` no longer throws a `TypeError` when a consumer-group read of the pending list re-delivers an entry deleted from the stream since it was delivered (#89). The entry comes back with its `id` and empty `fields`, so the consumer can still `ack()` it and clear it from the pending list.

## 1.0.10

### Patch Changes

- 88e4436: The published package no longer carries `docs/adr/`. The architecture decision records are for the repository's maintainers and stay in the repository. The two published guides that cite ADR-0002 now link to it on GitHub.

## 1.0.9

### Patch Changes

- 7701c36: `revoke()` of a consumed credential no longer loses to a rotation of its successor that is running at the same time (#83).
  
  - If rotation consumed the session at the end of the chain between `revoke()`'s read and its write, the revocation overwrote the consumed record. That erased its replay signal and its link, and the session that rotation created stayed active. The revocation now goes on to end that successor, and then puts back what it replaced.
  - **Behaviour change:** if the revocation reaches a link whose successor the rotation has not created yet, it writes a revoked tombstone in that successor's place. The rotation then throws `SessionRotationError` instead of leaving an active session behind after the logout. A `rotate()` that runs at the same time as a logout can therefore now fail with `SessionRotationError`, its credential consumed.
  - The revocation write stays unconditional, so concurrent touches still cannot hold a revocation off.
- 1f32b8b: `revoke()` given a credential that rotation already consumed now ends its successor, the session that replaced it, so a user logging out with a stale cookie is logged out (#81).
  
  - It follows the rotation chain from successor to successor and revokes the session at its end, if that one is still active.
  - **Behaviour change:** the consumed credential itself is left as it is. It keeps validating as `consumed`, and `rotate()` on it keeps throwing `SessionReplayError`. Before, `revoke()` rewrote it as `revoked`, which hid the replay signal and restarted its tombstone's 300-second cap.
  - Replay on its own still ends no session. To end every session of a user on `SessionReplayError`, call `revokeAll()` or bump the security version.
  - A consumed session's record now holds `successorId` and `successorJti`, linking it to its successor. Sessions consumed by an earlier release have no link, so revoking their credential ends nothing.

## 1.0.8

### Patch Changes

- 247b33d: A user's stored security version now expires once none of their sessions can use it, instead of staying in Redis forever.
  
  - It lives as long as the user's longest-lived session. `create()`, and rotation, extend its TTL to the user's session set's and never shorten it.
  - `setSecurityVersion()` gives it a TTL of the longer of the user's longest-lived session and the configured session `ttl`. Before, it also removed any TTL the key had.
  - Validation is unchanged: a missing version still fails closed, but it can now only go missing once the user has no session left to validate.
  - **Behaviour change:** once the version has expired, the next `create()` stores the version it is given, as for a new user. After a bump, a user who has had no session for longer than the session `ttl` can therefore be given a session with the previous version. Pass the user's current version to `create()`.
  - A version written by an earlier release, without a TTL, is given one at that user's next `create()` or `setSecurityVersion()`. Users who never return keep theirs until then.

## 1.0.7

### Patch Changes

- 1acfd2a: A `RedisPubSub` constructed directly, without the client facade and without a reporter, no longer crashes the process. Its subscriber-connection errors, handlers that throw and messages that are not JSON were passed to a reporter that was `undefined`, which threw from the connection's `'error'` listener. They are now dropped, as `RedisLock` and `RedisStreams` already do without a reporter.
- 5af2c75: The rate limiter's scripts touch only the key they declare. Each subject's windows were counted under a key the script built itself from the declared one (`rate-limit:{user:42}:<window>`), which worked on Redis and Redis Cluster only because the hash tag kept it in the same slot, and is outside Redis's scripting contract. Servers and proxies that enforce declared keys rejected or misrouted it.
  
  - **The counter key layout changes again.** A subject now has one key, `rate-limit:{user:42}`: a hash holding the number of the window it counts and that window's count. A new window starts the count again. `consume()` and `check()` are still one round trip, and `reset()` is now one instead of two. Windows in progress during an upgrade start again from zero once; keys written by earlier versions are not read again and expire at the end of their window.
  - **`key(subject)` returns the subject's key.** `key(subject, serverSeconds)` is deprecated: the second argument is still accepted and has no effect.

## 1.0.6

### Patch Changes

- c1f07eb: Fixes to what the #44 audit fixes left uncovered: connections opened after `close()`, the session factory's validation, and security versions.
  
  - After `client.close()`, the client opens no further connection. A Pub/Sub subscribe or a blocking stream read afterwards rejects with the `Connection is closed.` error ioredis gives a command on a closed connection, whenever the module was first used. Before, a module first used after the close opened a connection that nothing closed, which kept the process alive. The Pub/Sub subscriber connection is now opened by the first `subscribe()` rather than when the module is first accessed, so a client that only publishes opens none.
  - `createSessionManagerFromRedis()` validates both configurations before it connects. **A mistyped `mode`, which it used to accept and connect as standalone, now throws `RedisConfigurationError` at startup.** Disabled sessions, and encryption without a key manager (which this factory cannot take), still throw `SessionConfigurationError`, but no longer leave a connection open.
  - `create()` throws `SessionInvalidError` (`SESSION_INVALID`) for a `securityVersion` that is not a whole number of at least 0, as `setSecurityVersion()` already did, whether or not `securityVersionEnabled` is on, since the version is stored in the session either way. Before, a value such as `-1` or `NaN` became the user's stored version and could not be overwritten by a later `create()`, and `1.5` wrote a session that could not be read back.
- 49914a8: A smaller tarball, and the documented limits of the lock and of rolling sessions.
  
  - The published package no longer carries `docs/agents/` or `docs/ACCEPTANCE-REPORT.md`, which are for the repository's maintainers.
  - The lock guide now states that the lock runs on a single Redis node, so a failover can briefly allow two holders, and that it issues no fencing token.
  - The sessions guide now states that `rolling` extends only the idle expiry, never the hard `ttl`.

## 1.0.5

### Patch Changes

- 99151eb: `lock.using()` now always resolves with the callback's result, or rejects with the callback's error, even when releasing the lock fails. Before, a release failure, such as a Redis blip after the work had finished, replaced the real outcome. The release failure now goes to the `onError` hook with source `lock-release`, and the lock lapses at the end of its TTL.
  
  `acquire()` and `extend()` reject more bad TTLs with `LockError` code `LOCK_INPUT`, before contacting Redis: `NaN`, which used to reach Redis as `PX NaN`; `Infinity`, which used to report `LOCK_LIMIT`; and any TTL that is not a whole number of milliseconds, such as `0.0001`. `LOCK_LIMIT` and `LOCK_HELD` behave as before.
- 2354be7: Pub/Sub handlers can no longer crash the process, and subscription state survives failures and reconfiguration.
  
  - Each handler call is isolated. A handler that throws, an async handler that rejects, or a received message that is not valid JSON is reported to the `onError` hook with source `pubsub-handler` and the logical `channel`, and the other handlers on the channel still run. Before, a throwing handler raised inside ioredis's event handler, and a rejecting one was an unhandled rejection; either could end the process. A non-JSON message, which was silently dropped, is now reported as a `PubSubError` with code `PUBSUB_SERIALIZATION`.
  - Concurrent `subscribe()` calls to one channel share one Redis subscription, and each resolves only once Redis has confirmed it. Before, every call after the first resolved at once and could miss the first messages.
  - A failed `subscribe()` removes the handler it registered, so a later `subscribe()` to the channel tries again. Before, the channel stayed dead for every later subscriber.
  - `withPubSub()` throws `PubSubError` with the new code `PUBSUB_STATE` while the current subscriber has live subscriptions, instead of silently dropping them. Unsubscribe first, then reconfigure. `PubSubErrorCode` gains `'PUBSUB_STATE'`; an exhaustive `switch` over it needs the new case.
- e84224e: Fixes to the previous release's stream readers, `revokeAll()` and multi-key deletes.
  
  - After `streams.close()`, a blocking `read()` now rejects. Before, it ran on the client's shared connection, which `streams.close()` leaves open, so it could stall every other command again. `RedisClient.close()` behaves as before.
  - `revokeAll()` throws `SessionStorageError` again when deleting the token locators fails, as it did before the Cluster fix, so a retry revokes the same batch. The locators are now deleted before the records.
  - A multi-key delete on standalone Redis, such as `cache.delete(...keys)`, now sends `DEL`s of at most 500 keys instead of one unbounded `DEL`.

## 1.0.4

### Patch Changes

- 3750167: A blocking stream read no longer stalls the rest of the client. `streams.read()` used to block on the one shared connection, so every session check, cache read, lock and rate-limit call waited behind it for up to `blockMs`, and forever with `blockMs: 0`. Each read now leases a connection of its own from a pool of duplicates that the Streams module grows on demand, and returns it afterwards. Concurrent reads on different streams wait side by side instead of queueing. `blockMs: 0` still means "wait indefinitely", now without freezing anything else.
  
  `RedisClient.close()` disconnects the reader connections, so a read still waiting rejects at once. Errors on reader connections reach the `onError` hook with source `stream-reader`.
  
  `streams.add()` with no fields now throws `StreamsError` with code `STREAMS_INPUT` without contacting Redis, instead of failing with a Redis argument error.
- 4d8190e: `revokeAll()` works on Redis Cluster. Before, it failed every time there, because it sent one pipeline mixing the user's session records with their token locators, which live in other hash slots. The records are now deleted in one step in the user's slot, and the token locators afterwards through the cluster-aware delete. The `{ affected, remaining }` result, the `maxBatchSize` bound and the user-ID validation are unchanged.
- 8fcc3bc: A user at `maxSessionsPerUser` can sign in on Redis Cluster again. The creation script used to delete the evicted session's token locator, which lives in another hash slot, so on Cluster every login over the limit failed, after already logging the user out of one other device. The script now deletes only the evicted session's record, which shares the user's slot, and the token locator is deleted afterwards as best-effort cleanup. An evicted credential validates as `not_found` even if that cleanup fails.
  
  A `create()` never evicts the session it is creating. Before, with `maxSessionsPerUser: 1`, two logins in the same second could evict the new session and still report success.
  
  Each user's session set now expires with the longest-lived session in it, instead of living forever. A shorter-lived session never shortens it. A set written by an earlier version without an expiry is given one, at the next `create()` for that user, that outlives every session it already holds. The comparison is made in Lua, so Redis 6 keeps working.
- 6b9bf1f: `cache.clear()` now works on a namespace of any size. It deletes each page of matching keys as the scan returns it, in `DEL`s of at most 500 keys, grouped by hash slot on Cluster. Before, it collected every matching key first, then threw a `RangeError` or sent one enormous `DEL` once the keyspace was large enough. On a Cluster client created just before the call, it also returned `0` and deleted nothing, because the client did not yet know its masters. The count it returns is now exact on Cluster, where concurrent deletes could undercount before.
  
  `cache.delete()` with no keys now returns `0` without contacting Redis, instead of failing with a Redis argument error.
  
  Cluster-aware behaviour now recognises a Cluster connection by ioredis's own `isCluster` marker instead of `instanceof`. An application that resolves a second copy of ioredis, and passes its `Cluster` to `new RedisClient()`, no longer has cross-slot deletes and reads silently treated as standalone.
- 696b9b8: `validate()`, and so `get()`, `touch()`, `update()` and `rotate()`, checks a credential in two round trips to Redis, down from four or five: the token locator, then one script in the user's hash slot that reads the session record, its membership in the user's session set, the security version and Redis server time together. `touch()` writes from that same read instead of reading the record and the time again. Because the record and its membership are read at one instant, a losing concurrent `rotate()` of one credential is now always refused with `SessionReplayError`; on Redis Cluster it could before be refused with `SessionInvalidError`. Validation reasons and errors are otherwise unchanged.

## 1.0.3

### Patch Changes

- 2dee613: Rotating or revoking a session no longer leaves its token locator alive for the rest of the original session lifetime. The token locator is the key that maps a credential to its user. Its TTL is now cut to that of the session's tombstone: the rest of the session's lifetime, capped at 300 seconds. While the tombstone lasts, a replayed credential is still reported as `consumed` and a revoked one as `revoked`. After that, both report `not_found` and neither key remains. Frequent rotation no longer leaves thousands of dead keys per active user.
- c6c3d81: Rate-limit windows now always expire, and the times the limiter reports are exact.
  
  - A window's counter expires when the window ends, whatever the cost of its first request. Before, a window whose first request cost more than 1 never expired.
  - `resetAt` is the window's end, `(window + 1) × windowSeconds` in Redis server time. `retryAfterSeconds` is the time from now until that end when a request is denied, and `0` otherwise. Before, both could overstate the wait by up to 2×. `check()` reports the same boundaries as `consume()`.
  - `consume()` and `check()` read Redis server time inside their script, so each is one round trip instead of two (three for `check()`).
  
  **The counter key layout changes.** The subject is now the key's Redis Cluster hash tag: `rate-limit:{user:42}:2` instead of `rate-limit:user:42:2`. All of a subject's windows share one hash slot, which is what lets one script read the clock and pick the window on Cluster. `key(subject, serverSeconds)` returns the new form. Windows in progress during an upgrade start again from zero once, and counters written by earlier versions are not read again. A subject that is empty or starts with `}` would leave the hash tag empty, so it now throws `RateLimitError` with `RATE_LIMIT_INPUT`.
  
  The rate-limit docs now state that requests near a window boundary can briefly reach up to twice the limit, and that denied requests still count against the window.
- 2e49d3c: Enabling `securityVersionEnabled` no longer rejects every session until the application has written a security version for each user. When no version is stored for a user, `create()` stores the `securityVersion` it is given, set only if absent, in the same step that writes the session. `create()` never overwrites a stored version, so sessions from before a `setSecurityVersion()` bump stay invalid. Validation still fails closed whenever the stored version is missing. The sessions docs describe the behaviour.
- f9726c8: The session `cookie` configuration is now used. `SessionManager` gains `cookie(token, session)`, which resolves to a `Set-Cookie` value with the configured name, domain, path, `HttpOnly`, `Secure` and `SameSite` attributes, and `deletionCookie()`, which returns the expired cookie that removes it. Unless `cookie.maxAge` is set, `Max-Age` is what the session has left before its hard expiry, measured in Redis server time.
  
  `serializeCookie()` now rejects a `Domain` or `Path` containing `;`, a control character or whitespace by throwing `SessionInputError`, so an input-derived value can no longer end the attribute early or inject attributes of its own.
  
  `circuitBreaker` is deprecated and has no effect. The package has never had a circuit breaker. The setting is still accepted, so existing configuration keeps parsing, and is marked `@deprecated` in the type declarations. It will be removed in the next major version.
- 4577626: **`touch()` no longer increments a session's `version`.** `version` now counts only the changes an application can see: `update()` and status changes such as rotation and revocation. Code that expected a touch to bump `version` must change. In return, a background touch no longer makes an `update()` that carries the version read before it fail.
  
  A version mismatch in `update()` now always throws `SessionConflictError` (code `SESSION_CONFLICT`). Before, a writer that lost the race at the store got `SessionStorageError` instead. The patch is applied to the record as stored when it is written, so a touch that landed in between is kept.
  
  `update()` now follows the same rules as `create()` for client details. `ipAddress`, `userAgent` and `deviceId` are stored only when `storeIpAddress`, `storeUserAgent` and `storeDeviceId` are on, and are otherwise ignored. They are capped at 128, 1024 and 256 characters, and a longer value throws `SessionInvalidError`. Before, `update()` stored them whatever the flags said, with no length limit.
- 2cc6e40: A session record that cannot be decoded is now reported and never deleted. Before, if the key manager briefly lacked an old key version, or encryption was switched off by mistake, every session that failed to decode was deleted the next time it was validated or listed. That amounted to a mass logout. Now validating such a session throws `SessionSerializationError` and leaves the record exactly as stored, so restoring the configuration makes the session valid again. `list()` leaves undecodable records out of the page without removing them from the user's session set. It still removes members whose record is missing.
  
  `list()` also leaves out sessions past any of their expiries (hard, idle or absolute), measured in Redis server time, so it shows only sessions that can still authenticate. Before, idle-expired sessions were listed.
- 5a01294: `createRedisClient()` now validates the connection configuration before it connects, with `parseRedisConnectionConfig`. A mistyped `mode` throws `RedisConfigurationError` instead of silently connecting as standalone. Cluster startup nodes are accepted in every form ioredis takes: `host:port` strings, bare ports, and addresses.
  
  The client facade now rejects, with `RedisConfigurationError`, any configuration where two enabled modules share a namespace, or where one namespace is a colon-delimited prefix of another (`app` and `app:cache`, but not `app` and `application`). The check runs when the client is created, before it connects, and again on every `with*()` call. A `with*()` call that would cause a collision throws and leaves the previous configuration in effect. Disabled modules are not checked.
  
  **This can make a previously accepted configuration fail at startup.** For example, a cache sharing its namespace with sessions used to be accepted, and `cache.clear()` would then delete every session. Give each enabled module a namespace of its own.

## 1.0.2

### Patch Changes

- 531263c: The client can now be shut down, and its connection errors observed. `RedisClient.close()` closes every connection the client opened: the shared connection and, if Pub/Sub was used, the subscriber connection. A connection that is up is quit, so commands already sent complete; one that is not is disconnected. `close()` is idempotent, and safe whichever modules were used. `RedisPubSub.close()` is idempotent too, and the `redis` that `createSessionManagerFromRedis` returns now has a `close()` of its own.
  
  `RedisClientDependencies` gains `onError(error, context)`. Each connection the client opens keeps its default `'error'` listener, so an unobserved error still never crashes the process, and that listener now forwards to the hook with a context naming the source: `connection` or `subscriber`. On Cluster, errors on the connection to each node are reported under the same source. A hook that throws or rejects is contained. The context types are public as `RedisErrorContext` and `RedisErrorSource`.

## 1.0.1

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
