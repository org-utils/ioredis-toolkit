# Streams Module — Complete Usage Guide

`RedisStreams` wraps Redis Streams for append, consumer-group creation, reads, acknowledgements, deletion, and length inspection.

## Setup

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,
  streams: { enabled: true, namespace: 'myapp:stream', maxEntries: 100_000, blockMs: 5_000 },
});
```

`streams.enabled` defaults to `false`. Accessing `redis.streams` while disabled throws `RedisConfigurationError`; set `enabled: true` to use the module.

## Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `enabled` | `boolean` | `false` | Enables the module. `redis.streams` throws `RedisConfigurationError` while disabled. |
| `namespace` | `string` | `stream` | Namespace: the first segment of every stream key. Letters, digits, `:`, `_` and `-` only, at most 128 characters. |
| `maxEntries` | `number` | `100000` | Approximate retained entry limit used by `add()`. A positive integer, at most `10000000`. |
| `blockMs` | `number` | `5000` | Default blocking duration, in milliseconds, applied to `read()` whenever a call does not pass its own `blockMs`. An integer from `0` to `300000`. |

These bounds apply to the configuration only: the `maxEntries` argument of `add()` and the `blockMs` option of `read()` are passed to Redis as given.

The namespace must not overlap another enabled module's: two namespaces overlap when they are equal or one is a `:`-delimited prefix of the other (`myapp` and `myapp:stream`). `createRedisClient()` and `withStreams()` throw `RedisConfigurationError` for an overlapping namespace.

`parseStreamsConfig(input)` validates a configuration and returns the normalized `StreamsConfig`, throwing `StreamsError` with code `STREAMS_CONFIGURATION` when it is invalid. `RedisStreams`, `parseStreamsConfig`, `StreamsError` and the types `StreamsConfig`, `StreamEntry`, `StreamReadOptions` and `StreamsErrorCode` are exported from both `ioredis-toolkit` and `ioredis-toolkit/streams`.

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

Fields are strings because Redis Streams are field/value strings. Serialize structured values explicitly. An entry needs at least one field: `add()` with an empty field map throws `StreamsError` (code `STREAMS_INPUT`) without contacting Redis.

```ts
await redis.streams.add('events', {
  payload: JSON.stringify({ orderId: 'ord_1', amount: 25 }),
});
```

## `createGroup(name, group, startId?, mkStream?)`

Creates a consumer group; it resolves with no value. `startId` defaults to `$` and `mkStream` to `true`, which creates the stream when it does not exist yet. `BUSYGROUP` is treated as idempotent success.

```ts
await redis.streams.createGroup('orders', 'workers', '0', true);
```

Using `$` starts at the end of the stream, while `0` allows existing entries to be delivered.

## `read(name, options?)`

Reads normal stream entries or consumer-group entries, and resolves with a `StreamEntry[]`, each entry `{ id, fields }`. Every read blocks for `blockMs` (per-call, or the configured default when omitted); `0` waits indefinitely, per Redis semantics.

A blocking read never runs on the client's shared connection. It leases a connection of its own from a pool of duplicates the Streams module grows on demand, and hands it back when the read returns. So a consumer waiting on a stream, even with `blockMs: 0`, never delays session checks, cache reads or any other command, and two concurrent reads on different streams wait side by side instead of queueing. Each concurrent read holds one connection, so the pool grows to the most reads in flight at once. Errors on these connections reach the client's `onError` hook with source `stream-reader`.

`RedisClient.close()` disconnects every reader connection, so a read still waiting, however long its `blockMs`, rejects at once instead of holding shutdown up. After that, and after `streams.close()`, which does the same for the Streams module alone, every `read()` rejects without opening a connection. Every Streams module on one client shares the reader connections, so after `streams.close()` reads keep rejecting even on the module a later `withStreams()` creates.

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
- `consumer`: consumer name; **required** when `group` is supplied — `read()` throws a `StreamsError` (code `STREAMS_INPUT`) if `group` is set without `consumer`, instead of silently falling back to a plain, incorrectly-cursored `XREAD`. A `consumer` without a `group` is ignored, and the read is a plain `XREAD`.
- `count`: maximum requested entries; defaults to `100`.
- `blockMs`: optional Redis blocking read duration; defaults to the module's configured `blockMs` when omitted.
- `id`: starting/continuation ID. Defaults to `>` for a group read, which delivers messages never delivered to the group, and to `$` for a plain read, which returns only entries added after the read starts. Pass the last ID you received to continue a plain read without missing entries.

## `ack(name, group, ...ids)`

Acknowledges processed consumer-group messages and returns how many were acknowledged. At least one ID is required: called with none, the command is still sent and Redis rejects it.

```ts
await redis.streams.ack('orders', 'workers', '1750000000000-0');
```

## `delete(name, ...ids)`

Deletes specific entries and returns how many were deleted. At least one ID is required: called with none, the command is still sent and Redis rejects it.

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

## Errors

Every error this module raises itself is a `StreamsError`, which extends the package-wide `RedisToolkitError` and carries a stable `code`, typed `StreamsErrorCode`. A failure reported by Redis or the connection passes through as ioredis raised it.

| Code | Thrown when |
|---|---|
| `STREAMS_CONFIGURATION` | the Streams configuration is invalid |
| `STREAMS_INPUT` | `read()` is given a `group` without a `consumer`, or `add()` is given no fields |

## Overrides

```ts
redis.withStreams({ maxEntries: 500_000, blockMs: 10_000 });
redis.withStreams({ enabled: true, namespace: 'critical-streams' }, 'replace');
```

`'replace'` resets every option it is not given to its default, `enabled: false` included, so pass `enabled: true` or `redis.streams` throws `RedisConfigurationError` afterwards.
