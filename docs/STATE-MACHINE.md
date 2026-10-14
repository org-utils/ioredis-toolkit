# Session State Machine

```text
ACTIVE ───────► CONSUMED
  │                │
  │                ▼
  └────────────► REVOKED
  │
  ▼
EXPIRED (derived by time)
  │
  ▼
DELETED (physical cleanup)
```

### Rules

- `ACTIVE` is the only state that can authenticate.
- `CONSUMED` cannot authenticate and is retained only for bounded replay detection: a tombstone of at most 300 seconds, whose token locator is cut to expire with it.
- `REVOKED` cannot authenticate, and is retained as a tombstone the same way.
- Redis TTL may physically delete any state after its security usefulness ends.
- `destroy` is physical deletion and idempotent.
- `revoke` is logical denial and idempotent.
- `revoke` of a credential that `rotate` already consumed rewrites its tombstone as `REVOKED` and restarts its expiry, still capped at 300 seconds, so that credential then validates as `revoked` rather than `consumed`. Its successor stays `ACTIVE`. Whether that should change is open in #81.
- `rotate` atomically consumes the predecessor before successor creation.
- A stale member of the user's session set cannot authenticate because validation requires active session state and current membership of the set.

## Operation semantics

| Operation | Source | Result | Atomicity | Retry |
|---|---|---|---|---|
| create | none | active | session + user's session set same-slot Lua, which also extends the set's TTL and, on eviction, deletes the evicted record and returns its token hash; the new token locator, and the deletion of evicted ones, are separate cross-slot writes | not idempotent |
| validate | active candidate | read-only decision | two round trips: the token locator, then one same-slot read-only Lua of the record, its membership in the user's session set, the user's security version and Redis `TIME`, all seen at one instant | safe read retry by application |
| touch | active | active | same-key compare-and-set, worked out from the record and time validation read; leaves `version` unchanged | monotonic/idempotent effect |
| update | active | active | same-key compare-and-set + version; a stale `expectedVersion` throws `SessionConflictError` | safe only with version semantics |
| rotate | active | predecessor consumed + new active session | predecessor consume is an atomic same-key compare-and-set; a same-slot but separate `ZREM` then removes it from the user's session set (self-heals via `list()` if interrupted); successor cross-slot write separate | not inherently idempotent |
| revoke | active/revoked | revoked/deleted | an unconditional same-key write marks the record; a same-slot but separate `ZREM` then removes it from the user's session set (self-heals via `list()` if interrupted) | idempotent |
| destroy | any | deleted | individual writes | idempotent |
| revokeAll | user's session set | bounded deletion | the batch's token locators, in other slots, are deleted first through the cluster-aware delete; then one same-slot pipeline deletes their records and removes them from the user's session set | idempotent per batch |

### Compare-and-set

`touch`, `update` and the consume step of `rotate` change a stored record the same way: the application reads the record (`touch` uses the read its validation made), works out its replacement, and a script writes the replacement only if the stored value is still the one that was read. Redis never has to decode the record, so an encrypted record stays encrypted and is re-encrypted under the current key on every write.

A write that finds the stored value changed works its answer out again from the new value. An operation that loses 32 times in a row fails with `SessionStorageError` and leaves the record as it found it.

`revoke` is the exception: it writes the revoked record unconditionally, so concurrent writers cannot hold a revocation off. It needs no condition because it is a one-way transition, and because every other change is conditional on the value it read, none of them can turn a revoked record back into an active one.
