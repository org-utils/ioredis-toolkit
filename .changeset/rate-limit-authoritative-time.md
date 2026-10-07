---
"ioredis-toolkit": patch
---

Rate limiting now buckets windows by Redis server time instead of the application server's clock. Previously two hosts with skewed clocks placed the same subject in different windows, so the configured limit silently failed to hold across them.

Breaking: `RedisRateLimiter.consume`, `check` and `reset` no longer accept a `nowSeconds` argument, and `key()` now requires its time argument instead of defaulting to the local clock. `resetAt` is now reported in Redis server time. Each call reads the server clock first, which costs one extra round trip.
