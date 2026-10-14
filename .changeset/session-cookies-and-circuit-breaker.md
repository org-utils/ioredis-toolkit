---
"ioredis-toolkit": patch
---

The session `cookie` configuration is now used. `SessionManager` gains `cookie(token, session)`, which resolves to a `Set-Cookie` value with the configured name, domain, path, `HttpOnly`, `Secure` and `SameSite` attributes, and `deletionCookie()`, which returns the expired cookie that removes it. Unless `cookie.maxAge` is set, `Max-Age` is what the session has left before its hard expiry, measured in Redis server time.

`serializeCookie()` now rejects a `Domain` or `Path` containing `;`, a control character or whitespace by throwing `SessionInputError`, so an input-derived value can no longer end the attribute early or inject attributes of its own.

`circuitBreaker` is deprecated and has no effect. The package has never had a circuit breaker. The setting is still accepted, so existing configuration keeps parsing, and is marked `@deprecated` in the type declarations. It will be removed in the next major version.
