---
"ioredis-toolkit": patch
---

`SessionRepository.consume()` now throws `SessionReplayError` (instead of a generic `SessionRotationError`) when the atomic `consume_session` script reports the predecessor was already consumed. This closes a race in `SessionService.rotate()`: the pre-check against `current.status` and the atomic consume happen at different times, so a concurrent rotation racing to consume the same predecessor could previously surface as an unclassified `SessionRotationError` instead of the replay-detection error callers rely on to trigger security response.
