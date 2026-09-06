# Architecture Decision Record

## Status

Accepted for the initial implementation.

## Decision: create the package and Redis infrastructure from scratch

The supplied specification described an existing Redis package, but this project started without one. Therefore the implementation owns the Redis connection factory, wrapper, cluster utilities, configuration validation, session domain, and public exports. No duplicate external authentication/core package is assumed.

## Decision: opaque token + token-hash locator

A token-only `validate(token)` operation requires a locator. The package uses SHA-256(token) as the lookup key and stores only the derived hash plus a user hash-tag pointer. The actual session record remains authoritative.

This is a deliberate secondary-index consistency boundary. A missing/stale index never authenticates anything.

## Decision: per-user Cluster hash tag

Session keys are shaped as:

`<namespace>:session:{<sha256(userId)>}:<sha256(token)>`

The user hash is deterministic and safe for Redis hash-tag syntax. It keeps one user's session records/index in one slot while distributing different users across slots.

## Decision: no global JTI index

JTI is an internal session identifier and is not needed to validate the opaque token. A global JTI index would add another cross-slot consistency boundary without improving the core validation path.

## Decision: session index as a negative authorization guard

The user sorted-set index is checked during validation. The index can deny access but cannot grant access: the session record must independently pass all checks.

Max-session enforcement (`create_session`) and revocation (`revoke()`, and rotation's `consume()`) all remove their affected member from the index eagerly. `create_session` additionally deletes the evicted session's own physical session and token-index keys — a bounded operation (at most one evicted session per `create()` call, given the per-user cap is enforced on every write), not the unbounded cluster-wide cleanup the "bounded maintenance" decision below rules out. Earlier revisions left the physical keys behind to expire on their own TTL; that left orphaned Redis memory and a token-index entry that stayed briefly resolvable past the point the session was actually evicted, so the index-only approach was deliberately narrowed to also delete the record it is evicting.

## Decision: rotation is two-phase

A predecessor is consumed atomically. A successor is created separately because the token-hash key is unrelated to the predecessor's key slot. This can produce a safe availability failure after consumption, but cannot produce two valid successors.

The package does not claim rotation idempotency. Network-timeout retry must be handled by a higher-level protocol if required.

## Decision: server time

Redis TIME is used for authentication/session timestamps to reduce application-clock ordering problems. TTLs remain Redis storage cleanup boundaries; application expiration fields remain authoritative for session validity.

## Decision: bounded maintenance

No request path scans the entire cluster or performs unbounded Lua loops. Batch/list/revoke-all calls are capped by configuration.

## Decision: no built-in circuit breaker

The low-level Redis client already owns connection/reconnect behavior. A circuit breaker in this first package would add another failure-state machine without changing the required fail-closed authentication semantics. Applications may wrap the package with an operation-class breaker if their deployment needs one.

`SessionConfig.circuitBreaker` exists as a reserved, fully-validated/defaulted configuration section for a future breaker, but no repository or service code currently reads it — it is not yet wired to any actual circuit-breaking behavior. Do not infer working circuit-breaker semantics from its presence in the config schema.

## Decision: every Redis connection gets a default `'error'` listener

`Redis`/`Cluster` instances are Node `EventEmitter`s that throw an uncaught exception and crash the process when an `'error'` event fires with zero listeners. `createRedisConnection()` and `RedisPubSub`'s dedicated subscriber connection now both attach a no-op default listener so a connection drop can never crash the process by itself. This does not replace real observability: applications that need alerting on connection errors should still attach their own `'error'` listener on the connection object.

## Decision: module `enabled` flags are enforced uniformly

Every module config (`cache`, `lock`, `rateLimit`, `pubsub`, `streams`, `sessions`) exposes an `enabled` flag defaulting to `false`. `RedisClient`'s lazy getters (`.cache`, `.lock`, `.rateLimiter`, `.pubsub`, `.streams`, `.sessions`) throw a configuration error while the corresponding module is disabled. Each module class remains directly constructible regardless of `enabled` — the flag only gates access through the shared client facade, matching how `sessions` already behaved before the other four modules were brought in line with it.
