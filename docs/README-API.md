# API Notes

## Authorization boundary

The package does not know whether the caller is an administrator or the owner of a user account. `revokeAll(userId)` and `list(userId)` therefore must be called only after the host authentication/authorization layer has established permission. The package intentionally does not accept a caller-supplied user ID as proof of authorization.

## Token lookup

`validate(token)` performs a token-hash lookup, then loads and validates the authoritative session record and checks the per-user authorization index. No raw token is used as a Redis key.

## Revocation store

Use `RedisRevocationStore` for credentials whose authorization model is JTI-based, such as externally issued JWTs. For the opaque stateful sessions in this package, session state itself is the source of truth and a separate revocation key is intentionally not consulted on every request.

`RedisRevocationStore.revoke(jti, now, expiresAt, reason?)` takes an explicit `now` (Unix seconds) rather than reading `Date.now()` internally, so callers should source `now` from the same clock used elsewhere in their system (e.g. Redis `TIME`, as `SessionService` does) to avoid clock-skew affecting the tombstone TTL.
