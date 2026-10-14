---
"ioredis-toolkit": patch
---

Rotating or revoking a session no longer leaves its token locator alive for the rest of the original session lifetime. The token locator is the key that maps a credential to its user. Its TTL is now cut to that of the session's tombstone: the rest of the session's lifetime, capped at 300 seconds. While the tombstone lasts, a replayed credential is still reported as `consumed` and a revoked one as `revoked`. After that, both report `not_found` and neither key remains. Frequent rotation no longer leaves thousands of dead keys per active user.
