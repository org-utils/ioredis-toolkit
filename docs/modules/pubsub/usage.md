# Pub/Sub Module — Complete Usage Guide

`RedisPubSub` provides JSON Pub/Sub with namespaced channels and a dedicated subscriber connection. Pub/Sub is ephemeral: messages are not persisted for offline subscribers.

## Setup

```ts
import { createRedisClient } from 'ioredis-toolkit';

const redis = createRedisClient({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 6379,
  pubsub: { enabled: true, channelPrefix: 'myapp:events', maxMessageBytes: 1024 * 1024 },
});
```

`pubsub.enabled` defaults to `false`. Accessing `redis.pubsub` while disabled throws `RedisConfigurationError`; set `enabled: true` to use the module.

## Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `enabled` | `boolean` | `false` | Enables the module. `redis.pubsub` throws `RedisConfigurationError` while disabled; `new RedisPubSub(...)` remains directly constructible either way. |
| `channelPrefix` | `string` | `events` | Physical channel prefix. |
| `maxMessageBytes` | `number` | `1048576` | Maximum encoded JSON message size. |

## Resilience

The dedicated subscriber connection has a default `'error'` listener attached automatically, so a connection drop, auth failure, or network error on it can no longer crash the process with an uncaught exception. Attach your own listener on the connection if you need alerting/observability beyond that default.

A malformed (non-JSON) message delivered on a subscribed channel — for example, published by a non-conforming external client — is silently dropped instead of throwing inside ioredis's `message` event and crashing the process. Handlers are only invoked for messages that parse successfully.

Repeated `subscribe()` calls for the same physical channel issue a single underlying `SUBSCRIBE`; the physical `UNSUBSCRIBE` is only issued once the last logical handler for that channel unsubscribes.

## `publish<T>(channel, value)`

JSON-encodes a value and publishes it. The return value is Redis's subscriber count at publication time.

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

Closes the dedicated subscriber connection. Call it during application shutdown.

```ts
process.on('SIGTERM', async () => {
  await redis.pubsub.close();
  process.exit(0);
});
```

## Pub/Sub vs Streams

Use Pub/Sub when losing messages while nobody is listening is acceptable and low-latency fan-out is the priority. Use Streams when messages need persistence, consumer groups, acknowledgements, replay, or controlled processing.

## Overrides

```ts
redis.withPubSub({ channelPrefix: 'critical' });
redis.withPubSub({ maxMessageBytes: 256 * 1024 }, 'replace');
```

When replacing or reconfiguring Pub/Sub, close the previous subscriber connection before relying on the new configuration.
