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

Use `'replace'` when the module should start again from its defaults:

```ts
redis.withCache({ namespace: 'temporary' }, 'replace');
redis.withLock({ namespace: 'maintenance' }, 'replace');
```

`withLock()` is canonical; `withlock()` is provided as an alias.

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

Each module has its own class under that base — `SessionError` and its subclasses, `CacheError`, `LockError`, `RateLimitError`, `PubSubError`, `StreamsError`, and `RedisConfigurationError` for the connection and for a module used while disabled — and its usage guide lists the codes it can report. A failure reported by Redis or the connection is wrapped as `SESSION_STORAGE` inside a session operation; in the convenience wrappers it passes through as ioredis raised it.

## Import paths

The root import carries the client facade and every public name. Each module also has a subpath of its own, exporting its class together with the configuration, input, result and error types that go with it, so one import is enough to annotate what you pass to a module and what it hands back:

| Import | What it exports |
| --- | --- |
| `ioredis-toolkit` | `createRedisClient`, `RedisClient`, the connection configuration types, `RedisToolkitError`, and everything below |
| `ioredis-toolkit/session` | `SessionManager`, `createSessionManager`, `createSessionManagerFromRedis`, `parseSessionConfig`, the cookie helpers, the `Session*Error` classes, and the session types |
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
const { manager } = createSessionManagerFromRedis(connection, sessionConfig);
```

Only these paths are importable; a file inside `dist/` is not.

What these paths export is the whole public surface: the client facade and the connection types, the module classes, their configuration, input and result types, the cookie helpers, the error hierarchy and its code unions, the factory functions and the `parse*Config` functions. Everything else is internal and may change in any release: the classes the client facade constructs on your behalf (the session repository, service, serializer, key strategy, token manager and script registry, and the Redis command wrapper), the validation schema objects, and the cluster hash-slot helpers. A module is obtained from `createRedisClient` or a session factory function, never constructed directly.

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
npm install ioredis-toolkit ioredis zod
```

The package is ESM-only and requires Node.js 22 or newer.

## Development

This repo uses [Bun](https://bun.sh) for dependency installation and scripts; the committed `bun.lock` is the source of truth.

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run test:integration
bun run build
```

Real Redis integration tests require a Redis deployment. Docker definitions are provided under `docker/`.

## Design principle

The session layer and other modules use the shared Redis abstraction rather than creating competing clients. Redis Cluster is treated as a distributed keyspace: same-slot atomicity is used only where Redis can actually provide it, while cross-slot work uses explicit bounded fan-out.

## Links

- [Changelog](./CHANGELOG.md)
- [Issues](https://github.com/org-utils/ioredis-toolkit/issues)
- [Repository](https://github.com/org-utils/ioredis-toolkit)
