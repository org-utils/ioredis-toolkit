import { describe, expect, it } from 'vitest';
import { CacheError } from '../../src/index.js';
import { connectClient, redisFixture, redisUrl } from '../support/redis.js';

describe.skipIf(!redisUrl)('convenience wrappers against real Redis', () => {
  const redis = redisFixture();

  it('writes a cache entry under the cache namespace', async () => {
    const namespace = redis.newNamespace();
    await connectClient({ cache: { enabled: true, namespace } }).cache.set('a', { n: 1 });
    expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
  });

  it('writes a lock under the lock namespace', async () => {
    const namespace = redis.newNamespace();
    await connectClient({ lock: { enabled: true, namespace } }).lock.acquire('a');
    expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
  });

  it('writes a rate-limit window under the rate-limit namespace', async () => {
    const namespace = redis.newNamespace();
    await connectClient({ rateLimit: { enabled: true, namespace, windowSeconds: 60 } }).rateLimiter.consume('a', 1, 120);
    expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a:2`]);
  });

  it('writes a stream under the streams namespace', async () => {
    const keyPrefix = redis.newNamespace();
    await connectClient({ streams: { enabled: true, keyPrefix } }).streams.add('a', { k: 'v' });
    expect(await redis.keysUnder(keyPrefix)).toEqual([`${keyPrefix}:a`]);
  });

  it('throws a typed CacheError instead of crashing on a malformed cached value', async () => {
    const namespace = redis.newNamespace();
    const { cache } = connectClient({ cache: { enabled: true, namespace } });
    await cache.set('k', { n: 1 });
    const [key] = await redis.keysUnder(namespace);
    await redis.observer.set(key!, 'not json', 'KEEPTTL');
    await expect(cache.get('k')).rejects.toThrow(CacheError);
  });
});
