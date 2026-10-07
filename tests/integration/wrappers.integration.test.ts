import { describe, expect, it } from 'vitest';
import { CacheError } from '../../src/index.js';
import { connectClient, keysUnder, redisFixture, redisUrl } from '../support/redis.js';

describe.skipIf(!redisUrl)('convenience wrappers against real Redis', () => {
  const redis = redisFixture();

  it('writes a cache entry under the cache namespace', async () => {
    const namespace = redis.namespace();
    await connectClient({ cache: { enabled: true, namespace } }).cache.set('a', { n: 1 });
    expect(await keysUnder(redis.observer, namespace)).toEqual([`${namespace}:a`]);
  });

  it('writes a lock under the lock namespace', async () => {
    const namespace = redis.namespace();
    await connectClient({ lock: { enabled: true, namespace } }).lock.acquire('a');
    expect(await keysUnder(redis.observer, namespace)).toEqual([`${namespace}:a`]);
  });

  it('writes a rate-limit window under the rate-limit namespace', async () => {
    const namespace = redis.namespace();
    await connectClient({ rateLimit: { enabled: true, namespace } }).rateLimiter.consume('a');
    const keys = await keysUnder(redis.observer, namespace);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${namespace}:a:\\d+$`));
  });

  it('writes a stream under the streams key prefix', async () => {
    const keyPrefix = redis.namespace();
    await connectClient({ streams: { enabled: true, keyPrefix } }).streams.add('a', { k: 'v' });
    expect(await keysUnder(redis.observer, keyPrefix)).toEqual([`${keyPrefix}:a`]);
  });

  it('throws a typed CacheError instead of crashing on a malformed cached value', async () => {
    const namespace = redis.namespace();
    const { cache } = connectClient({ cache: { enabled: true, namespace } });
    await cache.set('k', { n: 1 });
    const [key] = await keysUnder(redis.observer, namespace);
    await redis.observer.set(key!, 'not json', 'KEEPTTL');
    await expect(cache.get('k')).rejects.toThrow(CacheError);
  });
});
