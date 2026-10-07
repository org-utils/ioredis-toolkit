import { describe, expect, it } from 'vitest';
import { connectClient, eventually, redisFixture, redisUrl } from '../support/redis.js';

describe.skipIf(!redisUrl)('Pub/Sub against real Redis', () => {
  const redis = redisFixture();

  it('publishes JSON-encoded values to the namespaced channel', async () => {
    const namespace = redis.newNamespace();
    const { pubsub } = connectClient({ pubsub: { enabled: true, namespace } });
    const listener = redis.observer.duplicate();
    try {
      const heard: Array<{ channel: string; message: string }> = [];
      listener.on('pmessage', (_pattern, channel, message) => { heard.push({ channel, message }); });
      await listener.psubscribe(`${namespace}*`);
      expect(await pubsub.publish('orders', { id: 1 })).toBe(1);
      await eventually(() => expect(heard).toEqual([{ channel: `${namespace}:orders`, message: JSON.stringify({ id: 1 }) }]));
    } finally {
      await listener.quit();
      await pubsub.close();
    }
  });

  it('delivers parsed JSON messages to a subscribed handler and drops a malformed one', async () => {
    const namespace = redis.newNamespace();
    const { pubsub } = connectClient({ pubsub: { enabled: true, namespace } });
    try {
      const received: unknown[] = [];
      await pubsub.subscribe('orders', message => { received.push(message); });
      await redis.observer.publish(`${namespace}:orders`, 'not json');
      await redis.observer.publish(`${namespace}:orders`, JSON.stringify({ id: 42 }));
      await eventually(() => expect(received).toEqual([{ channel: 'orders', value: { id: 42 } }]));
    } finally {
      await pubsub.close();
    }
  });

  it('delivers once to each handler on a channel and leaves the channel when the last handler does', async () => {
    const { pubsub } = connectClient({ pubsub: { enabled: true, namespace: redis.newNamespace() } });
    try {
      const first: unknown[] = [];
      const second: unknown[] = [];
      const firstSubscription = await pubsub.subscribe('orders', message => { first.push(message.value); });
      const secondSubscription = await pubsub.subscribe('orders', message => { second.push(message.value); });
      await pubsub.publish('orders', 1);
      await eventually(() => { expect(first).toEqual([1]); expect(second).toEqual([1]); });

      await firstSubscription.unsubscribe();
      await pubsub.publish('orders', 2);
      await eventually(() => expect(second).toEqual([1, 2]));
      expect(first).toEqual([1]);

      await secondSubscription.unsubscribe();
      expect(await pubsub.publish('orders', 3)).toBe(0);
    } finally {
      await pubsub.close();
    }
  });

  it('stops receiving once closed', async () => {
    const namespace = redis.newNamespace();
    const { pubsub } = connectClient({ pubsub: { enabled: true, namespace } });
    await pubsub.subscribe('orders', () => undefined);
    expect(await redis.observer.publish(`${namespace}:orders`, '1')).toBe(1);
    await pubsub.close();
    await eventually(async () => expect(await redis.observer.publish(`${namespace}:orders`, '2')).toBe(0));
  });
});
