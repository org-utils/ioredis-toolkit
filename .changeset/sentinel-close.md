---
"ioredis-toolkit": patch
---

`close()` on a Sentinel client now closes the failover detector's connections to the sentinels, so a process that only waits for its work to finish exits again (#125). Since 1.2.0 turned the detector on, ioredis's `quit()` left those connections open on the shared connection and the Pub/Sub subscriber.
