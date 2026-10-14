---
"ioredis-toolkit": patch
---

A `RedisPubSub` constructed directly, without the client facade and without a reporter, no longer crashes the process. Its subscriber-connection errors, handlers that throw and messages that are not JSON were passed to a reporter that was `undefined`, which threw from the connection's `'error'` listener. They are now dropped, as `RedisLock` and `RedisStreams` already do without a reporter.
