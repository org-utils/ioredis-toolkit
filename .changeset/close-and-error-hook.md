---
"ioredis-toolkit": patch
---

The client can now be shut down, and its connection errors observed. `RedisClient.close()` closes every connection the client opened: the shared connection and, if Pub/Sub was used, the subscriber connection. A connection that is up is quit, so commands already sent complete; one that is not is disconnected. `close()` is idempotent, and safe whichever modules were used. `RedisPubSub.close()` is idempotent too, and the `redis` that `createSessionManagerFromRedis` returns now has a `close()` of its own.

`RedisClientDependencies` gains `onError(error, context)`. Each connection the client opens keeps its default `'error'` listener, so an unobserved error still never crashes the process, and that listener now forwards to the hook with a context naming the source: `connection` or `subscriber`. On Cluster, errors on the connection to each node are reported under the same source. A hook that throws or rejects is contained. The context types are public as `RedisErrorContext` and `RedisErrorSource`.
