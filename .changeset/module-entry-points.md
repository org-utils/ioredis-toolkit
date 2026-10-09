---
"ioredis-toolkit": patch
---

Every module now has one entry point, and each subpath exports its class together with the types that go with it. A subpath used to export one class and no types, so the config you pass a module and the results it returns could only be named by importing from the root as well.

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
