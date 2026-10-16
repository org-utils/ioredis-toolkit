---
"ioredis-toolkit": patch
---

`lock.acquire()`, `sessions.create()` and `sessions.rotate()` now succeed when ioredis sends a command of theirs a second time after its reply was lost (#131). ioredis does this on any reconnect (`autoResendUnfulfilledCommands`, on by default). Before, the second run found what the first had written: `acquire()` returned `acquired: false` while the lock held the caller's own token, `create()` failed and, when it was the token locator's write that ran twice, deleted the session it had just stored, and `rotate()` threw `SessionReplayError` for a rotation that had happened. `docs/DEPLOYMENT.md` now lists, per module, the calls that are still not safe to run twice, `rateLimiter.consume()` among them, and what the caller then sees.
