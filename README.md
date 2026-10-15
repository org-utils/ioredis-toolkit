# ioredis-toolkit

Production-oriented Redis infrastructure for Node.js 22+ and TypeScript, built around one shared Redis connection boundary.

## Modules

- Sessions — opaque credentials, rotation, revocation, idle/absolute expiry.
- Cache — JSON cache with TTL and conditional writes.
- Lock — ownership-token distributed leases.
- Rate limiting — atomic fixed-window counters.
- Pub/Sub — JSON fan-out over a dedicated subscriber connection.
- Streams — append, consumer groups, reads and acknowledgements.

## One client, all configuration

Every module can be configured in the same `createRedisClient()` call. Module configuration is optional and normalized independently.

Each module defaults to `enabled: false`. Accessing a module's getter on the client (`redis.cache`, `redis.lock`, `redis.rateLimiter`, `redis.pubsub`, `redis.streams`, `redis.sessions`) throws while it is disabled — set `enabled: true` in that module's configuration to use it.

`createRedisClient()` validates the whole configuration before it connects, and throws on a mistake. A connection configuration it cannot accept, an unknown `mode` for example, throws `RedisConfigurationError`. A module section that fails validation throws that module's own error with its configuration code: `CacheError` with `CACHE_CONFIGURATION`, `LockError` with `LOCK_CONFIGURATION`, `SessionConfigurationError` for sessions, and so on. Two enabled modules whose namespaces collide throw `RedisConfigurationError`. Namespaces collide when they are equal or when one is a colon-delimited prefix of the other: `app` and `app:cache` collide, `app` and `application` do not. Without that rule one module could read, overwrite or clear another's keys, as `cache.clear()` on a namespace shared with sessions would. A disabled module's namespace is not checked. Each `with*()` call applies the same checks. A call that would cause a collision throws and leaves the configuration in effect unchanged.

A module given no `namespace` uses its default: `cache`, `lock`, `rate-limit`, `events` for Pub/Sub, `stream`, and `app` for sessions. Sessions enabled without a namespace therefore collide with any other enabled module under `app:`, such as `app:cache`.

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,

  cache: { enabled: true, namespace: 'app:cache', defaultTtl: 300 },
  lock: { enabled: true, namespace: 'app:lock', defaultTtl: 30, maxTtl: 300 },
  rateLimit: { enabled: true, namespace: 'app:limit', windowSeconds: 60, maxRequests: 100 },
  pubsub: { enabled: true, namespace: 'app:event' },
  streams: { enabled: true, namespace: 'app:stream', maxEntries: 100_000 },
  sessions: { enabled: true, namespace: 'app:session' },
});

await redis.cache.set('user:42', { id: '42' });
const lock = await redis.lock.acquire('job:42');
const decision = await redis.rateLimiter.consume('user:42');
await redis.pubsub.publish('orders.created', { orderId: '42' });
await redis.streams.add('orders', { orderId: '42', type: 'created' });
const session = await redis.sessions.create({ userId: '42' });
```

## Connection modes

`mode` selects the topology: `standalone`, `sentinel` or `cluster`. It may be left out for standalone Redis. Every other connection option is passed to ioredis: `RedisOptions` for standalone and Sentinel, `ClusterOptions` for Cluster.

```ts
// Standalone, with `mode` left out.
const standalone = createRedisClient({ host: '127.0.0.1', port: 6379 });

// Sentinel: the sentinels to ask, and the name of the master they monitor.
const sentinel = createRedisClient({
  mode: 'sentinel',
  sentinels: [{ host: '10.0.0.1', port: 26379 }, { host: '10.0.0.2', port: 26379 }],
  name: 'mymaster',
});

// Cluster: the startup nodes.
const cluster = createRedisClient({
  mode: 'cluster',
  nodes: [{ host: '10.0.0.1', port: 7000 }, { host: '10.0.0.2', port: 7000 }],
});
```

## Shutdown and error visibility

`close()` closes every connection the client opened: the shared connection, the Pub/Sub subscriber connection if Pub/Sub was used, and the connections blocking stream reads run on. A connection that is up is quit, so commands already sent complete; one that is not is disconnected. A stream reader is always disconnected, so a read still blocked ends at once. It is idempotent and safe to call whichever modules were used, so it can sit in a generic shutdown hook. Once it has been called the client opens no further connection. A Pub/Sub subscribe or a blocking stream read afterwards, whenever the module was first used, rejects with the `Connection is closed.` error ioredis gives a command on a closed connection; any other command fails as ioredis fails it.

Errors the client cannot raise to a caller, such as a dropped connection, go to the `onError` hook passed when the client is created. The context names the source: `connection` for the shared connection, `subscriber` for the Pub/Sub subscriber connection, `stream-reader` for a connection blocking stream reads run on, `pubsub-handler` for a Pub/Sub handler that threw or rejected, or a message that was not JSON (with the logical `channel`), and `lock-release` for a release inside `lock.using()` that failed.

```ts
const redis = createRedisClient(config, {
  onError: (error, { source, channel }) => logger.warn({ err: error, source, channel }, 'redis error'),
});

