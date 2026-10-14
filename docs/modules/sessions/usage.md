# Sessions Module — Complete Usage Guide

`SessionManager` is a framework-independent Redis-backed authentication-session subsystem. Raw session credentials are returned only at creation/rotation time and are not stored as plaintext Redis values.

## Setup with the unified client

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,
  sessions: {
    enabled: true,
    namespace: 'auth',
    tokenBytes: 32,
    ttl: 60 * 60 * 24 * 30,
    rolling: true,
    idleTimeout: 60 * 60 * 24 * 7,
    absoluteTimeout: 60 * 60 * 24 * 30,
    touchInterval: 60,
    securityVersionEnabled: true,
    maxSessionsPerUser: 20,
    maxMetadataBytes: 8192,
  },
});

const sessions = redis.sessions;
```

To supply a metrics sink or an encryption key manager alongside `createRedisClient()`, pass them as the second argument:

```ts
const redis = createRedisClient(
  { mode: 'standalone', host: '127.0.0.1', port: 6379, sessions: { enabled: true } },
  { metrics: myMetricsSink, encryptionKeyManager: myKeyManager },
);
```

Sessions must be explicitly enabled. Creating the client does not require session initialization until `redis.sessions` is accessed.

## Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `enabled` | `boolean` | `false` | Enables the session subsystem. |
| `namespace` | `string` | `app` | Namespace: the first segment of every session key. Letters, digits, `:`, `_` and `-` only, at most 128 characters. |
| `tokenBytes` | `number` | `32` | Random secret bytes; minimum 32 (256 bits). |
| `ttl` | `number` | 30 days | Hard Redis/session lifetime in seconds. |
| `idleTimeout` | `number` | unset | Optional rolling inactivity lifetime. |
| `absoluteTimeout` | `number` | unset | Optional hard application lifetime. |
| `touchInterval` | `number` | 60 | Minimum interval between rolling touch writes. |
| `rolling` | `boolean` | `true` | Enables rolling idle expiration behavior. A touch extends only the idle expiry, never the hard `ttl`. |
| `securityVersionEnabled` | `boolean` | `false` | Enables per-user security-version invalidation. The first `create()` for a user stores its version; see [`setSecurityVersion`](#setsecurityversionuserid-version). |
| `maxSessionsPerUser` | `number` | 20 | Maximum sessions in a user's session set. A `create()` over the limit evicts the oldest sessions, never the one it creates. `0` is unlimited. |
| `maxMetadataBytes` | `number` | 8192 | Maximum metadata JSON size. |
| `maxBatchSize` | `number` | 200 | Maximum bounded administrative batch. |
| `maxConcurrency` | `number` | 8 | Maximum bounded cross-slot/application fan-out. |
| `storeIpAddress` | `boolean` | false | Persists IP metadata when enabled. |
| `storeUserAgent` | `boolean` | false | Persists user-agent metadata when enabled. |
| `storeDeviceId` | `boolean` | false | Persists device ID metadata when enabled. |
| `encryption.enabled` | `boolean` | false | Enables authenticated encryption for serialized session values when a key manager is supplied. |
| `circuitBreaker` | object | see below | **Deprecated, and has no effect.** The package has no circuit breaker. The section is still accepted and validated so that existing configuration keeps parsing, and will be removed in the next major version. |
| `cookie` | object | secure defaults | The cookie `sessions.cookie()` and `sessions.deletionCookie()` serialize: `name`, `httpOnly`, `secure`, `sameSite`, `domain`, `path` and an optional `maxAge`. See [Cookie helpers](#cookie-helpers). |

`circuitBreaker` defaults to `{ enabled: false, failureThreshold: 5, resetTimeoutMs: 10_000, halfOpenMaxRequests: 1 }` and, like `encryption` and `cookie`, may be omitted entirely.

## `create(input)`

Creates a session and returns the raw opaque token exactly once.

```ts
const created = await sessions.create({
  userId: 'user_123',
  deviceId: 'device_1',
  ipAddress: '203.0.113.10',
  userAgent: 'Mozilla/5.0',
  metadata: { loginMethod: 'password', rememberMe: true },
});

