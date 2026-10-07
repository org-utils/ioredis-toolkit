import { describe, expect, it } from 'vitest';
import { createRedisClient } from '../../src/index.js';

describe('module configuration', () => {
  it('normalizes all module defaults from one configuration object', () => {
    const client = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true });
    expect(client.config.cache.namespace).toBe('cache');
    expect(client.config.lock.defaultTtl).toBe(30);
    expect(client.config.rateLimit.windowSeconds).toBe(60);
    expect(client.config.pubsub.namespace).toBe('events');
    expect(client.config.streams.namespace).toBe('stream');
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

describe('streams', () => {
  it('rejects a group read that omits the consumer name', async () => {
    const { streams } = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true, streams: { enabled: true } });
    await expect(streams.read('s', { group: 'g' })).rejects.toThrow(RangeError);
  });
});
