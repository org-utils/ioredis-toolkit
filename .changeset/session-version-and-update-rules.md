---
"ioredis-toolkit": patch
---

**`touch()` no longer increments a session's `version`.** `version` now counts only the changes an application can see: `update()` and status changes such as rotation and revocation. Code that expected a touch to bump `version` must change. In return, a background touch no longer makes an `update()` that carries the version read before it fail.

A version mismatch in `update()` now always throws `SessionConflictError` (code `SESSION_CONFLICT`). Before, a writer that lost the race at the store got `SessionStorageError` instead. The patch is applied to the record as stored when it is written, so a touch that landed in between is kept.

`update()` now follows the same rules as `create()` for client details. `ipAddress`, `userAgent` and `deviceId` are stored only when `storeIpAddress`, `storeUserAgent` and `storeDeviceId` are on, and are otherwise ignored. They are capped at 128, 1024 and 256 characters, and a longer value throws `SessionInvalidError`. Before, `update()` stored them whatever the flags said, with no length limit.
