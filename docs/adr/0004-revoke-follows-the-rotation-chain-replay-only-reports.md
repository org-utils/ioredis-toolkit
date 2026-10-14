# Revoke follows the rotation chain; replay only reports

`revoke()` of a credential that rotation had already consumed rewrote its tombstone as `revoked`, which erased the replay evidence, and left the successor active, so a user logging out with a stale cookie stayed logged in (#81). We decided that a consumed session stays consumed, and that revoking its credential ends the session at the end of its rotation chain instead. To make that possible, a consumed session records a forward link to its successor. Replay of a consumed credential keeps raising `SessionReplayError` and ends nothing. There is no grace window during which a just-consumed credential still validates.

## Considered Options

- **Replay ends the whole rotation chain**, as the OAuth refresh-token reuse-detection practice does. Rejected because two tabs or requests rotating concurrently look exactly like replay, so this would log out legitimate users. The only cure is a grace window, which costs the replay signal its precision and adds state. Applications that want this policy can catch `SessionReplayError` and end the user's sessions themselves, through `revokeAll()` or a security version bump.
- **A concurrent-rotation grace window.** Rejected for now: it only becomes necessary if replay ends sessions, and it weakens replay detection for every caller in order to serve some of them.
- **Keep marking a consumed credential revoked.** Rejected: it overwrote the one signal that a credential was being replayed and did not achieve the logout anyway.

## Consequences

The walk along the chain has no fixed cap, only a guard against a link back to a session already passed, which only corrupt data could hold: a cap low enough to matter would stop the logout of an application that rotates on every request. The walk is bounded by tombstone life instead. A consumed tombstone lives at most 300 seconds, and rotation gives a successor its predecessor's expiry. So if a link has expired, the session it led to has also expired, and there is nothing to revoke. If successor creation failed after the predecessor was consumed, the link leads nowhere, and revoke ends nothing.

_Amended by [ADR-0005](0005-revoke-swaps-and-puts-back.md): where a link leads to a successor that does not exist, revoke now writes a revoked tombstone at the successor's key, only if the key is absent, so that a rotation still creating that successor fails._
