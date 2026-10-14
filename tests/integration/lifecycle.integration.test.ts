import { randomUUID } from 'node:crypto';
import { Cluster } from 'ioredis';
import { expect, it } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import type { RedisClientConfig } from '../../src/index.js';
import { describeOnEachTopology, eventually } from '../support/redis.js';

describeOnEachTopology('client lifecycle against real Redis', redis => {
  /** The topology's connection config, with every connection the package opens named `connectionName`. */
  function namedConfig(connectionName: string): RedisClientConfig {
    const config = redis.connectionConfig();
    return config.mode === 'cluster' ? { ...config, redisOptions: { connectionName } } : { ...config, connectionName };
  }

  /** The connections any server holds open under a client name, as `CLIENT LIST` reports them. */
  async function connectionsNamed(name: string): Promise<string[]> {
    const servers = redis.observer instanceof Cluster ? redis.observer.nodes('all') : [redis.observer];
    const lists = await Promise.all(servers.map(async server => await server.client('LIST') as string));
    return lists.flatMap(list => list.split('\n')).filter(line => line.includes(` name=${name} `));
  }

  it('leaves no connection open once closed, including the Pub/Sub subscriber', async () => {
    const connectionName = `lifecycle-${randomUUID()}`;
    const client = createRedisClient({ ...namedConfig(connectionName), cache: { enabled: true, namespace: redis.newNamespace() }, pubsub: { enabled: true, namespace: redis.newNamespace() } });
    await client.cache.set('a', 1);
    await client.pubsub.subscribe('orders', () => undefined);
    expect(await connectionsNamed(connectionName)).not.toEqual([]);

    await client.close();
    await eventually(async () => expect(await connectionsNamed(connectionName)).toEqual([]));
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('lets commands already sent complete before the shared connection is quit', async () => {
    const namespace = redis.newNamespace();
    const client = createRedisClient({ ...redis.connectionConfig(), cache: { enabled: true, namespace } });
    await client.cache.get('warm-up');
    const write = client.cache.set('a', 1);
    await client.close();
    await write;
    expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
  });
});
