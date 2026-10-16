# Pub/Sub Module — Complete Usage Guide

`RedisPubSub` provides JSON Pub/Sub with namespaced channels and a dedicated subscriber connection, opened by the first `subscribe()`; publishing alone never opens it. Pub/Sub is ephemeral: messages are not persisted for offline subscribers.

## Setup

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,
  pubsub: { enabled: true, namespace: 'myapp:events', maxMessageBytes: 1024 * 1024 },
});
```

`pubsub.enabled` defaults to `false`. Accessing `redis.pubsub` while disabled throws `RedisConfigurationError`; set `enabled: true` to use the module.

## Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `enabled` | `boolean` | `false` | Enables the module. `redis.pubsub` throws `RedisConfigurationError` while disabled. |
| `namespace` | `string` | `events` | Namespace: the first segment of every channel name. Letters, digits, `:`, `_` and `-` only, at most 128 characters. |
| `maxMessageBytes` | `number` | `1048576` | Maximum UTF-8 encoded JSON message size in bytes. A positive integer, at most `16777216` (16 MiB). |

The namespace must not overlap another enabled module's: two namespaces overlap when they are equal or one is a `:`-delimited prefix of the other (`myapp` and `myapp:events`). `createRedisClient()` and `withPubSub()` throw `RedisConfigurationError` for an overlapping namespace.

`parsePubSubConfig(input)` validates a configuration and returns the normalized `PubSubConfig`, throwing `PubSubError` with code `PUBSUB_CONFIGURATION` when it is invalid. `RedisPubSub`, `parsePubSubConfig`, `PubSubError` and the types `PubSubConfig`, `PubSubMessage`, `Subscription` and `PubSubErrorCode` are exported from both `ioredis-toolkit` and `ioredis-toolkit/pubsub`.

## Resilience

The dedicated subscriber connection has a default `'error'` listener attached automatically, so a connection drop, auth failure, or network error on it never crashes the process with an uncaught exception. The listener forwards each error to the client's `onError` hook with source `subscriber`; see [Shutdown and error visibility](../../../README.md#shutdown-and-error-visibility) in the README.

Each handler call is isolated. A handler that throws, or an async handler whose promise rejects, is reported to the `onError` hook with source `pubsub-handler` and the logical `channel`, and the other handlers on that channel still receive the message. A rejection never surfaces as an unhandled rejection, which would end a Node 22 process.

A malformed (non-JSON) message delivered on a subscribed channel, for example one published by a non-conforming external client, is handed to no handler. It is reported once to the `onError` hook as a `PubSubError` with code `PUBSUB_SERIALIZATION`, source `pubsub-handler` and the logical `channel`.

Repeated `subscribe()` calls for the same physical channel issue a single underlying `SUBSCRIBE`; the physical `UNSUBSCRIBE` is only issued once the last logical handler for that channel unsubscribes. Concurrent `subscribe()` calls to one channel share that `SUBSCRIBE`, and each resolves only once Redis has confirmed it, so a message published as soon as any of them resolves reaches every one. A `subscribe()` that fails, for example on a lost connection, removes the handler it registered, so a later `subscribe()` to that channel sends a fresh `SUBSCRIBE` instead of waiting on a dead one.

## `publish<T>(channel, value)`

JSON-encodes a value and publishes it. The return value is Redis's subscriber count at publication time.

When the connection closes before the reply arrives, ioredis sends the `PUBLISH` again once it reconnects, and if Redis had run it, every subscriber receives the message twice ([Commands sent twice](../../DEPLOYMENT.md#commands-sent-twice)). Handlers that must not act twice need an ID in the message to check.

The value is encoded with `JSON.stringify`. It is rejected with `PUBSUB_SERIALIZATION` when encoding throws (a cyclic structure, or a `BigInt` anywhere in it) or produces nothing (`undefined`, a function or a symbol as the value itself). Anything else is encoded by JSON's own rules, without an error: inside an object, a property holding `undefined`, a function or a symbol is dropped; inside an array, such an element becomes `null`; `NaN` and `Infinity` become `null`; and a `Date` becomes its ISO string. Subscribers receive the encoded shape, not the value that was published.

On Redis Cluster that count covers only the clients subscribed through the node that took the `PUBLISH`. The message still reaches subscribers on every node, so a count of 0 does not mean nobody received it.

```ts
const subscribers = await redis.pubsub.publish('orders.created', {
  orderId: 'ord_123',
  userId: 'user_42',
});
console.log(`Delivered to ${subscribers} subscribers`);
```

## `subscribe<T>(channel, handler)`

Creates a logical subscription and returns a `Subscription` handle.

```ts
const subscription = await redis.pubsub.subscribe<OrderCreated>(
  'orders.created',
  message => {
    console.log(message.channel, message.value.orderId);
  },
);

await subscription.unsubscribe();
```

The callback receives a `PubSubMessage<T>` containing the logical channel and decoded value.

Multiple subscriptions to the same logical channel share the dedicated subscriber connection.

```ts
const a = await redis.pubsub.subscribe('cache.invalidate', msg => console.log('A', msg.value));
const b = await redis.pubsub.subscribe('cache.invalidate', msg => console.log('B', msg.value));
await a.unsubscribe();
// B remains subscribed.
await b.unsubscribe();
```

## `fullChannel(channel)`

Returns the namespaced physical channel.

```ts
redis.pubsub.fullChannel('orders.created');
// myapp:events:orders.created
```

## `close()`

Closes the dedicated subscriber connection, if a subscribe opened one. It is idempotent, and a `subscribe()` afterwards rejects instead of opening another. At application shutdown, prefer the client's own `close()`, which closes this connection together with every other one the client opened.

```ts
process.on('SIGTERM', async () => {
  await redis.close();
  process.exit(0);
});
```

## Pub/Sub vs Streams

Use Pub/Sub when losing messages while nobody is listening is acceptable and low-latency fan-out is the priority. Use Streams when messages need persistence, consumer groups, acknowledgements, replay, or controlled processing.

## Errors

Every error this module raises itself is a `PubSubError`, which extends the package-wide `RedisToolkitError` and carries a stable `code`, typed `PubSubErrorCode`. A failure reported by Redis or the connection passes through as ioredis raised it.

| Code | Thrown when |
|---|---|
| `PUBSUB_CONFIGURATION` | the Pub/Sub configuration is invalid |
| `PUBSUB_SERIALIZATION` | `publish()` is given a value `JSON.stringify` throws on or encodes as nothing (see `publish()`). Also reported to the `onError` hook, never thrown, for a received message that is not JSON |
| `PUBSUB_LIMIT` | the encoded message exceeds `maxMessageBytes` |
| `PUBSUB_STATE` | `withPubSub()` is called while a subscription is live |

## Overrides

```ts
redis.withPubSub({ namespace: 'critical' });
redis.withPubSub({ enabled: true, maxMessageBytes: 256 * 1024 }, 'replace');
```

`'replace'` resets every option it is not given to its default, `enabled: false` included, so pass `enabled: true` or `redis.pubsub` throws `RedisConfigurationError` afterwards. The `'replace'` example above also returns the namespace to `events`.

Reconfiguring Pub/Sub replaces the subscriber connection and closes the old one. So that this never silently drops a listener, `withPubSub()` throws `PubSubError` with code `PUBSUB_STATE` while any subscription is live, including one still being confirmed, and leaves the configuration and the subscriptions in effect. Unsubscribe them first, then reconfigure.
