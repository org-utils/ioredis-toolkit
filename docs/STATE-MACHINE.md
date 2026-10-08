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
- `CONSUMED` cannot authenticate and is retained only for bounded replay detection.
- `REVOKED` cannot authenticate.
- Redis TTL may physically delete any state after its security usefulness ends.
- `destroy` is physical deletion and idempotent.
- `revoke` is logical denial and idempotent.
- `rotate` atomically consumes the predecessor before successor creation.
- A stale user-index member cannot authenticate because validation requires active session state and current index membership.

## Operation semantics

| Operation | Source | Result | Atomicity | Retry |
|---|---|---|---|---|
| create | none | active | session + user index same-slot Lua; on eviction, also same-slot `DEL` of the evicted session/token-index keys; token locator is a separate, cross-slot secondary write | not idempotent |
| validate | active candidate | read-only decision | no transaction needed | safe read retry by application |
| touch | active | active | same-key compare-and-set | monotonic/idempotent effect |
| update | active | active | same-key compare-and-set + version | safe only with version semantics |
| rotate | active | predecessor consumed + new active session | predecessor consume is an atomic same-key compare-and-set; a same-slot but separate `ZREM` then removes it from the user index (self-heals via `list()` if interrupted); successor cross-slot write separate | not inherently idempotent |
| revoke | active/revoked | revoked/deleted | an unconditional same-key write marks the record; a same-slot but separate `ZREM` then removes it from the user index (self-heals via `list()` if interrupted) | idempotent |
| destroy | any | deleted | individual writes | idempotent |
| revokeAll | user index | bounded deletion | bounded per-user pipeline | idempotent per batch |

### Compare-and-set

`touch`, `update` and the consume step of `rotate` change a stored record the same way: the application reads the record, works out its replacement, and a script writes the replacement only if the stored value is still the one that was read. Redis never has to decode the record, so an encrypted record stays encrypted and is re-encrypted under the current key on every write.

A write that finds the stored value changed works its answer out again from the new value. An operation that loses 32 times in a row fails with `SessionStorageError` and leaves the record as it found it.

`revoke` is the exception: it writes the revoked record unconditionally, so concurrent writers cannot hold a revocation off. It needs no condition because it is a one-way transition, and because every other change is conditional on the value it read, none of them can turn a revoked record back into an active one.