process.on('SIGTERM', async () => {
  await redis.close();
  process.exit(0);
});
```

Every connection the client opens always has an `'error'` listener of its own, so without a hook those errors are dropped rather than crashing the process. A hook that throws, or returns a promise that rejects, is contained.

## Health checks

`health()` asks whether Redis is answering, for a readiness or liveness probe. It sends a `PING` with a timeout of its own, so it answers within `timeoutMs` (default 1000) even while Redis is down. A plain `ping()` stays queued through ioredis's reconnect retries, about ten seconds by default. A Redis failure never rejects: a timeout, a refused connection or a closed client resolves as `unhealthy`, with the reason in `error`. A round trip slower than `degradedMs` (default 100) is `degraded`.

```ts
app.get('/ready', async (_req, res) => {
  const health = await redis.health({ timeoutMs: 500 });
  res.status(health.status === 'unhealthy' ? 503 : 200).json(health);
});
```

On standalone and Sentinel the `PING` goes over the shared connection, which on Sentinel is the current master. On Cluster every master is pinged at once, and each appears in `nodes` with its `address`, `status` and `latencyMs`. The cluster is `unhealthy` when any master is, since that master's slots cannot be served. `latencyMs` is the slowest round trip measured. The check opens no connection of its own and does not look at the Pub/Sub subscriber or stream-reader connections.

## Fluent module overrides

Each module can inherit the global configuration and override selected values:

```ts
redis
  .withCache({ defaultTtl: 60 })
  .withLock({ defaultTtl: 15 })
  .withRateLimit({ maxRequests: 500 })
  .withPubSub({ namespace: 'critical-events' })
  .withStreams({ maxEntries: 500_000 })
  .withSessions({ idleTimeout: 60 * 60 });
```

Use `'replace'` when the module should start again from its defaults. Every option the call does not give is reset to its default, `enabled: false` included, so pass `enabled: true` to keep the module usable:

```ts
redis.withCache({ enabled: true, namespace: 'temporary' }, 'replace');
redis.withLock({ enabled: true, namespace: 'maintenance' }, 'replace');
```

`withLock()` is canonical; `withlock()` is provided as an alias, and `withSession()` likewise for `withSessions()`. `redis.config` returns every module's normalized configuration as it is in effect.

`withPubSub()` closes the subscriber connection it replaces, so while Pub/Sub has a live subscription it throws `PubSubError` with `PUBSUB_STATE` and keeps the configuration and subscriber in effect; unsubscribe first.

## Errors

Every error the package raises itself extends `RedisToolkitError` and carries a stable, machine-readable `code`, so one `catch` can recognise a package failure and branch on its kind without reading the message:

```ts
import { RedisToolkitError } from 'ioredis-toolkit';

try {
  await redis.lock.using('report:daily', generateReport);
} catch (error) {
  if (!(error instanceof RedisToolkitError)) throw error;
  if (error.code === 'LOCK_HELD') return; // another worker has it
  throw error;
}
```

Each module has its own class under that base — `SessionError` and its subclasses, `CacheError`, `LockError`, `RateLimitError`, `PubSubError`, `StreamsError`, and `RedisConfigurationError` for the connection configuration, for colliding namespaces and for a module other than sessions used while disabled — and its usage guide lists the codes it can report. Sessions used while disabled throw `SessionConfigurationError`.

Inside a session operation, a failure reported by Redis or the connection is wrapped as `SESSION_STORAGE`, with two exceptions that pass it through as ioredis raised it: every Redis call `list()` makes, and in `revokeAll()` the read of the user's session set and a pipeline that fails as a whole. In the other modules it always passes through as ioredis raised it.

## Import paths

The root import carries the client facade and every public name. Each module also has a subpath of its own, exporting its class together with the configuration, input, result and error types that go with it, so one import is enough to annotate what you pass to a module and what it hands back:

| Import | What it exports |
| --- | --- |
| `ioredis-toolkit` | `createRedisClient`, `RedisClient`, `RedisToolkitError`, `RedisConfigurationError`, `createRedisConnection`, `parseRedisConnectionConfig`, the client types (`RedisClientConfig`, `RedisClientDependencies`, `RedisErrorContext`, `RedisErrorSource`, `ModuleConfigMode`), the connection types (`RedisConfig` and its per-mode variants, `RedisMode`, `RedisConnection`, `RedisCommandClient`, `RedisPipeline`, `ClusterFanoutOptions`, `ModuleConfigBase`), and everything below |
| `ioredis-toolkit/session` | `SessionManager`, `createSessionManager`, `createSessionManagerFromRedis`, `parseSessionConfig`, the cookie helpers, the `Session*Error` classes, the session types, and `RedisConfig` |
| `ioredis-toolkit/cache` | `RedisCache`, `parseCacheConfig`, `CacheError`, and the cache types |
| `ioredis-toolkit/lock` | `RedisLock`, `parseLockConfig`, `LockError`, and the lock types |
| `ioredis-toolkit/rate-limit` | `RedisRateLimiter`, `parseRateLimitConfig`, `RateLimitError`, and the rate-limit types |
| `ioredis-toolkit/pubsub` | `RedisPubSub`, `parsePubSubConfig`, `PubSubError`, and the Pub/Sub types |
| `ioredis-toolkit/streams` | `RedisStreams`, `parseStreamsConfig`, `StreamsError`, and the Streams types |

```ts
import type { CacheConfig, CacheResult, RedisCache } from 'ioredis-toolkit/cache';

