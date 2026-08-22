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
