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
| `namespace` | `string` | `app` | Session key namespace. |
| `tokenBytes` | `number` | `32` | Random secret bytes; minimum 32 (256 bits). |
| `ttl` | `number` | 30 days | Hard Redis/session lifetime in seconds. |
| `idleTimeout` | `number` | unset | Optional rolling inactivity lifetime. |
| `absoluteTimeout` | `number` | unset | Optional hard application lifetime. |
| `touchInterval` | `number` | 60 | Minimum interval between rolling touch writes. |
| `rolling` | `boolean` | `true` | Enables rolling idle expiration behavior. |
| `securityVersionEnabled` | `boolean` | `false` | Enables per-user security-version invalidation. |
| `maxSessionsPerUser` | `number` | 20 | Maximum configured indexed sessions per user. |
| `maxMetadataBytes` | `number` | 8192 | Maximum metadata JSON size. |
| `maxBatchSize` | `number` | 200 | Maximum bounded administrative batch. |
| `maxConcurrency` | `number` | 8 | Maximum bounded cross-slot/application fan-out. |
| `storeIpAddress` | `boolean` | false | Persists IP metadata when enabled. |
| `storeUserAgent` | `boolean` | false | Persists user-agent metadata when enabled. |
| `storeDeviceId` | `boolean` | false | Persists device ID metadata when enabled. |
| `encryption.enabled` | `boolean` | false | Enables authenticated encryption for serialized session values when a key manager is supplied. |
| `circuitBreaker` | object | see below | Reserved configuration, fully defaulted and validated like every other nested section. Not yet consulted by any repository/service code path — there is no circuit-breaker behavior wired up in this release. |
| `cookie` | object | secure defaults | Cookie serialization settings. |

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

```ts
await sessions.touch(token);
```

It is usually appropriate to call this on authenticated requests without writing every request to Redis.

## `update(token, patch, expectedVersion?)`

Updates mutable metadata with optional optimistic concurrency.

```ts
const current = await sessions.get(token);
const updated = await sessions.update(token, {
  metadata: { ...current.metadata, theme: 'dark' },
}, current.version);
```

If another writer changed the record first, the expected-version check prevents an unintended lost update.

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

Revocation is idempotent from the application's perspective. `revoke()` (and rotation's internal predecessor `consume()`) remove the session from the user's index immediately rather than only relying on `list()`'s lazy self-heal, so a revoked/rotated session stops counting toward `maxSessionsPerUser` right away instead of only once its tombstone expires.

## `destroy(token)`

Permanently removes the session record and derived indexes.

```ts
await sessions.destroy(token);
```

Use `revoke()` when you need an explicit invalidation state; use `destroy()` when removing stored session data is preferable.

## `setSecurityVersion(userId, version)`

Sets a per-user security version when the feature is enabled. Sessions carrying an older version fail authentication.

```ts
await sessions.setSecurityVersion('user_123', 8);
```

A common password-reset/logout-all pattern is to increment the user's security version and then let old sessions fail validation.

## `revokeAll(userId, limit?)`

Revokes a bounded batch and returns `{ affected, remaining }` so large user indexes do not require loading every session into memory.

```ts
let page = await sessions.revokeAll('user_123', 200);
while (page.remaining > 0) {
  page = await sessions.revokeAll('user_123', 200);
}
```

Use bounded loops or background jobs for users with unusually large session counts.

## `list(userId, offset?, limit?)`

Returns a bounded page of authoritative sessions for an application user.

```ts
const sessionsForUser = await sessions.list('user_123', 0, 50);
```

This is an administrative/management operation, not an authentication primitive. A `limit` greater than the configured `maxBatchSize` throws `SessionLimitError` (a malformed `offset`/`limit` throws `SessionInvalidError`).

## Cookie helpers

The package also exposes cookie serializers:

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

Cookie authentication requires a CSRF strategy appropriate to the application. `HttpOnly` protects against direct JavaScript reads but does not itself prevent CSRF.

## Security and topology model

Session records and per-user indexes use a user-derived Redis hash tag so operations concerning one user's sessions can be atomic within one Cluster slot. Operations spanning different users are not treated as cross-slot transactions.

Never log raw session tokens. Do not put them into metrics labels, traces, exception messages, or persistent application logs.

`RedisRevocationStore` is a separate, standalone utility for credentials whose authorization model is JTI-based (such as externally issued JWTs) — see [docs/README-API.md](../../README-API.md). It is intentionally **not** consulted by `SessionService`: this module's opaque sessions treat session state itself as the source of truth and deliberately avoid an extra revocation-key lookup on every `validate()` call.

## Errors

All typed errors extend `SessionError` and carry a stable `code`:

| Class | Code | Thrown by |
|---|---|---|
| `SessionNotFoundError` | `SESSION_NOT_FOUND` | `get()` when the token resolves to no record |
| `SessionExpiredError` | `SESSION_EXPIRED` | `get()`/`touch()`/`rotate()` on an expired/idle-timed-out session |
| `SessionRevokedError` | `SESSION_REVOKED` | `get()` on a revoked session |
| `SessionReplayError` | `SESSION_REPLAY` | `rotate()` on a non-active (already consumed/revoked) session |
| `SessionRotationError` | `SESSION_ROTATION` | `rotate()` when the predecessor was already consumed, cannot be rotated, or the successor could not be created after the predecessor was consumed |
| `SessionConflictError` | `SESSION_CONFLICT` | `update()` on a stale `expectedVersion` |
| `SessionLimitError` | `SESSION_LIMIT` | `list()` when `limit` exceeds `maxBatchSize` |
| `SessionInvalidError` | `SESSION_INVALID` | malformed input, or a session that fails an index/security-version check |
| `SessionStorageError` | `SESSION_STORAGE` | Redis-level read/write failures |
| `SessionSerializationError` | `SESSION_SERIALIZATION` | a record cannot be serialized, or fails schema/decryption validation on read |
| `SessionConfigurationError` | `SESSION_CONFIGURATION` | invalid session configuration, or constructing the manager while `enabled: false` |

`validate()` never throws for ordinary invalid-credential conditions — see the discriminated result above. These errors surface from `get()` and the other exception-based methods.

## Metrics

`SessionService` accepts an optional `metrics: SessionMetrics` sink (via `createSessionManager({ ..., metrics })` or `createRedisClient(config, { metrics })`) and defaults to a no-op implementation (`NoopMetrics`) when none is supplied. When configured, it receives `increment()` calls for `session.created`, `session.validate` (labeled `result: 'valid' | 'invalid'`, plus `reason` on the invalid path), `session.rotated`, `session.revoked`, and `session.destroyed`.

## Unified configuration overrides

```ts
redis.withSessions({ idleTimeout: 60 * 60 });
redis.withSessions({ namespace: 'auth:v2', rolling: false }, 'replace');
```

`merge` preserves existing normalized values; `replace` applies the supplied values on top of module defaults.