const cacheConfig: Partial<CacheConfig> = { enabled: true, namespace: 'app:cache', defaultTtl: 300 };

async function readUser(cache: RedisCache, id: string): Promise<CacheResult<User>> {
  return cache.get<User>(`user:${id}`);
}
```

The session subpath also constructs what it exports, without the root import:

```ts
import { createSessionManagerFromRedis, type RedisConfig, type SessionConfig } from 'ioredis-toolkit/session';

const connection: RedisConfig = { mode: 'standalone', host: '127.0.0.1', port: 6379 };
const sessionConfig: Partial<SessionConfig> = { enabled: true, namespace: 'app:session' };
const { manager, redis, config } = createSessionManagerFromRedis(connection, sessionConfig);

// On shutdown: the manager has no close() of its own.
await redis.close();
```

Both configurations are validated before anything connects, so a mistyped `mode` or disabled sessions throw and leave no connection behind. The factory returns the manager together with the connection it opened, `redis`, and the normalized session configuration, `config`; close the connection with `redis.close()`. This factory takes no key manager, so it refuses a configuration with encryption enabled; use `createRedisClient` with an `encryptionKeyManager` for encrypted sessions.

Only these paths and `ioredis-toolkit/package.json` are importable; a file inside `dist/` is not.

What these paths export is the whole public surface: the client facade, the connection types and the health-check types, the module classes, their configuration, input and result types, the cookie helpers, the error hierarchy and its code unions, the factory functions and the `parse*Config` functions. `RedisClient` extends the package's Redis command wrapper, so every method of `RedisCommandClient` is public on the client: raw commands such as `get`, `set`, `del`, `eval` and `pipeline`, `duplicateConnection()`, and the cluster-aware `mgetClusterAware()`, `scanCluster()` and `deletePatternClusterAware()`. They run on the shared connection as given, outside every module's namespace and validation. Everything else is internal and may change in any release: the classes the client facade constructs on your behalf (the session repository, service, serializer, key strategy, token manager and script registry), the wrapper class itself, which is not exported by name, the validation schema objects, and the cluster hash-slot helpers. A module is obtained from `createRedisClient` or a session factory function, never constructed directly.

## Documentation

Each module has a complete usage guide with configuration tables, types, method arguments, return values, semantics, edge cases, and multiple examples:

- [Cache usage](./docs/modules/cache/usage.md)
- [Lock usage](./docs/modules/lock/usage.md)
- [Rate limiting usage](./docs/modules/rate-limit/usage.md)
- [Pub/Sub usage](./docs/modules/pubsub/usage.md)
- [Streams usage](./docs/modules/streams/usage.md)
- [Sessions usage](./docs/modules/sessions/usage.md)

Additional architecture and operations documentation is in `docs/`.

## Installation

```bash
npm install ioredis-toolkit
```

`ioredis` and `zod` are dependencies of the package and are installed with it. The package is ESM-only and requires Node.js 22 or newer.

## Development

This repo uses [Bun](https://bun.sh) for dependency installation and scripts; the committed `bun.lock` is the source of truth, and CI installs from it with `bun install --frozen-lockfile`. The `pnpm-lock.yaml` also committed is not used by CI.

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run test:integration
bun run build
```

The real-Redis suites run against standalone Redis (`REDIS_URL`) and Redis Cluster (`REDIS_CLUSTER_NODES`), skipping a topology that is not configured. [docs/TESTING.md](./docs/TESTING.md#starting-both-topologies-locally) explains how to start both with the Docker definitions under `docker/`, along with a [Sentinel stack](./docs/TESTING.md#starting-sentinel-locally) (master, replica and three sentinels) and [`redis-cli` and RedisInsight](./docs/TESTING.md#inspecting-with-redis-cli-and-redisinsight) for each topology.

## Design principle

The session layer and other modules use the shared Redis abstraction rather than creating competing clients. Redis Cluster is treated as a distributed keyspace: same-slot atomicity is used only where Redis can actually provide it, while cross-slot work uses explicit bounded fan-out.

## Links

- [Changelog](./CHANGELOG.md)
- [Issues](https://github.com/org-utils/ioredis-toolkit/issues)
- [Repository](https://github.com/org-utils/ioredis-toolkit)
