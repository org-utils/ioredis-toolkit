---
"ioredis-toolkit": patch
---

Fixes to the previous release's stream readers, `revokeAll()` and multi-key deletes.

- After `streams.close()`, a blocking `read()` now rejects. Before, it ran on the client's shared connection, which `streams.close()` leaves open, so it could stall every other command again. `RedisClient.close()` behaves as before.
- `revokeAll()` throws `SessionStorageError` again when deleting the token locators fails, as it did before the Cluster fix, so a retry revokes the same batch. The locators are now deleted before the records.
- A multi-key delete on standalone Redis, such as `cache.delete(...keys)`, now sends `DEL`s of at most 500 keys instead of one unbounded `DEL`.
