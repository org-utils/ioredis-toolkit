import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import type { RedisClient, RedisClientConfig } from '../../src/index.js';
import { describeOnEachTopology, eventually } from '../support/redis.js';

describeOnEachTopology('client lifecycle against real Redis', redis => {
  /** Runs `work` on a client of its own, closed afterwards even if `work` fails, since closing it is what is under test. */
  async function withClient(config: RedisClientConfig, work: (client: RedisClient) => Promise<void>): Promise<void> {
    const client = createRedisClient(config);
    try { await work(client); } finally { await client.close(); }
  }

  it('leaves no connection open once closed, including the Pub/Sub subscriber', async () => {
    const connectionName = `lifecycle-${randomUUID()}`;
    await withClient({ ...redis.namedConnectionConfig(connectionName), cache: { enabled: true, namespace: redis.newNamespace() }, pubsub: { enabled: true, namespace: redis.newNamespace() } }, async client => {
      await client.cache.set('a', 1);
      await client.pubsub.subscribe('orders', () => undefined);
      expect(await redis.connectionsNamed(connectionName)).not.toEqual([]);

      await client.close();
      await eventually(async () => expect(await redis.connectionsNamed(connectionName)).toEqual([]));
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  it('closes a subscriber that reconfiguring Pub/Sub replaced', async () => {
    const connectionName = `lifecycle-${randomUUID()}`;
    await withClient({ ...redis.namedConnectionConfig(connectionName), pubsub: { enabled: true, namespace: redis.newNamespace() } }, async client => {
      // Pub/Sub is reconfigured only once its subscriptions are gone; the subscriber it replaced is closed in the background.
      await (await client.pubsub.subscribe('orders', () => undefined)).unsubscribe();
      await client.withPubSub({ namespace: redis.newNamespace() }).pubsub.subscribe('orders', () => undefined);

      await client.close();
      await eventually(async () => expect(await redis.connectionsNamed(connectionName)).toEqual([]));
    });
  });

  it('opens no connection for a module first used after the client is closed', async () => {
    const connectionName = `lifecycle-${randomUUID()}`;
    await withClient({ ...redis.namedConnectionConfig(connectionName), pubsub: { enabled: true, namespace: redis.newNamespace() }, streams: { enabled: true, namespace: redis.newNamespace() } }, async client => {
      await client.ping();
      await client.close();

      const { pubsub, streams } = client;
      await expect(pubsub.subscribe('orders', () => undefined)).rejects.toThrow('Connection is closed');
      // A publish runs on the shared connection, so it fails as ioredis fails any command once that is closed, which differs by topology.
      await expect(pubsub.publish('orders', 1)).rejects.toThrow();
      await expect(streams.read('events', { blockMs: 10 })).rejects.toThrow('Connection is closed');
      await eventually(async () => expect(await redis.connectionsNamed(connectionName)).toEqual([]));
    });
  });

  it('fails a blocking stream read on a Streams module from before the close with the same error', async () => {
    await withClient({ ...redis.connectionConfig(), streams: { enabled: true, namespace: redis.newNamespace() } }, async client => {
      const { streams } = client;
      await streams.read('events', { blockMs: 10 });
      await client.close();

      await expect(streams.read('events', { blockMs: 10 })).rejects.toThrow('Connection is closed');
    });
  });

  it('lets commands already sent complete before the shared connection is quit', async () => {
    const namespace = redis.newNamespace();
    await withClient({ ...redis.connectionConfig(), cache: { enabled: true, namespace } }, async client => {
      await client.cache.get('warm-up');
      const write = client.cache.set('a', 1);
      await client.close();
      await write;
      expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
    });
  });
});
