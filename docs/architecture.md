# Redis package architecture

## Topology model

The package has three mutually exclusive Redis topologies:

- `standalone` — one Redis server, optional logical database selection.
- `sentinel` — ioredis Sentinel discovery/failover to one logical master.
- `cluster` — Redis Cluster hash-slot routing and cluster-safe fan-out helpers.

The configuration is a discriminated union. A cluster configuration cannot contain
Sentinel fields, Sentinel cannot contain cluster fields, and Cluster is restricted to
database `0` because Redis Cluster does not support `SELECT`.

`RedisConfigSchema` defaults an omitted mode to `standalone` and validates the final
configuration before any socket is created.

## Client architecture

`RedisClientWrapper` is the single internal transport implementation. Normal Redis
commands are deliberately topology-agnostic and are delegated to ioredis. ioredis
therefore owns connection recovery, Sentinel failover, MOVED/ASK handling, and normal
command routing.

`createRedisClient()` is the recommended public factory. Its overloads expose
cluster-only administrative capabilities only for a cluster configuration. The
standalone/Sentinel public type does not expose cluster helpers.

## Cluster rules

Cluster-specific code follows these rules:

1. Never inspect ioredis private slot maps.
2. Never call non-public `getSlot()` APIs.
3. Use the canonical Redis CRC16/XMODEM algorithm only for grouping keys locally.
4. Same-slot multi-key operations are issued through the cluster client so ioredis
   remains responsible for routing and topology changes.
5. Cross-slot fan-out is bounded by `maxFanOutConcurrency`.
6. Administrative scans visit primary nodes only and are never used in hot paths.
7. `SCAN` is used instead of `KEYS` for namespace maintenance.

## Atomicity

A multi-key Lua script is only atomic when every key is in the same Redis Cluster hash
slot. Applications that require atomic cross-key session operations must use a common
hash tag, for example `{userId}`.

Cross-slot operations in this package are explicitly treated as fan-out operations;
they are not advertised as atomic.

## Performance

- Single-key commands are O(1) wrapper overhead and remain fully routed by ioredis.
- Cluster `MGET`/`MSET` groups keys by hash slot and executes groups with bounded
  concurrency.
- Namespace deletion scans incrementally and deletes in bounded batches.
- No application-side connection pool is created on top of ioredis. ioredis already
  maintains the required connections for Cluster and Sentinel topologies.
- Read scaling is explicitly `master` by default so cache/session writes and reads
  have consistent semantics. Replica-read mode can be added as an opt-in later where
  eventual consistency is acceptable.

## Failure model

Connection failures are allowed to propagate as Redis errors. The package does not
silently convert infrastructure failures into cache misses, authentication success,
or false health positives.

Retry configuration is conservative. Retrying non-idempotent commands is delegated
to ioredis command semantics rather than implementing a second retry layer in this
package.

## Post-implementation review notes

The sections below record defects found during a second-pass architecture/security
review of the already-implemented session subsystem (per the "do not stop at tests
passing" requirement), and how they were resolved. Existing infrastructure and
session code were reused as-is wherever it was already correct; only the specific
defect below required a change.

### Fixed: user-index eviction did not reliably evict the oldest session

**Where:** `src/session/scripts/create.lua`, `rotate.lua`, `rotate-encrypted.lua`.

**Defect:** `maxSessionsPerUser` eviction (and the successor's index entry on
rotation) scored the user's session index ZSET with second-granularity
`createdAt`/`TIME()[1]`. Redis breaks ties on equal ZSET scores by lexicographic
order of the *member* (the session's jti - a random, unordered value), not by
insertion order. Any user creating (or rotating into) more than one session within
the same wall-clock second - an ordinary occurrence under real traffic, not a
contrived edge case - could have `ZRANGE index 0 n-1` evict a lexicographically-
arbitrary session instead of the actual oldest one. The cap itself was still
enforced correctly (session count never exceeded the limit), but the "oldest-first"
ordering guarantee described in the specification (§21-§22) silently did not hold.
This was caught by strengthening a previously-unasserted smoke-test observation
into a real assertion, plus a targeted `ioredis-mock` reproduction that confirmed
the tie-break behavior directly.

**Fix:** the eviction-ordering score is now computed inside the same atomic script
from `redis.call('TIME')` at microsecond resolution (`seconds + micros/1e6`)
instead of from the record's second-granularity `createdAt`. This is intentionally
*not* used as the record's `createdAt` field (which remains app-stamped seconds,
unaffected) - it exists solely as a strictly-ordered eviction key. Because Redis
executes commands (and Lua scripts) single-threaded, two scripts touching the same
user's hash-tagged slot can never observe the same `TIME()` reading in practice, so
this gives deterministic, clock-skew-free FIFO ordering per user without adding a
Redis round trip or any cross-slot state.

A corresponding test-harness defect was fixed alongside it: the `ioredis-mock` Lua
`TIME()` shim in `test/helpers/fake-redis.ts` hardcoded the microsecond component
to `'0'` on every call, which would have silently masked exactly this class of fix
under test (though not in production, where real Redis returns genuine increasing
microseconds). The shim now returns a monotonically incrementing counter for the
microsecond component so this property is actually exercised by the test suite.

**Residual risk:** none identified. The fix only changes an internal ordering key
used for eviction; it does not change the session record schema, does not affect
existing stored sessions (the score is recomputed on the next create/rotate for
that user), and does not weaken any of the security invariants in §1.
