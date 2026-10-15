---
"ioredis-toolkit": minor
---

The package now depends on ioredis 6 (`^6.0.0`). The connection configurations (`StandaloneRedisConfig`, `SentinelRedisConfig`, `ClusterRedisConfig` and a Cluster's `redisOptions`) do not take ioredis 6's new `replyMapping` option: the package reads replies in ioredis's default shape, which `replyMapping: 'resp3'` would change.
