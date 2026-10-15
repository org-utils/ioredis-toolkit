# ioredis-toolkit

Redis-backed session management for Node.js, together with the connection substrate that sessions needed and a small set of wrappers over that substrate. The package name says "toolkit"; the shape of the code says "session kit with its substrate exposed", and the latter is the one we mean.

## Language

### Parts of the package

**Kernel**:
The shared Redis substrate every other part is built on: connection, the command wrapper, cluster helpers, key strategy, script registry, clock, config base, error base. Lives in `src/redis/`. The kernel never knows what is built on top of it.
_Avoid_: core, common, shared, utils, base

**Product module**:
A part of the package that carries real domain logic and is worth defending as a product. Today there is exactly one: `session`.
_Avoid_: feature, main module

**Convenience wrapper**:
A thin module over the kernel offering a common Redis pattern with no domain logic of its own: `cache`, `lock`, `rate-limit`, `pubsub`, `streams`. Best-effort surface, deliberately shallow, and never a dependency of a product module.
_Avoid_: peer module, sub-package, helper module

**Client facade**:
The single composition root that wires the kernel to the modules and hands the consumer a configured client. Lives in `src/client-facade.ts`, above the kernel and never inside it, so that the dependency graph stays a star with the kernel as its sink.
_Avoid_: registry, container, factory (a factory builds one thing; the facade wires everything)

### The public boundary

**Public surface**:
The set of names a consumer is entitled to hold: module classes, their config/input/result types, the error hierarchy (the `RedisToolkitError` base, the `Session*Error` classes, each convenience wrapper's error, and their code unions), the factory functions, and the `parse*Config` functions. Everything else is internal, including every class that a facade constructs on the consumer's behalf and every validation schema object.
_Avoid_: API, exports (both describe the mechanism, not the entitlement)

**Internal**:
Anything reachable in the source but not part of the public surface. Being importable is not the same as being supported; internals may change in any release.
_Avoid_: private, experimental

**Entry point**:
The one file through which a module is imported: `src/<module>/index.ts`, exporting the module's class together with its public types. Every subpath in the exports map resolves to one; the kernel's serves the package only and has no subpath.
_Avoid_: barrel (there is one barrel, the root), main file, index

**Supported runtime**:
A JavaScript runtime the package is tested on and whose failures are fixed as bugs; today only Node.js. A runtime the package is merely known to work on is not supported.
_Avoid_: platform, environment

### Keys and time

**Namespace**:
The configured prefix that scopes one module's keys within a Redis instance, and the first segment of every key that module writes. One namespace concept across the whole package, not one per module.
_Avoid_: keyPrefix, channelPrefix, scope

**Authoritative time**:
Redis server time. It is the only clock permitted for anything that expires, buckets, or orders state shared across processes. Local clocks measure local durations and nothing else.
_Avoid_: now, wall clock, system time

### Sessions

**Session**:
The unit of an authenticated identity's continued access, held as a record in Redis and presented by a bearer credential. The record is authoritative; the credential is only a way to name it.
_Avoid_: login, auth session, user session

**User's session set**:
The per-user collection of every session a user currently holds, through which a user's sessions are listed, bounded and ended together. A session absent from its user's session set cannot authenticate.
_Avoid_: index, user index, authorization index

**Token locator**:
The pointer from a credential to the user it belongs to, so that a session can be found from its credential alone.
_Avoid_: index, token index

**Rotation**:
Replacing a session with a successor that carries the same identity under a new credential, consuming the session it replaces.
_Avoid_: refresh, renewal, reissue

**Successor**:
The session a rotation creates in place of the one it consumes; that consumed session is its predecessor.
_Avoid_: child, next session, new session

**Rotation chain**:
The sessions linked predecessor to successor by successive rotations. It never branches, and only the session at its end can be active.
_Avoid_: family, token family, lineage

**Consumed**:
The final state of a session that rotation has replaced. A consumed session never authenticates again and never changes state again.
_Avoid_: used, spent, rotated, superseded

**Replay**:
Presenting the credential of a consumed session.
_Avoid_: reuse, theft (theft is one cause of replay, not the thing itself)

**Revoke**:
To end a session on purpose before it expires, leaving a tombstone.
_Avoid_: invalidate, kill, logout (logout is the application's act; revoke is what it asks of the session)

**Revoked**:
The final state of a session ended by revocation. A revoked session never authenticates again and never changes state again.
_Avoid_: invalidated, cancelled

**Destroy**:
To remove a session without leaving a tombstone, so its credential afterwards reads as one that never existed.
_Avoid_: delete, purge, revoke (revoking leaves a tombstone; destroying does not)

**Tombstone**:
What a consumed or revoked session leaves behind for a bounded time, so that its credential reports why it cannot authenticate rather than reading as unknown.
_Avoid_: marker, revocation record, revocation tombstone (the JTI revocation store's markers are not tombstones of sessions)
