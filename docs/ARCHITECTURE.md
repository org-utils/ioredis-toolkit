# Architecture

An overview of how the package is built and why. The individual decisions are recorded as ADRs in [`docs/adr/`](https://github.com/org-utils/ioredis-toolkit/tree/main/docs/adr), which are kept in the repository and not shipped in the npm package.

## Decision: create the package and Redis infrastructure from scratch

The supplied specification described an existing Redis package, but this project started without one. Therefore the implementation owns the Redis connection factory, wrapper, cluster utilities, configuration validation, session domain, and public exports. No duplicate external authentication/core package is assumed.

## Decision: opaque token + token locator

A token-only `validate(token)` operation requires a token locator. The package uses SHA-256(token) as the lookup key and stores only the derived hash plus a user hash-tag pointer. The actual session record remains authoritative.

This is a deliberate consistency boundary: the token locator lives in a different slot from the record. A missing or stale token locator never authenticates anything.

## Decision: per-user Cluster hash tag

Session keys are shaped as:

`<namespace>:session:{<sha256(userId)>}:<sha256(token)>`

The user hash is deterministic and safe for Redis hash-tag syntax. It keeps one user's session records and session set in one slot while distributing different users across slots.

## Decision: no global JTI index

JTI is an internal session identifier and is not needed to validate the opaque token. A global JTI index would add another cross-slot consistency boundary without improving the core validation path.

## Decision: the user's session set as a negative authorization guard

The user's session set is checked during validation. It can deny access but cannot grant access: the session record must independently pass all checks. The record and its membership are read in one script in the user's slot, so validation never sees a session as it stood before a concurrent rotation or revocation alongside its membership as it stood after.

Max-session enforcement (`create_session`) and revocation (`revoke()`, and rotation's `consume()`) all remove their affected member from the user's session set eagerly. `create_session` additionally deletes the evicted session's record, which shares the user's slot, and returns the evicted token hashes. The repository then deletes their token locators, which live in other slots, through the kernel's cluster-aware delete as best-effort cleanup. An evicted session is unusable even if that cleanup fails, because its record is gone; a leftover locator resolves to a missing record, reads as not found, and is deleted then. The script never evicts the session it has just added, even when `createdAt` scores tie.

The user's session set lives as long as its longest-lived session: `create_session` extends its TTL to at least the new session's, comparing in Lua rather than with `EXPIRE GT` so Redis 6 keeps working. A set written by an earlier version without a TTL is given one that outlives every record it holds. Stale members are still pruned lazily by `list()` and by eviction.

The user's security version lives as long as that set, so it is present whenever a session it is checked against can still validate. `create_session` extends its TTL to the set's and never shortens it; a version written by an earlier version without a TTL is given the set's. `setSecurityVersion()` writes it, in the same slot, with a TTL of the longer of the set's and the configured session `ttl`, so that a `create()` already under way with the previous version still meets the new one. While the set has no TTL, neither has the version.

## Decision: rotation is two-phase

A predecessor is consumed atomically. A successor is created separately because the token-hash key is unrelated to the predecessor's key slot. This can produce a safe availability failure after consumption, but cannot produce two valid successors.

ioredis sends a command again when the connection closes before its reply arrives, so a step whose reply was lost runs twice. Each step of a rotation recognises its own first run: consuming a predecessor already consumed for this rotation's successor, and storing a successor already stored, both succeed. A retry by the application is another rotation, and finds the predecessor consumed. [Commands sent twice](./DEPLOYMENT.md#commands-sent-twice) lists what a second run does across the package.

## Decision: server time

Redis TIME is used for authentication/session timestamps to reduce application-clock ordering problems. TTLs remain Redis storage cleanup boundaries; application expiration fields remain authoritative for session validity.

The same clock buckets rate-limit windows. The session service outside validation reads it through the kernel's `RedisClock`. Validation reads `TIME` inside the same-slot script that reads the record, and the rate limiter inside each of its scripts, which is the same server time at no extra round trip; [ADR-0002](https://github.com/org-utils/ioredis-toolkit/blob/main/docs/adr/0002-redis-server-time-is-authoritative.md) records the rule and the one exception, local timing of a duration inside a single process.

## Decision: bounded maintenance

No request path scans the entire cluster or performs unbounded Lua loops. Batch/list/revoke-all calls are capped by configuration.

## Decision: no built-in circuit breaker

The low-level Redis client already owns connection/reconnect behavior. A circuit breaker in this first package would add another failure-state machine without changing the required fail-closed authentication semantics. Applications may wrap the package with an operation-class breaker if their deployment needs one.

`SessionConfig.circuitBreaker` is deprecated and has no effect: nothing reads it. It is still accepted and validated so that existing configuration keeps parsing, and will be removed in the next major version. Do not infer circuit-breaking behavior from its presence in the config schema.

## Decision: every Redis connection gets a default `'error'` listener

`Redis`/`Cluster` instances are Node `EventEmitter`s that throw an uncaught exception and crash the process when an `'error'` event fires with zero listeners. Every connection the package opens therefore has a default listener, so a connection drop can never crash the process by itself. On the client facade that listener forwards to the application's `onError` hook (a `RedisClientDependencies` member) with a context naming the source — `connection` for the shared connection, `subscriber` for the Pub/Sub subscriber connection and `stream-reader` for a connection a blocking stream read runs on, each with its per-node errors on Cluster under the same source. The hook also receives what no caller can be given from elsewhere: `pubsub-handler` for a Pub/Sub handler that failed or a message that was not JSON, and `lock-release` for a failed release inside `lock.using()`. Without a hook, errors are dropped; a hook that throws or rejects is contained. `RedisClient.close()` closes every connection the facade opened.

## Decision: module `enabled` flags are enforced uniformly

Every module config (`cache`, `lock`, `rateLimit`, `pubsub`, `streams`, `sessions`) exposes an `enabled` flag defaulting to `false`. `RedisClient`'s lazy getters (`.cache`, `.lock`, `.rateLimiter`, `.pubsub`, `.streams`, `.sessions`) throw a configuration error while the corresponding module is disabled. The client facade and the session factory functions are the only supported way to obtain a module ([ADR-0003](https://github.com/org-utils/ioredis-toolkit/blob/main/docs/adr/0003-facade-only-public-surface.md)), and `createSessionManager` rejects a disabled session configuration with a `SessionConfigurationError`, so the flag gates every supported path to a module.
