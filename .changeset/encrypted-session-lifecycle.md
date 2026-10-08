---
"ioredis-toolkit": patch
---

Encrypted sessions can now be touched, updated, rotated and revoked. With `sessions.encryption.enabled: true` all four failed every time with `SessionStorageError: Redis script execution failed`, because the Lua scripts behind them tried to decode the encrypted record. A default-configured application that touches the session on each request failed on every request once encryption was on.

The record is now read, changed and re-encrypted by the application. `touch`, `update` and `rotate` write it through a script only if the stored value has not changed in the meantime; `revoke` writes unconditionally, so concurrent writers cannot hold a revocation off. An encrypted record stays encrypted through every operation and is re-encrypted under the current key on each write, and a record stored before encryption was switched on becomes encrypted the next time it is written. The stored envelope is unchanged, so existing plain and encrypted sessions read back as before.

What else changes:

- Each of the four operations reads the record once more before writing.
- `touch`, `update` or `rotate` that loses to concurrent writers on the same session 32 times in a row fails with `SessionStorageError` and leaves the record as it was.
- Simultaneous touches of one session at the same instant no longer each raise its `version`; the ones that lose the write find the expiry already extended and write nothing.
- The `touch_session`, `consume_session`, `revoke_session` and `update_session` scripts are gone from `SessionScriptRegistry`, replaced by `replace_session`.
