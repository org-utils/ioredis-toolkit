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

> The remaining session vocabulary — rotation, consume, replay, tombstone, revoke, the two distinct meanings of "index" — is known to be contested in the current code and has not been resolved yet. It is deliberately absent here rather than guessed at.
