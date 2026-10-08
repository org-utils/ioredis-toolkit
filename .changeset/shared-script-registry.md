---
"ioredis-toolkit": patch
---

Lock and rate-limit calls now run their Lua by cached SHA. `lock.release()`, `lock.extend()` and `rateLimiter.consume()` used to send the whole script body on every call; they now send its SHA-1, and send the source again only when the server answers `NOSCRIPT` (first use, a restart, a failover, `SCRIPT FLUSH`).

Sessions already worked this way. The registry that does it now lives in the kernel and all three modules share it. No behaviour changes: results and errors are what they were.
