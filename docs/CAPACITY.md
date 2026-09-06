# Capacity Planning

Exact Redis memory depends heavily on allocator overhead, key length, metadata, replication, and encryption envelope size. The following is an engineering sizing method rather than a promise of exact bytes.

## Per-session components

Approximate:

- Session key: namespace + fixed prefixes + 64-byte token hash + user hash tag.
- User-index member: 64-byte token hash plus sorted-set overhead.
- Serialized record: fixed fields plus bounded metadata.
- Token locator: token hash key + 64-byte token hash + user tag value.
- Redis object/allocator overhead: measure with the target Redis version and representative payloads.
- Replication: multiply by replica count.
- Fragmentation/headroom: reserve operational margin; do not size to `maxmemory` exactly.

## Required benchmark

Before production sizing, create representative sessions with the largest expected metadata, then measure `MEMORY USAGE` for each key family and extrapolate to:

- 1 million sessions
- 10 million sessions
- 50 million sessions

Include token indexes, user indexes, replication, AOF/RDB overhead, allocator fragmentation, and peak write amplification.

## Operational limits

The package defaults to 8 KiB session metadata, 200-item batches, concurrency 8, and 20 sessions per user. These are conservative defaults, not universal production limits. Increase them only after load testing.

A per-user hash tag intentionally concentrates one user's session state on one slot. Extremely active users can become hot keys/slots; solving that requires a separate sharded-user design and would weaken the simple same-user atomicity model.

Sessions evicted by `maxSessionsPerUser` now have their physical session and token-index keys deleted immediately at eviction time, rather than only being removed from the user index and left to expire on their own TTL. Under high per-user session churn this makes actual Redis memory usage track the configured cap more closely instead of transiently overshooting it by up to one full session TTL's worth of orphaned keys per evicted session.
