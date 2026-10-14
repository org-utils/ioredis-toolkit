---
"ioredis-toolkit": patch
---

`cache.clear()` now works on a namespace of any size. It deletes each page of matching keys as the scan returns it, in `DEL`s of at most 500 keys, grouped by hash slot on Cluster. Before, it collected every matching key first, then threw a `RangeError` or sent one enormous `DEL` once the keyspace was large enough. On a Cluster client created just before the call, it also returned `0` and deleted nothing, because the client did not yet know its masters. The count it returns is now exact on Cluster, where concurrent deletes could undercount before.

`cache.delete()` with no keys now returns `0` without contacting Redis, instead of failing with a Redis argument error.

Cluster-aware behaviour now recognises a Cluster connection by ioredis's own `isCluster` marker instead of `instanceof`. An application that resolves a second copy of ioredis, and passes its `Cluster` to `new RedisClient()`, no longer has cross-slot deletes and reads silently treated as standalone.
