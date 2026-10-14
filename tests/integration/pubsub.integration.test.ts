import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PubSubError } from '../../src/index.js';
import type { RedisErrorContext } from '../../src/index.js';
import { expectPackageError } from '../support/errors.js';
import { describeOnEachTopology, eventually } from '../support/redis.js';

describeOnEachTopology('Pub/Sub against real Redis', redis => {
  it('publishes JSON-encoded values to the namespaced channel', async () => {
    const namespace = redis.newNamespace();
    const { pubsub } = redis.connectClient({ pubsub: { enabled: true, namespace } });
    const listener = redis.observer.duplicate();
    try {
      const heard: Array<{ channel: string; message: string }> = [];
      listener.on('pmessage', (_pattern, channel, message) => { heard.push({ channel, message }); });
      await listener.psubscribe(`${namespace}*`);
      const receivers = await pubsub.publish('orders', { id: 1 });
      // A cluster counts only the receivers connected to the node that took the PUBLISH.
      if (redis.topology === 'standalone') expect(receivers).toBe(1);
      await eventually(() => expect(heard).toEqual([{ channel: `${namespace}:orders`, message: JSON.stringify({ id: 1 }) }]));
    } finally {
      await listener.quit();
      await pubsub.close();
    }
  });

  it('delivers parsed JSON messages to a subscribed handler and drops a malformed one', async () => {
    const namespace = redis.newNamespace();
    const { pubsub } = redis.connectClient({ pubsub: { enabled: true, namespace } });
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
    const namespace = redis.newNamespace();
    const { pubsub } = redis.connectClient({ pubsub: { enabled: true, namespace } });
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
      expect(await redis.subscribersTo(`${namespace}:orders`)).toBe(0);
    } finally {
      await pubsub.close();
    }
  });

  it('stops receiving once closed', async () => {
    const namespace = redis.newNamespace();
    const { pubsub } = redis.connectClient({ pubsub: { enabled: true, namespace } });
    await pubsub.subscribe('orders', () => undefined);
    expect(await redis.subscribersTo(`${namespace}:orders`)).toBe(1);
    await pubsub.close();
    await eventually(async () => expect(await redis.subscribersTo(`${namespace}:orders`)).toBe(0));
  });

  describe('handler failures', () => {
    // A rejection nobody handles would crash a Node 22 process; here it is only recorded.
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => { unhandled.push(reason); };
    beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', record); });
    afterEach(() => { process.off('unhandledRejection', record); });

    /** A Pub/Sub client whose error hook records what it hears. */
    function reportingPubSub() {
      const namespace = redis.newNamespace();
      const heard: Array<{ error: unknown; context: RedisErrorContext }> = [];
      const { pubsub } = redis.connectClient({ pubsub: { enabled: true, namespace } }, { onError: (error, context) => { heard.push({ error, context }); } });
      return { pubsub, namespace, heard };
    }

    it('runs the other handlers on a channel when one throws, and reports the throw', async () => {
      const { pubsub, heard } = reportingPubSub();
      const failure = new Error('handler failed');
      const received: unknown[] = [];
      await pubsub.subscribe('orders', () => { throw failure; });
      await pubsub.subscribe('orders', message => { received.push(message.value); });
      await pubsub.publish('orders', 1);

      await eventually(() => expect(received).toEqual([1]));
      expect(heard).toEqual([{ error: failure, context: { source: 'pubsub-handler', channel: 'orders' } }]);
    });

    it('reports an async handler that rejects, leaving no unhandled rejection', async () => {
      const { pubsub, heard } = reportingPubSub();
      const failure = new Error('handler failed');
      await pubsub.subscribe('orders', async () => { throw failure; });
      await pubsub.publish('orders', 1);

      await eventually(() => expect(heard).toEqual([{ error: failure, context: { source: 'pubsub-handler', channel: 'orders' } }]));
      // Long enough for Node to have flagged the rejection, had nothing handled it.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    });

    it('reports a message that is not JSON as PUBSUB_SERIALIZATION', async () => {
      const { pubsub, namespace, heard } = reportingPubSub();
      await pubsub.subscribe('orders', () => undefined);
      await redis.observer.publish(`${namespace}:orders`, 'not json');

      await eventually(() => expect(heard).toHaveLength(1));
      expect(heard[0]!.context).toEqual({ source: 'pubsub-handler', channel: 'orders' });
      await expectPackageError(() => { throw heard[0]!.error; }, PubSubError, 'PUBSUB_SERIALIZATION');
    });
  });

  describe('subscription state', () => {
    it('subscribes again after a subscribe that failed', async () => {
      // With no offline queue, a subscribe sent before the subscriber connection is up fails at once, as on a lost connection.
      const { pubsub } = redis.connectClient({ ...redis.connectionConfig(), lazyConnect: true, enableOfflineQueue: false, pubsub: { enabled: true, namespace: redis.newNamespace() } });
      await expect(pubsub.subscribe('orders', () => undefined)).rejects.toThrow();

      const received: unknown[] = [];
      await eventually(async () => { await pubsub.subscribe('orders', message => { received.push(message.value); }); });
      // The shared connection has no offline queue either, so it takes publishes only once it is up.
      await eventually(async () => { await pubsub.publish('orders', 1); });
      await eventually(() => expect(received).toEqual([1]));
    });

    it('resolves each of two concurrent subscribes to a channel only once Redis has confirmed it', async () => {
      const client = redis.connectClient({ pubsub: { enabled: true, namespace: redis.newNamespace() } });
      // A shared connection already up publishes at once, while the subscriber connection is still connecting.
      await client.ping();
      const { pubsub } = client;
      const received = { first: [] as unknown[], second: [] as unknown[] };
      /** Subscribes, and publishes the moment the subscribe resolves: a subscriber not yet confirmed by Redis would miss it. */
      const subscribeThenPublish = async (name: 'first' | 'second'): Promise<void> => {
        await pubsub.subscribe('orders', message => { received[name].push(message.value); });
        await pubsub.publish('orders', `after ${name}`);
      };
      await Promise.all([subscribeThenPublish('first'), subscribeThenPublish('second')]);

      await eventually(() => {
        expect(received.first).toEqual(expect.arrayContaining(['after first', 'after second']));
        expect(received.second).toEqual(expect.arrayContaining(['after first', 'after second']));
      });
    });

    it('refuses to reconfigure Pub/Sub while a subscription is live, and keeps it receiving', async () => {
      const client = redis.connectClient({ pubsub: { enabled: true, namespace: redis.newNamespace() } });
      const received: unknown[] = [];
      await client.pubsub.subscribe('orders', message => { received.push(message.value); });

      await expectPackageError(() => client.withPubSub({ maxMessageBytes: 1_024 }), PubSubError, 'PUBSUB_STATE');
      await client.pubsub.publish('orders', 1);
      await eventually(() => expect(received).toEqual([1]));
    });

    it('reconfigures Pub/Sub once its subscriptions are gone', async () => {
      const client = redis.connectClient({ pubsub: { enabled: true, namespace: redis.newNamespace() } });
      const subscription = await client.pubsub.subscribe('orders', () => undefined);
      await subscription.unsubscribe();
      expect(client.withPubSub({ maxMessageBytes: 1_024 }).config.pubsub.maxMessageBytes).toBe(1_024);
    });
  });
});
