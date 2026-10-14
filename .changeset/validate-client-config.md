---
"ioredis-toolkit": patch
---

`createRedisClient()` now validates the connection configuration before it connects, with `parseRedisConnectionConfig`. A mistyped `mode` throws `RedisConfigurationError` instead of silently connecting as standalone. Cluster startup nodes are accepted in every form ioredis takes: `host:port` strings, bare ports, and addresses.

The client facade now rejects, with `RedisConfigurationError`, any configuration where two enabled modules share a namespace, or where one namespace is a colon-delimited prefix of another (`app` and `app:cache`, but not `app` and `application`). The check runs when the client is created, before it connects, and again on every `with*()` call. A `with*()` call that would cause a collision throws and leaves the previous configuration in effect. Disabled modules are not checked.

**This can make a previously accepted configuration fail at startup.** For example, a cache sharing its namespace with sessions used to be accepted, and `cache.clear()` would then delete every session. Give each enabled module a namespace of its own.
