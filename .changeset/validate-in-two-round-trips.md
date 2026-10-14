---
"ioredis-toolkit": patch
---

`validate()`, and so `get()`, `touch()`, `update()` and `rotate()`, checks a credential in two round trips to Redis, down from four or five: the token locator, then one script in the user's hash slot that reads the session record, its membership in the user's session set, the security version and Redis server time together. `touch()` writes from that same read instead of reading the record and the time again. Because the record and its membership are read at one instant, a losing concurrent `rotate()` of one credential is now always refused with `SessionReplayError`; on Redis Cluster it could before be refused with `SessionInvalidError`. Validation reasons and errors are otherwise unchanged.
