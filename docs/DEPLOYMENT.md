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

## Cluster failover

Redis Cluster also replicates asynchronously, and each master's slots fail over on their own. What a failover can lose depends on how it happens:

- **Manual failover.** A `CLUSTER FAILOVER` without `FORCE` or `TAKEOVER` pauses the master's clients until its replica has caught up, then promotes the replica and has the old master answer `MOVED`. [Redis documents it](https://redis.io/docs/latest/commands/cluster-failover/) as losing nothing.
- **Crashed master or forced failover.** A master that crashes, or one failed over with `FORCE` or `TAKEOVER`, loses the writes it acknowledged and had not yet replicated. Neither option waits for the master, so one still running also loses whatever it acknowledges until it learns of the promotion.
- **Partition.** A master cut off from the majority of masters goes on acknowledging writes until `cluster-node-timeout` (15 s by default) has passed, and only then refuses them. Once its replica on the majority side is promoted, every write it acknowledged since it was cut off is lost: it rejoins as the new master's replica and resyncs from it. No call fails for those writes.

`failoverDetector` is a Sentinel setting, and a Cluster connection has nothing like it. Unless `slotsRefreshInterval` is set (its typings give a default of 5000, but ioredis 6 sets none), ioredis's Cluster client learns of a failover only from the replies to its own commands. A `MOVED` reply sends the command again to the node it names and refreshes the slot map, so once the promoted replica owns the slots, commands follow it there. A `CLUSTERDOWN` reply, or a closed connection while the cluster is ready, sends the command again after 100 ms (`retryDelayOnFailover`, `retryDelayOnClusterDown`) and refreshes the slot map. A command is rejected after 16 such retries (`maxRedirections`), and one sent to a node that stops answering without closing the connection waits unless `commandTimeout` is set.

So a write sent while its master is down either reaches the promoted replica, fails, or waits; it is not lost without a trace. What a failover loses silently is what the master acknowledged and never replicated. A client cut off together with the master learns nothing, since that master still answers for its slots, so no client setting shortens that window.

None of this has been measured. The package's test cluster has three masters and no replicas, and no test fails a master over (see [What CI runs](./TESTING.md#what-ci-runs)), so how much a Cluster failover loses is not known, and the Sentinel numbers above do not carry over.

- **What can be lost.** The same writes as under Sentinel, for the keys in the failed master's slots: cache entries, lock acquisitions, rate-limit counts, and session changes, a revocation included. Treat a lost revocation like the snapshot restore under [Disaster recovery](#disaster-recovery).
- **Closing the window.** The same settings apply, on each master. `min-replicas-to-write 1` with a small `min-replicas-max-lag` makes a master cut off from its replica refuse writes, with a `NOREPLICAS` error, within that lag instead of after `cluster-node-timeout`. A replica just promoted has no replica of its own until the old master rejoins or another replica moves to it, and refuses writes to its slots until then, so give each master two replicas.
- **`WAIT` on Cluster.** `WAIT` counts the replicas that have the writes sent before it on the same connection. It names no key, so a Cluster connection sends it to a random master, which says nothing about the write. Send it to the master that took the write instead: create the connection with `createRedisConnection`, pass it to `new RedisClient`, send `WAIT` to each of its `nodes('master')`, which are the connections the client's commands go through, and treat a `0` from any of them as not stored. A connection opened separately, `duplicate()` included, has sent no writes, so `WAIT` on it answers at once and proves nothing.

## Memory policy

Authentication state should not use an arbitrary eviction policy. `noeviction` is used in the included disposable test environments so memory pressure fails writes instead of silently evicting authentication records. Production capacity and failover requirements must be validated independently.
