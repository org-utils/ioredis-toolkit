---
"ioredis-toolkit": patch
---

Fixes to what the #44 audit fixes left uncovered: connections opened after `close()`, the session factory's validation, and security versions.

- After `client.close()`, the client opens no further connection. A Pub/Sub subscribe or a blocking stream read afterwards rejects with the `Connection is closed.` error ioredis gives a command on a closed connection, whenever the module was first used. Before, a module first used after the close opened a connection that nothing closed, which kept the process alive. The Pub/Sub subscriber connection is now opened by the first `subscribe()` rather than when the module is first accessed, so a client that only publishes opens none.
- `createSessionManagerFromRedis()` validates both configurations before it connects. **A mistyped `mode`, which it used to accept and connect as standalone, now throws `RedisConfigurationError` at startup.** Disabled sessions, and encryption without a key manager (which this factory cannot take), still throw `SessionConfigurationError`, but no longer leave a connection open.
- `create()` throws `SessionInvalidError` (`SESSION_INVALID`) for a `securityVersion` that is not a whole number of at least 0, as `setSecurityVersion()` already did, whether or not `securityVersionEnabled` is on, since the version is stored in the session either way. Before, a value such as `-1` or `NaN` became the user's stored version and could not be overwritten by a later `create()`, and `1.5` wrote a session that could not be read back.
