import { describe, expect, it } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import { RedisCache } from '../../src/cache/cache.js';
import { CacheError } from '../../src/cache/types.js';
import { RedisLock } from '../../src/lock/lock.js';
import { RedisRateLimiter } from '../../src/rate-limit/rate-limiter.js';
import { RedisStreams } from '../../src/streams/streams.js';

const fakeRedis = {} as never;

describe('module configuration', () => {
  it('normalizes all module defaults from one configuration object', () => {
    const client = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true });
    expect(client.config.cache.namespace).toBe('cache');
    expect(client.config.lock.defaultTtl).toBe(30);
    expect(client.config.rateLimit.windowSeconds).toBe(60);
    expect(client.config.pubsub.channelPrefix).toBe('events');
    expect(client.config.streams.keyPrefix).toBe('stream');
    expect(client.config.sessions.enabled).toBe(false);
  });

  it('merges and replaces module configuration fluently', () => {
    const client = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true, cache: { enabled: true, namespace: 'global', defaultTtl: 300 } });
    client.withCache({ defaultTtl: 60 });
    expect(client.config.cache.namespace).toBe('global');
    expect(client.config.cache.defaultTtl).toBe(60);
    client.withCache({ namespace: 'local' }, 'replace');
    expect(client.config.cache.namespace).toBe('local');
    expect(client.config.cache.defaultTtl).toBe(300);
  });
});

describe('module key helpers', () => {
  it('creates namespaced cache, lock, rate-limit and stream keys', () => {
    const cache = new RedisCache(fakeRedis, { enabled: true, namespace: 'c', defaultTtl: 1, maxValueBytes: 1000 });
    const lock = new RedisLock(fakeRedis, { enabled: true, namespace: 'l', defaultTtl: 1, maxTtl: 10 });
    const limiter = new RedisRateLimiter(fakeRedis, { enabled: true, namespace: 'r', windowSeconds: 60, maxRequests: 10 });
    const streams = new RedisStreams(fakeRedis, { enabled: true, keyPrefix: 's', maxEntries: 10, blockMs: 1 });
    expect(cache.key('a')).toBe('c:a');
    expect(lock.key('a')).toBe('l:a');
    expect(limiter.key('a', 120)).toBe('r:a:2');
    expect(streams.key('a')).toBe('s:a');
  });
});

describe('module enablement gating', () => {
  it('throws when accessing a disabled module through the shared client facade', () => {
    const client = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true });
    expect(() => client.cache).toThrow();
    expect(() => client.lock).toThrow();
    expect(() => client.rateLimiter).toThrow();
    expect(() => client.pubsub).toThrow();
    expect(() => client.streams).toThrow();
  });

  it('allows access once a module is explicitly enabled', () => {
    const client = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true, cache: { enabled: true } });
    expect(() => client.cache).not.toThrow();
  });
});

describe('RedisCache', () => {
  it('throws a typed CacheError instead of crashing on a malformed cached value', async () => {
    const get = async () => 'not json';
    const cache = new RedisCache({ get } as never, { enabled: true, namespace: 'c', defaultTtl: 1, maxValueBytes: 1000 });
    await expect(cache.get('k')).rejects.toThrow(CacheError);
  });
});

describe('RedisStreams', () => {
  it('rejects a group read that omits the consumer name', async () => {
    const streams = new RedisStreams(fakeRedis, { enabled: true, keyPrefix: 's', maxEntries: 10, blockMs: 1 });
    await expect(streams.read('s', { group: 'g' })).rejects.toThrow(RangeError);
  });
});
