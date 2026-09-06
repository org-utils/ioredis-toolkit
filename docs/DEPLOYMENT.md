# Deployment and Migration

## Rolling deployment

The serializer envelope contains a schema version. New application versions should continue reading the previous supported version during a rolling deployment. Add new fields rather than changing the meaning of existing fields in place — for example, `SessionRecord.idleTimeoutSeconds` (0.5.0) was added as a new optional field to preserve rotation/touch idle-window behavior, rather than repurposing an existing field. A record written by an older version simply omits it, and the serializer's schema validation treats it as optional.

Lua scripts are embedded and versioned with the package build. `EVALSHA` is attempted first; after a `NOSCRIPT` response the exact source is sent with `EVAL`, allowing Redis restart/failover to recover without an external script preload step.

## Rollback

1. Keep old application binaries available until all new sessions are compatible with the old reader.
2. Do not remove old serializer support until the compatibility window closes.
3. Roll back application code before removing Redis key formats.
4. Clean obsolete indexes only with bounded maintenance jobs.

## Disaster recovery

Redis authentication state is security-sensitive. Restoring an old RDB/AOF snapshot can resurrect sessions or undo revocations that happened after the snapshot. Treat restore as a security event and invalidate the affected authentication state using an authoritative security-version mechanism at the application/platform level.

## Memory policy

Authentication state should not use an arbitrary eviction policy. `noeviction` is used in the included disposable test environments so memory pressure fails writes instead of silently evicting authentication records. Production capacity and failover requirements must be validated independently.
