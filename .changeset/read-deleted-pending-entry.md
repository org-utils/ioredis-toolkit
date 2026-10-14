---
"ioredis-toolkit": patch
---

`streams.read()` no longer throws a `TypeError` when a consumer-group read of the pending list re-delivers an entry deleted from the stream since it was delivered (#89). The entry comes back with its `id` and empty `fields`, so the consumer can still `ack()` it and clear it from the pending list.
