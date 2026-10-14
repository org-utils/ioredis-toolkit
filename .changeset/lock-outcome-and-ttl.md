---
"ioredis-toolkit": patch
---

`lock.using()` now always resolves with the callback's result, or rejects with the callback's error, even when releasing the lock fails. Before, a release failure, such as a Redis blip after the work had finished, replaced the real outcome. The release failure now goes to the `onError` hook with source `lock-release`, and the lock lapses at the end of its TTL.

`acquire()` and `extend()` reject more bad TTLs with `LockError` code `LOCK_INPUT`, before contacting Redis: `NaN`, which used to reach Redis as `PX NaN`; `Infinity`, which used to report `LOCK_LIMIT`; and any TTL that is not a whole number of milliseconds, such as `0.0001`. `LOCK_LIMIT` and `LOCK_HELD` behave as before.
