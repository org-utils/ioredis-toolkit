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
| touch | active | active | same-key Lua | monotonic/idempotent effect |
| update | active | active | same-key Lua + version | safe only with version semantics |
| rotate | active | predecessor consumed + new active session | predecessor Lua consume is atomic; a same-slot but separate `ZREM` then removes it from the user index (self-heals via `list()` if interrupted); successor cross-slot write separate | not inherently idempotent |
| revoke | active/revoked | revoked/deleted | same-key Lua marks the record; a same-slot but separate `ZREM` then removes it from the user index (self-heals via `list()` if interrupted) | idempotent |
| destroy | any | deleted | individual writes | idempotent |
| revokeAll | user index | bounded deletion | bounded per-user pipeline | idempotent per batch |