// Store this only in the client's secure cookie/session transport.
const token = created.token;
console.log(created.session.id, created.session.expiresAt);
```

The token is an opaque credential composed of a random JTI and random secret. The authoritative Redis session record does not contain the raw token.

## `validate(token)`

Returns a discriminated result instead of throwing for ordinary invalid-session conditions.

```ts
const result = await sessions.validate(request.cookies.session ?? '');
if (!result.valid) {
  // reason may be not_found, expired, idle_timeout, absolute_timeout,
  // revoked, consumed, or invalid.
  return unauthorized();
}
const userId = result.session.userId;
```

Infrastructure failures are different from an invalid credential and are surfaced as storage errors; applications should not convert infrastructure failures into successful authentication.

## `get(token)`

Gets an active authoritative session or throws a typed session error.

```ts
const session = await sessions.get(token);
```

Use this when the caller wants exception-based control flow rather than the discriminated `validate()` result.

## `touch(token)`

Applies rolling idle-expiration rules. Touches are throttled by `touchInterval` and are bounded by the absolute expiration.

`rolling` extends only the idle expiry (`idleExpiresAt`), never the hard `ttl`. A session's `expiresAt`, which `create()` sets from `ttl` (or from `absoluteTimeout` if that comes sooner), and the Redis expiry of its record stay where they were however often it is touched, so even a session in constant use ends at `expiresAt`. A session created without an idle timeout has nothing for a touch to extend.

```ts
await sessions.touch(token);
```

It is usually appropriate to call this on authenticated requests without writing every request to Redis.

A touch does not change the session's `version`, so a background touch never invalidates a version an `update()` is about to rely on.

## `update(token, patch, expectedVersion?)`

Updates mutable metadata with optional optimistic concurrency.

```ts
const current = await sessions.get(token);
const updated = await sessions.update(token, {
  metadata: { ...current.metadata, theme: 'dark' },
}, current.version);
```

`version` counts the changes an application can see: each `update()` and each status change (rotation, revocation) increments it, and `touch()` does not. If another `update()` changed the record after `expectedVersion` was read, the call throws `SessionConflictError` (code `SESSION_CONFLICT`) instead of overwriting it. Without `expectedVersion`, the patch is applied to whatever is stored. Either way, the patch is applied to the record as stored when it is written, so a touch that landed in between is kept.

`update()` follows the same rules as `create()` for client details. `ipAddress`, `userAgent` and `deviceId` are stored only when `storeIpAddress`, `storeUserAgent` and `storeDeviceId` are on, and are otherwise ignored. They are capped at 128, 1024 and 256 characters respectively, and a longer value throws `SessionInvalidError`. Passing `null` clears a stored value.

## `rotate(token)`

Consumes the predecessor and creates a successor token atomically within the session's Redis hash-tag slot.

```ts
const rotated = await sessions.rotate(token);
// Replace the client cookie with rotated.token.
```

After successful rotation, the predecessor is no longer accepted. Concurrent rotation attempts must not produce multiple valid successors. The successor's rolling idle-timeout window preserves the duration originally configured when the session (or its earliest ancestor) was created, rather than being re-derived from the predecessor's most recent touch — so the idle window does not silently shrink across repeated rotations. If the predecessor is consumed but successor creation then fails, `rotate()` throws `SessionRotationError` rather than leaving the caller with an ambiguous storage error.

## `revoke(token)`

Marks a session unusable.

```ts
await sessions.revoke(token);
```

Revocation is idempotent from the application's perspective. `revoke()` (and rotation's internal predecessor `consume()`) remove the session from the user's session set immediately rather than only relying on `list()`'s lazy self-heal, so a revoked/rotated session stops counting toward `maxSessionsPerUser` right away instead of only once its tombstone expires.

A revoked or rotated session's record is kept as a tombstone for the rest of its lifetime, capped at 300 seconds. Its token locator, the key that maps the credential to its user, is cut to expire with the tombstone. While the tombstone lasts, a rotated credential presented again validates as `consumed` (and `rotate()` throws `SessionReplayError`), and a revoked one as `revoked`. Once the tombstone has expired, both validate as `not_found` and none of their keys remain, however often a session is rotated.

`revoke()` given a credential that rotation already consumed ends its successor, the session that replaced it: it follows the rotation chain to its end and revokes the session there, if that one is still active. So a user logging out with a stale cookie is logged out. The consumed credential itself is left as it is, so it keeps validating as `consumed`, and `rotate()` on it keeps throwing `SessionReplayError`. Replay on its own ends no session, because two requests that rotate concurrently look the same as a stolen credential. To end every session of a user when you see `SessionReplayError`, call `revokeAll()`, or `setSecurityVersion()` with `securityVersionEnabled`.

## `destroy(token)`

Permanently removes the session record, its token locator and its member of the user's session set.

```ts
await sessions.destroy(token);
```

Use `revoke()` when you need an explicit invalidation state; use `destroy()` when removing stored session data is preferable.

## `setSecurityVersion(userId, version)`

Sets a per-user security version when the feature is enabled. Sessions carrying an older version fail authentication.

A security version is a whole number of at least 0. `setSecurityVersion()`, and `create()` when given a `securityVersion`, throw `SessionInvalidError` (`SESSION_INVALID`) for any other value, such as `-1`, `1.5` or `NaN`, and store nothing.

```ts
await sessions.setSecurityVersion('user_123', 8);
```

A common password-reset/logout-all pattern is to increment the user's security version and then let old sessions fail validation.

With `securityVersionEnabled`, `create()` requires `securityVersion`, and a session validates only while its version equals the one stored for its user. Turning the feature on needs no backfill. When no version is stored for a user, `create()` stores the one it is given, set only if absent, together with the session. `create()` never overwrites a stored version, so only `setSecurityVersion()` moves it, and a session created with an older version than the stored one validates as `invalid` from the start. If the stored version is missing (never written, or evicted under memory pressure), validation fails closed: every session of that user validates as `invalid` until the next `create()` or `setSecurityVersion()` stores one.

The stored version expires with the user's sessions. It lives as long as the user's longest-lived session, and `create()` extends it, never shortening it. After `setSecurityVersion()` it lives for at least the configured session `ttl` as well. Once it has expired, the user has no session left for it to invalidate, and the next `create()` stores the version it is given, as for a new user. So after a bump, a user with no sessions for longer than the session `ttl` can be given a session with the previous version; pass the user's current version to `create()`.

## `revokeAll(userId, limit?)`

Revokes a bounded batch and returns `{ affected, remaining }` so a large session set does not require loading every session into memory. The revoked sessions are deleted outright, so their credentials then validate as `not_found`. It works the same on standalone Redis and on Cluster.

```ts
let page = await sessions.revokeAll('user_123', 200);
while (page.remaining > 0) {
  page = await sessions.revokeAll('user_123', 200);
}
```

Use bounded loops or background jobs for users with unusually large session counts.

## `list(userId, offset?, limit?)`

Returns a bounded page of an application user's sessions. A session past any of its expiries (hard, idle or absolute), measured in Redis server time, is left out, so the page lists only sessions that can still authenticate. A page can therefore hold fewer than `limit` sessions while more remain.

A member of the user's session set whose record is gone is removed from the set. A record that cannot be decoded, for example because the key manager lacks the key version it was encrypted under, is left out of the page but stays in the set and in Redis.

```ts
const sessionsForUser = await sessions.list('user_123', 0, 50);
```

This is an administrative/management operation, not an authentication primitive. A `limit` greater than the configured `maxBatchSize` throws `SessionLimitError` (a malformed `offset`/`limit` throws `SessionInvalidError`).

## Cookie helpers

The session manager serializes the cookie its `cookie` configuration describes:

```ts
const { token, session } = await sessions.create({ userId: 'user_123' });
response.setHeader('Set-Cookie', await sessions.cookie(token, session));

