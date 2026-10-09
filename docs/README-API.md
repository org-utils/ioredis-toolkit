# API Notes

## Authorization boundary

The package does not know whether the caller is an administrator or the owner of a user account. `revokeAll(userId)` and `list(userId)` therefore must be called only after the host authentication/authorization layer has established permission. The package intentionally does not accept a caller-supplied user ID as proof of authorization.

## Token lookup

`validate(token)` performs a token-hash lookup, then loads and validates the authoritative session record and checks the per-user authorization index. No raw token is used as a Redis key.
