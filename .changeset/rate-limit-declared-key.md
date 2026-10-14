---
"ioredis-toolkit": patch
---

The rate limiter's scripts touch only the key they declare. Each subject's windows were counted under a key the script built itself from the declared one (`rate-limit:{user:42}:<window>`), which worked on Redis and Redis Cluster only because the hash tag kept it in the same slot, and is outside Redis's scripting contract. Servers and proxies that enforce declared keys rejected or misrouted it.

- **The counter key layout changes again.** A subject now has one key, `rate-limit:{user:42}`: a hash holding the number of the window it counts and that window's count. A new window starts the count again. `consume()` and `check()` are still one round trip, and `reset()` is now one instead of two. Windows in progress during an upgrade start again from zero once; keys written by earlier versions are not read again and expire at the end of their window.
- **`key(subject)` returns the subject's key.** `key(subject, serverSeconds)` is deprecated: the second argument is still accepted and has no effect.
