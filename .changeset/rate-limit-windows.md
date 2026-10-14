---
"ioredis-toolkit": patch
---

Rate-limit windows now always expire, and the times the limiter reports are exact.

- A window's counter expires when the window ends, whatever the cost of its first request. Before, a window whose first request cost more than 1 never expired.
- `resetAt` is the window's end, `(window + 1) × windowSeconds` in Redis server time. `retryAfterSeconds` is the time from now until that end when a request is denied, and `0` otherwise. Before, both could overstate the wait by up to 2×. `check()` reports the same boundaries as `consume()`.
- `consume()` and `check()` read Redis server time inside their script, so each is one round trip instead of two (three for `check()`).

**The counter key layout changes.** The subject is now the key's Redis Cluster hash tag: `rate-limit:{user:42}:2` instead of `rate-limit:user:42:2`. All of a subject's windows share one hash slot, which is what lets one script read the clock and pick the window on Cluster. `key(subject, serverSeconds)` returns the new form. Windows in progress during an upgrade start again from zero once, and counters written by earlier versions are not read again. A subject that is empty or starts with `}` would leave the hash tag empty, so it now throws `RateLimitError` with `RATE_LIMIT_INPUT`.

The rate-limit docs now state that requests near a window boundary can briefly reach up to twice the limit, and that denied requests still count against the window.
