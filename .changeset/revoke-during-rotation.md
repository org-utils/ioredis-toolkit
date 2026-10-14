---
"ioredis-toolkit": patch
---

`revoke()` of a consumed credential no longer loses to a rotation of its successor that is running at the same time (#83).

- If rotation consumed the session at the end of the chain between `revoke()`'s read and its write, the revocation overwrote the consumed record. That erased its replay signal and its link, and the session that rotation created stayed active. The revocation now goes on to end that successor, and then puts back what it replaced.
- **Behaviour change:** if the revocation reaches a link whose successor the rotation has not created yet, it writes a revoked tombstone in that successor's place. The rotation then throws `SessionRotationError` instead of leaving an active session behind after the logout. A `rotate()` that runs at the same time as a logout can therefore now fail with `SessionRotationError`, its credential consumed.
- The revocation write stays unconditional, so concurrent touches still cannot hold a revocation off.
