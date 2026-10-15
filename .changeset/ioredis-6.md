---
"ioredis-toolkit": major
---

The package now depends on ioredis 6 (`^6.0.0`), and the ioredis types in its public surface are ioredis 6's. ioredis 6's new `replyMapping` option is not supported: the package reads replies in ioredis's default shape, which `replyMapping: 'resp3'` would change. The connection configurations (`StandaloneRedisConfig`, `SentinelRedisConfig`, `ClusterRedisConfig` and a Cluster's `redisOptions`) leave it out, and `createRedisClient`, `createRedisConnection` and `createSessionManagerFromRedis` throw `RedisConfigurationError` for a configuration that sets it.
