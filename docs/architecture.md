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

### Added: token-family reuse detection on rotation (§5)

**Where:** `src/session/scripts/rotate.lua`, `rotate-encrypted.lua`,
`session-repository.ts`, `session-service.ts`, `session-config.ts`
(`revokeFamilyOnReplay`), `session-types.ts`/`session-serializer.ts`
(`familyId`/`fam`).

**Gap:** the specification (§5) asks for rotation to "prefer family-level
invalidation for stolen refresh-token reuse when appropriate" and to model
token lineage explicitly (`familyId`, `parentId`, `generation`, ...). The
prior implementation only rejected a replayed (already-consumed) token; it
never responded to the stronger signal that a *replay* of an old,
already-rotated-past token represents — namely, that whoever replayed it
may have captured it in transit or from storage, and may equally have
captured (or go on to capture) whatever the lineage has since rotated
into. Rejecting only the one replayed request leaves that live successor
session usable by the same attacker.

**Design:** every `SessionRecord` now carries an immutable `familyId`,
equal to the first generation's own jti and unchanged across every
rotation of that lineage (self-healing for legacy pre-migration records
missing it: they adopt their own jti as their familyId the first time
they're read/rotated). A same-slot `family-head:{userId}:{familyId}`
pointer key tracks the jti of the lineage's currently active generation,
advanced atomically on every successful rotation. When rotate() is called
with an already-consumed session token and the request is *not* a
same-nonce idempotent retry of a rotation that already succeeded (the
existing `rotationNonce` retry-safety mechanism - see §73 - already
handles that case correctly and is checked first), that's treated as a
genuine replay: the script atomically revokes whatever the family head
currently points to and clears the pointer, so the entire lineage dies in
one atomic same-slot operation rather than only the replayed request
being rejected.

This mirrors the existing max-session-eviction and rotation Lua scripts:
the decision is made authoritatively inside the atomic script from its
own read, never from an application-side preliminary GET (§78). For the
encrypted path, where Lua cannot decode the ciphertext, the same decision
is made from a plaintext `fam` header mirror (alongside the
already-existing `st`/`ver`/`rn`/`rj` mirrors), and `assertHeaderMatches`
cross-checks it against the decrypted record on every read so a
mismatched mirror fails closed instead of silently mislabeling a
lineage.

**Configuration:** off by default (`revokeFamilyOnReplay: false`),
consistent with every other opt-in feature in this config (`jtiIndex`,
`checkRevocationStore`, `circuitBreaker`) - a library default should not
enable a destructive, cross-session security response implicitly. It
requires `retainConsumedTombstones: true` (enforced by a `superRefine`),
since a replay can only be detected while a consumed tombstone still
exists to be replayed against.

**Failure classification:** surfaces as `SessionReplayError({ reason:
'family_revoked', familyId, headJtiRevoked? })`, not
`SessionStorageError` - it is a business/security outcome decided by a
successful, correctly-functioning Redis operation, not an infrastructure
failure, so it must never trip the circuit breaker (§31, §70). This
matches how every other rotation rejection (already-consumed,
expired, version-conflict) is already classified.

**Residual risk:** a legitimate client that retries a rotation with a
*different* nonce (or no nonce) after actually receiving and discarding a
successful response - i.e. a client bug, not a lost-response retry -
would trigger this and lose its whole session lineage rather than just
the one request. This is judged an acceptable trade-off for an opt-in,
security-preferred setting (the specification explicitly prefers
family-level invalidation "when appropriate"), and is exactly why the
feature defaults to off and its rejection of the pattern is called out
distinctly (`SessionReplayError` vs `SessionRevokedError`) so an operator
enabling it can monitor `family_revoked` occurrences before relying on
it.

### Added: bounded per-user jti-index reconciliation (§25/§67/§68)

**Where:** `SessionRepository.reconcileUser`, `SessionService.reconcileUser`,
`SessionMetrics.reconcileUser`.

The specification explicitly allows (§67) "an optional repair API may
rebuild index from known session state" for the global jti index, and
separately (§68) describes optional bounded `reconcileUser(userId)` /
`cleanupUserIndex(userId)` administrative operations. Neither existed.
`reconcileUser(userId)` closes this gap: bounded by the same
`maxSessionsPerUserHardCap` limit as `revokeAll`/`deleteByUser`, it (a)
prunes user-index entries whose session record no longer exists (the same
lazy self-heal `findByUser`/`validate`/`touch` already perform, just
triggered proactively) and (b) - only when `jtiIndex.enabled` - rewrites
the jti-index entry for any live **active** session whose entry is
missing or stale, deliberately skipping consumed/revoked sessions so a
repair pass can never make an invalid session JTI-lookupable again. It is
not required for authentication correctness (userId-aware lookup is
always authoritative, per the invariant in §67 that "the actual session
record remains authoritative"); it exists to shrink the window during
which JTI-only lookup can miss a live session after a partial write, and
to give operators an explicit repair tool after a known incident instead
of waiting for random self-heal to eventually hit the same drift.