// On sign-out:
response.setHeader('Set-Cookie', sessions.deletionCookie());
```

`cookie(token, session)` carries the configured name, domain, path, `HttpOnly`, `Secure` and `SameSite` attributes. Its `Max-Age` is `cookie.maxAge` when that is configured. Otherwise it is what the session has left before its hard expiry, measured in Redis server time, which is why the method is async. `deletionCookie()` returns an expired cookie with the configured name, path and domain, so the browser drops the session cookie.

The package also exposes the cookie serializers themselves:

```ts
import { serializeCookie, serializeDeletionCookie } from 'ioredis-toolkit';

const header = serializeCookie(token, {
  name: 'session',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 30,
});

const clear = serializeDeletionCookie({ name: 'session', path: '/' });
```

`serializeCookie()` rejects a `Domain` or `Path` that contains `;`, a control character or whitespace, any of which would end the attribute early or split the header, by throwing `SessionInputError`.

Cookie authentication requires a CSRF strategy appropriate to the application. `HttpOnly` protects against direct JavaScript reads but does not itself prevent CSRF.

## Security and topology model

Session records and the user's session set use a user-derived Redis hash tag so operations concerning one user's sessions can be atomic within one Cluster slot. Operations spanning different users are not treated as cross-slot transactions.

Never log raw session tokens. Do not put them into metrics labels, traces, exception messages, or persistent application logs.

## Errors

All typed errors extend `SessionError`, which extends the package-wide `RedisToolkitError`, and carry a stable `code`:

| Class | Code | Thrown by |
|---|---|---|
| `SessionNotFoundError` | `SESSION_NOT_FOUND` | `get()` when the token resolves to no record |
| `SessionExpiredError` | `SESSION_EXPIRED` | `get()`/`touch()`/`rotate()` on an expired/idle-timed-out session |
| `SessionRevokedError` | `SESSION_REVOKED` | `get()` on a revoked session |
| `SessionReplayError` | `SESSION_REPLAY` | `rotate()` on a non-active (already consumed/revoked) session |
| `SessionRotationError` | `SESSION_ROTATION` | `rotate()` when the predecessor was already consumed, cannot be rotated, or the successor could not be created after the predecessor was consumed |
| `SessionConflictError` | `SESSION_CONFLICT` | `update()` on a stale `expectedVersion` |
| `SessionLimitError` | `SESSION_LIMIT` | `list()` when `limit` exceeds `maxBatchSize` |
| `SessionInvalidError` | `SESSION_INVALID` | malformed input, or a session that fails a session set or security-version check |
| `SessionStorageError` | `SESSION_STORAGE` | Redis-level read/write failures |
| `SessionSerializationError` | `SESSION_SERIALIZATION` | a record cannot be serialized, or fails schema/decryption validation on read. `validate()` throws it too. The record is never deleted, so restoring the key manager or encryption setting makes the session usable again |
| `SessionConfigurationError` | `SESSION_CONFIGURATION` | invalid session configuration, or constructing the manager while `enabled: false` |
| `SessionInputError` | `SESSION_INPUT` | `serializeCookie()`/`serializeDeletionCookie()` (and so `cookie()`/`deletionCookie()`) given an invalid cookie name, a `Domain` or `Path` containing `;`, a control character or whitespace, or `SameSite=None` without `Secure` |

`validate()` never throws for ordinary invalid-credential conditions — see the discriminated result above. These errors surface from `get()` and the other exception-based methods.

## Metrics

The session manager accepts an optional `metrics: SessionMetrics` sink (via `createSessionManager({ ..., metrics })` or `createRedisClient(config, { metrics })`) and records nothing when none is supplied. When configured, it receives `increment()` calls for `session.created`, `session.validate` (labeled `result: 'valid' | 'invalid'`, plus `reason` on the invalid path), `session.rotated`, `session.revoked`, and `session.destroyed`.

## Unified configuration overrides

```ts
redis.withSessions({ idleTimeout: 60 * 60 });
redis.withSessions({ namespace: 'auth:v2', rolling: false }, 'replace');
```

`merge` preserves existing normalized values; `replace` applies the supplied values on top of module defaults.
