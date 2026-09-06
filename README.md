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
  pubsub: { enabled: true, channelPrefix: 'app:event' },
  streams: { enabled: true, keyPrefix: 'app:stream', maxEntries: 100_000 },
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
  .withPubSub({ channelPrefix: 'critical-events' })
  .withStreams({ maxEntries: 500_000 })
  .withSessions({ idleTimeout: 60 * 60 });
```

Use `'replace'` when the module should start again from its defaults:

```ts
redis.withCache({ namespace: 'temporary' }, 'replace');
redis.withLock({ namespace: 'maintenance' }, 'replace');
```

`withLock()` is canonical; `withlock()` is provided as an alias.

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
