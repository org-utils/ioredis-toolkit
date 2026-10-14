import { Cluster } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { CacheError, LockError, RedisClient } from '../../src/index.js';
import { expectPackageError } from '../support/errors.js';
import { describeOnEachTopology } from '../support/redis.js';

describeOnEachTopology('convenience wrappers against real Redis', redis => {
  it('writes a cache entry under the cache namespace', async () => {
    const namespace = redis.newNamespace();
    await redis.connectClient({ cache: { enabled: true, namespace } }).cache.set('a', { n: 1 });
    expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
  });

  it('writes a lock under the lock namespace', async () => {
    const namespace = redis.newNamespace();
    await redis.connectClient({ lock: { enabled: true, namespace } }).lock.acquire('a');
    expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
  });

  it('writes a rate-limit window under the rate-limit namespace', async () => {
    const namespace = redis.newNamespace();
    await redis.connectClient({ rateLimit: { enabled: true, namespace } }).rateLimiter.consume('a');
    const keys = await redis.keysUnder(namespace);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${namespace}:\\{a\\}:\\d+$`));
  });

  it('writes a stream under the streams namespace', async () => {
    const namespace = redis.newNamespace();
    await redis.connectClient({ streams: { enabled: true, namespace } }).streams.add('a', { k: 'v' });
    expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
  });

  it('reports CACHE_SERIALIZATION instead of crashing on a cached value that is not JSON', async () => {
    const namespace = redis.newNamespace();
    const { cache } = redis.connectClient({ cache: { enabled: true, namespace } });
    await cache.set('k', { n: 1 });
    const [key] = await redis.keysUnder(namespace);
    await redis.observer.set(key!, 'not json', 'KEEPTTL');
    await expectPackageError(() => cache.get('k'), CacheError, 'CACHE_SERIALIZATION');
  });

  it('reports LOCK_HELD for work under a lock another holder has', async () => {
    const { lock } = redis.connectClient({ lock: { enabled: true, namespace: redis.newNamespace() } });
    await lock.acquire('name');
    await expectPackageError(() => lock.using('name', async () => undefined), LockError, 'LOCK_HELD');
  });

  describe('cache.clear() and cache.delete()', () => {
    /** Writes `count` cache entries under a namespace, spread over many hash slots. */
    async function seed(namespace: string, count: number): Promise<void> {
      // One MSET per hash tag, since a cluster refuses one across slots; 1,000 tags spread the keys over every master.
      const byTag = new Map<number, string[]>();
      for (let i = 0; i < count; i += 1) {
        const tag = i % 1_000;
        const group = byTag.get(tag) ?? [];
        group.push(`${namespace}:{${tag}}:${i}`, '1');
        byTag.set(tag, group);
      }
      for (const group of byTag.values()) await redis.observer.mset(...group);
    }

    it('clears a namespace of 200,000 entries', async () => {
      const namespace = redis.newNamespace();
      await seed(namespace, 200_000);
      const { cache } = redis.connectClient({ cache: { enabled: true, namespace } });
      expect(await cache.clear()).toBe(200_000);
      expect(await redis.keysUnder(namespace)).toEqual([]);
    }, 120_000);

    it('deletes in batches of at most 500 keys', async () => {
      const namespace = redis.newNamespace();
      await seed(namespace, 5_000);
      const { cache } = redis.connectClient({ cache: { enabled: true, namespace } });
      const sent = await redis.commandsFromClientsOf(namespace, () => cache.clear());
      const deletes = sent.filter(([command]) => command!.toLowerCase() === 'del');
      expect(deletes).not.toEqual([]);
      for (const [, ...keys] of deletes) expect(keys.length).toBeLessThanOrEqual(500);
      expect(await redis.keysUnder(namespace)).toEqual([]);
    });

    it('deletes no keys, and returns 0, when given none', async () => {
      const { cache } = redis.connectClient({ cache: { enabled: true, namespace: redis.newNamespace() } });
      expect(await cache.delete()).toBe(0);
    });

    // A second copy of ioredis in an application has its own Cluster class, which this package's does not recognise by type.
    it.skipIf(redis.topology !== 'cluster')('clears and deletes across slots on a cluster connection from another copy of ioredis', async () => {
      const namespace = redis.newNamespace();
      const { mode: _mode, nodes, ...options } = redis.connectionConfig() as Extract<ReturnType<typeof redis.connectionConfig>, { mode: 'cluster' }>;
      void _mode;
      const cluster = new Cluster(nodes, options);
      const foreign = new Proxy(cluster, { getPrototypeOf: () => Object.prototype });
      expect(foreign instanceof Cluster).toBe(false);
      const client = new RedisClient(foreign, { ...redis.connectionConfig(), cache: { enabled: true, namespace } });
      try {
        await seed(namespace, 2_000);
        expect(await client.cache.delete('{0}:0', '{1}:1', '{2}:2')).toBe(3);
        expect(await client.cache.clear()).toBe(1_997);
        expect(await redis.keysUnder(namespace)).toEqual([]);
      } finally {
        await client.close();
      }
    });
  });
});
