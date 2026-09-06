import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RedisPubSub } from '../../src/pubsub/pubsub.js';
import type { RedisClientWrapper } from '../../src/redis/wrapper.js';

function fakeRedis() {
  const subscriber = Object.assign(new EventEmitter(), {
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 1),
    quit: vi.fn(async () => 'OK'),
  });
  const publish = vi.fn(async () => 1);
  const redis = { duplicateConnection: () => subscriber, publish } as unknown as RedisClientWrapper;
  return { redis, subscriber, publish };
}

describe('RedisPubSub', () => {
  it('attaches an error listener so a subscriber error event does not crash the process', () => {
    const { redis, subscriber } = fakeRedis();
    new RedisPubSub(redis, { enabled: true, channelPrefix: 'events', maxMessageBytes: 1024 });
    expect(() => subscriber.emit('error', new Error('connection reset'))).not.toThrow();
  });

  it('publishes JSON-encoded values to the namespaced channel', async () => {
    const { redis, publish } = fakeRedis();
    const pubsub = new RedisPubSub(redis, { enabled: true, channelPrefix: 'events', maxMessageBytes: 1024 });
    await pubsub.publish('orders', { id: 1 });
    expect(publish).toHaveBeenCalledWith('events:orders', JSON.stringify({ id: 1 }));
  });

  it('rejects values exceeding maxMessageBytes', async () => {
    const { redis } = fakeRedis();
    const pubsub = new RedisPubSub(redis, { enabled: true, channelPrefix: 'events', maxMessageBytes: 4 });
    await expect(pubsub.publish('orders', { id: 1 })).rejects.toThrow(RangeError);
  });

  it('delivers parsed JSON messages to subscribed handlers', async () => {
    const { redis, subscriber } = fakeRedis();
    const pubsub = new RedisPubSub(redis, { enabled: true, channelPrefix: 'events', maxMessageBytes: 1024 });
    const received: unknown[] = [];
    await pubsub.subscribe('orders', message => received.push(message));
    expect(subscriber.subscribe).toHaveBeenCalledWith('events:orders');
    subscriber.emit('message', 'events:orders', JSON.stringify({ id: 42 }));
    expect(received).toEqual([{ channel: 'orders', value: { id: 42 } }]);
  });

  it('drops a malformed message instead of throwing', async () => {
    const { redis, subscriber } = fakeRedis();
    const pubsub = new RedisPubSub(redis, { enabled: true, channelPrefix: 'events', maxMessageBytes: 1024 });
    const handler = vi.fn();
    await pubsub.subscribe('orders', handler);
    expect(() => subscriber.emit('message', 'events:orders', 'not json')).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('only issues one physical subscribe for repeated handlers on the same channel, and unsubscribes once the last handler leaves', async () => {
    const { redis, subscriber } = fakeRedis();
    const pubsub = new RedisPubSub(redis, { enabled: true, channelPrefix: 'events', maxMessageBytes: 1024 });
    const first = await pubsub.subscribe('orders', () => undefined);
    await pubsub.subscribe('orders', () => undefined);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    await first.unsubscribe();
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
  });

  it('closes the dedicated subscriber connection and clears handlers', async () => {
    const { redis, subscriber } = fakeRedis();
    const pubsub = new RedisPubSub(redis, { enabled: true, channelPrefix: 'events', maxMessageBytes: 1024 });
    await pubsub.subscribe('orders', () => undefined);
    await pubsub.close();
    expect(subscriber.quit).toHaveBeenCalled();
  });
});
