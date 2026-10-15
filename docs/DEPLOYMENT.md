# Deployment and Migration

## Rolling deployment

The serializer envelope contains a schema version. New application versions should continue reading the previous supported version during a rolling deployment. Add new fields rather than changing the meaning of existing fields in place — for example, `SessionRecord.idleTimeoutSeconds` (0.5.0) was added as a new optional field to preserve rotation/touch idle-window behavior, rather than repurposing an existing field. A record written by an older version simply omits it, and the serializer's schema validation treats it as optional.

Lua scripts are embedded and versioned with the package build. Every module that runs Lua (sessions, the lock and the rate limiter) goes through the kernel's script registry: `EVALSHA` is attempted first; after a `NOSCRIPT` response the exact source is sent with `EVAL`, allowing Redis restart/failover to recover without an external script preload step.

## Rollback

1. Keep old application binaries available until all new sessions are compatible with the old reader.
2. Do not remove old serializer support until the compatibility window closes.
3. Roll back application code before removing Redis key formats.
4. Clean stale token locators and session set members only with bounded maintenance jobs.

## Disaster recovery

Redis authentication state is security-sensitive. Restoring an old RDB/AOF snapshot can resurrect sessions or undo revocations that happened after the snapshot. Treat restore as a security event and invalidate the affected authentication state using an authoritative security-version mechanism at the application/platform level.

## Sentinel failover

A Sentinel failover, even a graceful `SENTINEL FAILOVER`, never pauses or demotes the old master before promoting its replica. The old master goes on answering writes with `OK` until Sentinel demotes it, about 10 s later, and then resyncs from the new master, dropping every write it took after the promotion. No call fails for those writes, so nothing reports the loss.

The package turns on ioredis's `failoverDetector` for Sentinel, which ioredis leaves off. Each connection then also subscribes to `+switch-master` on the sentinels and reconnects to the new master as soon as the switch is announced; commands it had sent and not yet had answered are sent again once it reconnects. This leaves only the time between the promotion and the announcement, about a second, while Sentinel waits for the promoted replica to report its new role. Measured on Redis 8 with a write every 10 ms ([#121](https://github.com/org-utils/ioredis-toolkit/issues/121)), a graceful failover lost about 950 of 1,070 acknowledged writes with the detector off, and 70 to 80 with it on, all from that second.

- **What can be lost.** Any write: cache entries, lock acquisitions, rate-limit counts, and session changes, a revocation included. A revocation lost this way leaves the session able to authenticate, so when that matters, treat a failover like the snapshot restore under [Disaster recovery](#disaster-recovery).
- **Closing the window.** No client setting can. `min-replicas-to-write 1` with a small `min-replicas-max-lag` on the master makes the old master refuse writes within that lag once its replica has left it. An application can also send `WAIT 1 <timeout>` after a write it cannot lose, and treat a `0` reply as not stored.
- **Connections.** Every connection the client opens also subscribes on up to `sentinelMaxConnections` sentinels (ioredis's default is 10): the shared connection, the Pub/Sub subscriber and each pooled stream reader. With three sentinels, a client with a subscriber and two stream readers holds 12 sentinel connections. Lower `sentinelMaxConnections` to subscribe on fewer.
- **Turning it off.** Pass `failoverDetector: false` to keep ioredis's own behaviour, for example where sentinel connections are scarce.

## Memory policy

Authentication state should not use an arbitrary eviction policy. `noeviction` is used in the included disposable test environments so memory pressure fails writes instead of silently evicting authentication records. Production capacity and failover requirements must be validated independently.
