---
"ioredis-toolkit": patch
---

A smaller tarball, and the documented limits of the lock and of rolling sessions.

- The published package no longer carries `docs/agents/` or `docs/ACCEPTANCE-REPORT.md`, which are for the repository's maintainers.
- The lock guide now states that the lock runs on a single Redis node, so a failover can briefly allow two holders, and that it issues no fencing token.
- The sessions guide now states that `rolling` extends only the idle expiry, never the hard `ttl`.
