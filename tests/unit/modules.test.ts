import { createServer, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { RedisConfigurationError, SessionConfigurationError, createRedisClient, createRedisConnection, createSessionManagerFromRedis } from '../../src/index.js';
import type { RedisClientConfig, RedisConfig } from '../../src/index.js';
import { closedPort } from '../support/closed-port.js';
import { expectPackageError } from '../support/errors.js';

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

describe('client configuration validation', () => {
  it('rejects a mistyped mode instead of connecting as standalone', async () => {
    const config = { mode: 'clustr', host: '127.0.0.1', port: await closedPort(), lazyConnect: true } as unknown as RedisClientConfig;
    await expectPackageError(() => createRedisClient(config), RedisConfigurationError, 'REDIS_CONFIGURATION');
  });

  it('connects as standalone when mode is left undefined', async () => {
    expect(() => createRedisClient({ mode: undefined, host: '127.0.0.1', port: 6379, lazyConnect: true })).not.toThrow();
  });

  it('accepts Cluster startup nodes in every form ioredis takes', async () => {
    const port = await closedPort();
    expect(() => createRedisClient({ mode: 'cluster', nodes: [`127.0.0.1:${port}`, port, { port }], lazyConnect: true })).not.toThrow();
  });

  // The package reads replies in ioredis's default shape, which `replyMapping: 'resp3'` would change.
  it.each([
    ['standalone', (port: number) => ({ mode: 'standalone', host: '127.0.0.1', port, replyMapping: 'resp3' })],
    ['sentinel', (port: number) => ({ mode: 'sentinel', name: 'primary', sentinels: [{ host: '127.0.0.1', port }], replyMapping: 'resp3' })],
    ['cluster', (port: number) => ({ mode: 'cluster', nodes: [{ host: '127.0.0.1', port }], redisOptions: { replyMapping: 'resp3' } })],
  ])('rejects replyMapping on %s at every entry point', async (_topology, connection) => {
    const config = { ...connection(await closedPort()), lazyConnect: true } as unknown as RedisConfig;
    await expectPackageError(() => createRedisClient(config), RedisConfigurationError, 'REDIS_CONFIGURATION');
    await expectPackageError(() => createRedisConnection(config), RedisConfigurationError, 'REDIS_CONFIGURATION');
    await expectPackageError(() => createSessionManagerFromRedis(config, { enabled: true }), RedisConfigurationError, 'REDIS_CONFIGURATION');
  });

  describe('namespaces', () => {
    type ModuleSections = Pick<RedisClientConfig, 'cache' | 'lock' | 'rateLimit' | 'pubsub' | 'streams' | 'sessions'>;
    function clientWith(modules: ModuleSections) {
      return createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true, ...modules });
    }

    it('rejects two enabled modules on one namespace, naming both', async () => {
      await expectPackageError(() => clientWith({ cache: { enabled: true, namespace: 'app' }, sessions: { enabled: true, namespace: 'app' } }), RedisConfigurationError, 'REDIS_CONFIGURATION');
      expect(() => clientWith({ cache: { enabled: true, namespace: 'app' }, sessions: { enabled: true, namespace: 'app' } })).toThrow(/cache.*sessions|sessions.*cache/);
    });

    it('rejects a namespace that is a colon-delimited prefix of another', async () => {
      await expectPackageError(() => clientWith({ sessions: { enabled: true, namespace: 'app' }, cache: { enabled: true, namespace: 'app:cache' } }), RedisConfigurationError, 'REDIS_CONFIGURATION');
    });

    it('accepts a namespace that only shares leading characters with another', () => {
      expect(() => clientWith({ sessions: { enabled: true, namespace: 'app' }, cache: { enabled: true, namespace: 'application' } })).not.toThrow();
    });

    it('rejects a reconfiguration that would collide, and keeps the configuration in effect', async () => {
      const client = clientWith({ sessions: { enabled: true, namespace: 'app' }, cache: { enabled: true, namespace: 'cache' } });
      await expectPackageError(() => client.withCache({ namespace: 'app:cache' }), RedisConfigurationError, 'REDIS_CONFIGURATION');
      expect(client.config.cache.namespace).toBe('cache');
      expect(client.cache.key('a')).toBe('cache:a');
    });

    it('does not check the namespace of a disabled module', () => {
      expect(() => clientWith({ sessions: { enabled: true, namespace: 'app' }, cache: { enabled: false, namespace: 'app' } })).not.toThrow();
    });
  });
});

describe('createSessionManagerFromRedis configuration validation', () => {
  /** Runs `work` against a loopback port that accepts connections and counts them, so a test can tell whether anything connected. */
  async function withListener(work: (port: number) => Promise<void>): Promise<number> {
    const sockets: Socket[] = [];
    const server = createServer(socket => { sockets.push(socket); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await work((server.address() as AddressInfo).port);
      // Long enough for a connection opened on the way to the failure to reach the listener.
      await delay(100);
      return sockets.length;
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }

  it('rejects a mistyped mode without connecting', async () => {
    const connections = await withListener(async port => {
      const config = { mode: 'clustr', host: '127.0.0.1', port } as unknown as RedisConfig;
      await expectPackageError(() => createSessionManagerFromRedis(config, { enabled: true }), RedisConfigurationError, 'REDIS_CONFIGURATION');
    });
    expect(connections).toBe(0);
  });

  it('rejects disabled sessions without connecting', async () => {
    const connections = await withListener(async port => {
      await expectPackageError(() => createSessionManagerFromRedis({ mode: 'standalone', host: '127.0.0.1', port }, {}), SessionConfigurationError, 'SESSION_CONFIGURATION');
    });
    expect(connections).toBe(0);
  });

  it('rejects encryption it has no key manager for without connecting', async () => {
    const connections = await withListener(async port => {
      await expectPackageError(() => createSessionManagerFromRedis({ mode: 'standalone', host: '127.0.0.1', port }, { enabled: true, encryption: { enabled: true } }), SessionConfigurationError, 'SESSION_CONFIGURATION');
    });
    expect(connections).toBe(0);
  });
});
