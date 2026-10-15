---
"ioredis-toolkit": minor
---

`RedisClient` gains `health()`, a health check for readiness and liveness probes (#98). It sends a `PING` with a timeout of its own (`timeoutMs`, default 1000), so it answers in time even while Redis is down, where a plain `ping()` stays queued through ioredis's reconnect retries. A Redis failure resolves as `unhealthy` with the reason in `error`, never as a rejection, and a round trip slower than `degradedMs` (default 100) is `degraded`. On Cluster every master is pinged, and each is reported in `nodes`; the cluster is `unhealthy` when any master is. Its types, `RedisHealth`, `RedisHealthOptions`, `RedisHealthStatus` and `RedisNodeHealth`, are exported from the root. The internal `SessionHealthProvider`, unreachable from the public surface since 1.0.1, is removed.
