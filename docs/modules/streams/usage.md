# Streams Module — Complete Usage Guide

`RedisStreams` wraps Redis Streams for append, consumer-group creation, reads, acknowledgements, deletion, and length inspection.

## Setup

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,
  streams: { enabled: true, keyPrefix: 'myapp:stream', maxEntries: 100_000, blockMs: 5_000 },
});
```

`streams.enabled` defaults to `false`. Accessing `redis.streams` while disabled throws `RedisConfigurationError`; set `enabled: true` to use the module.

## Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `enabled` | `boolean` | `false` | Enables the module. `redis.streams` throws `RedisConfigurationError` while disabled; `new RedisStreams(...)` remains directly constructible either way. |
| `keyPrefix` | `string` | `stream` | Physical stream prefix. |
| `maxEntries` | `number` | `100000` | Approximate retained entry limit used by `add()`. |
| `blockMs` | `number` | `5000` | Default blocking duration applied to `read()` whenever a call does not pass its own `blockMs`. |

## `key(name)`

Builds the physical stream key.

```ts
redis.streams.key('orders'); // myapp:stream:orders
```

## `add(name, fields, maxEntries?)`

Appends a record with Redis-generated `*` ID and approximate trimming.

```ts
const id = await redis.streams.add('orders', {
  type: 'created',
  orderId: 'ord_123',
  userId: 'user_42',
});
```

Override retention for a particular stream:

```ts
await redis.streams.add('audit', { event: 'login' }, 1_000_000);
```

Fields are strings because Redis Streams are field/value strings. Serialize structured values explicitly.

```ts
await redis.streams.add('events', {
  payload: JSON.stringify({ orderId: 'ord_1', amount: 25 }),
});
```

## `createGroup(name, group, startId?, mkStream?)`

Creates a consumer group. `BUSYGROUP` is treated as idempotent success.

```ts
await redis.streams.createGroup('orders', 'workers', '0', true);
```

Using `$` starts at the end of the stream, while `0` allows existing entries to be delivered.

## `read(name, options?)`

Reads normal stream entries or consumer-group entries. Every read now blocks for `blockMs` (per-call, or the configured default when omitted) — pass a small `blockMs` (or `0`, which blocks indefinitely per Redis semantics) deliberately rather than relying on an implicit non-blocking read.

Normal read:

```ts
const entries = await redis.streams.read('orders', {
  id: '0-0',
  count: 50,
});
```

Consumer-group read:

```ts
const entries = await redis.streams.read('orders', {
  group: 'workers',
  consumer: 'worker-1',
  count: 20,
  blockMs: 5000,
});
for (const entry of entries) {
  console.log(entry.id, entry.fields);
}
```

`StreamReadOptions`:

- `group`: consumer group name.
- `consumer`: consumer name; **required** when `group` is supplied — `read()` throws a `RangeError` if `group` is set without `consumer`, instead of silently falling back to a plain, incorrectly-cursored `XREAD`.
- `count`: maximum requested entries.
- `blockMs`: optional Redis blocking read duration; defaults to the module's configured `blockMs` when omitted.
- `id`: starting/continuation ID; group reads commonly use `>` for new messages.

## `ack(name, group, ...ids)`

Acknowledges processed consumer-group messages.

```ts
await redis.streams.ack('orders', 'workers', '1750000000000-0');
```

## `delete(name, ...ids)`

Deletes specific entries.

```ts
await redis.streams.delete('orders', '1750000000000-0');
```

## `length(name)`

Returns current stream length.

```ts
const size = await redis.streams.length('orders');
```

## Operational guidance

Consumer groups create pending-entry state. Production consumers should also implement a pending-entry recovery strategy using native Redis commands appropriate to their workload. This wrapper intentionally keeps its surface small and does not pretend that a single `read()` loop is a complete queue-processing framework.

## Overrides

```ts
redis.withStreams({ maxEntries: 500_000, blockMs: 10_000 });
redis.withStreams({ keyPrefix: 'critical-streams' }, 'replace');
```
