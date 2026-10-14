---
"ioredis-toolkit": patch
---

`revoke()` given a credential that rotation already consumed now ends its successor, the session that replaced it, so a user logging out with a stale cookie is logged out (#81).

- It follows the rotation chain from successor to successor and revokes the session at its end, if that one is still active.
- **Behaviour change:** the consumed credential itself is left as it is. It keeps validating as `consumed`, and `rotate()` on it keeps throwing `SessionReplayError`. Before, `revoke()` rewrote it as `revoked`, which hid the replay signal and restarted its tombstone's 300-second cap.
- Replay on its own still ends no session. To end every session of a user on `SessionReplayError`, call `revokeAll()` or bump the security version.
- A consumed session's record now holds `successorId` and `successorJti`, linking it to its successor. Sessions consumed by an earlier release have no link, so revoking their credential ends nothing.
