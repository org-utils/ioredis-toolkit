# Session State Machine

```text
ACTIVE ───────► CONSUMED
  │
  ├────────────► REVOKED
  │
  ▼
EXPIRED (derived by time)

any state ─────► DELETED (destroy, revokeAll, or Redis TTL)
```

### Rules

- `ACTIVE` is the only state that can authenticate.
- `CONSUMED` cannot authenticate and is retained only for bounded replay detection: a tombstone of at most 300 seconds, whose token locator is cut to expire with it.
- `REVOKED` cannot authenticate, and is retained as a tombstone the same way.
- Redis TTL may physically delete any state after its security usefulness ends.
- `destroy` is physical deletion and idempotent.
- `revoke` is logical denial and idempotent.
- `revoke` of a credential that `rotate` already consumed leaves it `CONSUMED`, so it keeps validating as `consumed` and replay of it is still reported. It follows the rotation chain forward from successor to successor and revokes the session at its end, if that one is still `ACTIVE` ([ADR-0004](https://github.com/org-utils/ioredis-toolkit/blob/main/docs/adr/0004-revoke-follows-the-rotation-chain-replay-only-reports.md)). Replay alone ends no session.
- `rotate` atomically consumes the predecessor before successor creation.
- A stale member of the user's session set cannot authenticate because validation requires active session state and current membership of the set.

## Operation semantics

| Operation | Source | Result | Atomicity | Retry |
|---|---|---|---|---|
| create | none | active | session + user's session set same-slot Lua, which also extends the set's TTL, stores the user's security version only if absent and extends its TTL to the set's, and, on eviction, deletes the evicted record and returns its token hash; the new token locator, and the deletion of evicted ones, are separate cross-slot writes; the script and the locator write each count a value they wrote themselves as written, so a step ioredis sends again succeeds ([Commands sent twice](./DEPLOYMENT.md#commands-sent-twice)) | not idempotent: a retry by the application creates a second session |
| validate | active candidate | read-only decision | two round trips: the token locator, then one same-slot read-only Lua of the record, its membership in the user's session set, the user's security version and Redis `TIME`, all seen at one instant | safe read retry by application |
| touch | active | active | same-key compare-and-set, worked out from the record and time validation read; leaves `version` unchanged | monotonic/idempotent effect |
| update | active | active | same-key compare-and-set + version; a stale `expectedVersion` throws `SessionConflictError` | safe only with version semantics |
| rotate | active | predecessor consumed + new active session | predecessor consume is an atomic same-key compare-and-set; a same-slot but separate `ZREM` then removes it from the user's session set (if interrupted, `list()` removes the member only once the tombstone has expired, and returns the tombstone until then); successor cross-slot write separate; a predecessor already consumed for this rotation's successor counts as consumed, so a step ioredis sends again succeeds ([Commands sent twice](./DEPLOYMENT.md#commands-sent-twice)) | not idempotent: a retry by the application is a replay |
| revoke | active/revoked, or consumed (acts on the end of its rotation chain) | revoked | reads follow a consumed record's forward links to the end of its rotation chain, then a script marks the record there unconditionally and returns what it replaced, which is put back if it was not active (see below); a link to a missing successor is filled with a revoked tombstone, only if absent; a same-slot but separate `ZREM` then removes it from the user's session set (if interrupted, `list()` removes the member only once the tombstone has expired, and returns the tombstone until then) | idempotent |
| destroy | any | deleted | individual writes | idempotent |
| revokeAll | user's session set | bounded deletion | the batch's token locators, in other slots, are deleted first through the cluster-aware delete; then one same-slot pipeline deletes their records and removes them from the user's session set | idempotent per batch |

### Compare-and-set

`touch`, `update` and the consume step of `rotate` change a stored record the same way: the application reads the record (`touch` uses the read its validation made), works out its replacement, and a script writes the replacement only if the stored value is still the one that was read. Redis never has to decode the record, so an encrypted record stays encrypted and is re-encrypted under the current key on every write.

A write that finds the stored value changed works its answer out again from the new value. An operation that loses 32 times in a row fails with `SessionStorageError` and leaves the record as it found it.

`revoke` is the exception: it writes the revoked record unconditionally, so concurrent writers cannot hold a revocation off. It needs no condition because it is a one-way transition, and because every other change is conditional on the value it read, none of them can turn a revoked record back into an active one.

The one thing an unconditional write could get wrong is the record it overwrites. `rotate` can consume the session between `revoke`'s read and its write, and a consumed record must stay consumed ([ADR-0004](https://github.com/org-utils/ioredis-toolkit/blob/main/docs/adr/0004-revoke-follows-the-rotation-chain-replay-only-reports.md)). So the write is a script that also returns the value it replaced. If that value was not active, `revoke` follows a consumed record's link on to the successor, and once that walk is over puts back what it replaced, conditional on a revocation's write still being there ([ADR-0005](https://github.com/org-utils/ioredis-toolkit/blob/main/docs/adr/0005-revoke-swaps-and-puts-back.md)).

`rotate` creates the successor after consuming its predecessor. `revoke` can therefore follow a link to a successor that does not exist yet. In that case it writes a revoked tombstone at the successor's key, only if nothing is there. The rotation's creation of the successor, which is also only-if-absent, then fails with `SessionRotationError`, instead of leaving the successor active after the logout.
