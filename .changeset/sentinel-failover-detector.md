---
"ioredis-toolkit": minor
---

On Sentinel, the client now turns on ioredis's `failoverDetector` by default (#121). Before, a failover, even a graceful `SENTINEL FAILOVER`, left every connection on the old master until Sentinel demoted it about 10 s later, and each write the old master acknowledged meanwhile was silently lost. Now each connection moves to the new master as soon as Sentinel announces the switch, so only writes from the second or so before the announcement can be lost. Each connection also subscribes on up to `sentinelMaxConnections` sentinels; pass `failoverDetector: false` to keep the previous behaviour. `docs/DEPLOYMENT.md` explains the remaining window and how to close it on the server.
