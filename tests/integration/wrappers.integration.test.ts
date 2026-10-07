import { describe, expect, it } from 'vitest';
import { CacheError, LockError } from '../../src/index.js';
import { expectPackageError } from '../support/errors.js';
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
    await connectClient({ rateLimit: { enabled: true, namespace } }).rateLimiter.consume('a');
    const keys = await redis.keysUnder(namespace);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${namespace}:a:\\d+$`));
  });

  it('writes a stream under the streams namespace', async () => {
    const namespace = redis.newNamespace();
    await connectClient({ streams: { enabled: true, namespace } }).streams.add('a', { k: 'v' });
    expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
  });

  it('reports CACHE_SERIALIZATION instead of crashing on a cached value that is not JSON', async () => {
    const namespace = redis.newNamespace();
    const { cache } = connectClient({ cache: { enabled: true, namespace } });
    await cache.set('k', { n: 1 });
    const [key] = await redis.keysUnder(namespace);
    await redis.observer.set(key!, 'not json', 'KEEPTTL');
    await expectPackageError(() => cache.get('k'), CacheError, 'CACHE_SERIALIZATION');
  });

  it('reports LOCK_HELD for work under a lock another holder has', async () => {
    const { lock } = connectClient({ lock: { enabled: true, namespace: redis.newNamespace() } });
    await lock.acquire('name');
    await expectPackageError(() => lock.using('name', async () => undefined), LockError, 'LOCK_HELD');
  });
});
