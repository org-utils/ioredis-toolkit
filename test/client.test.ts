import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import MockRedis from 'ioredis-mock';

/**
 * The runner hoists vi.mock factories above all imports, so the factory MUST
 * import ioredis-mock itself. Additionally, modules that (transitively) import
 * 'ioredis' - here `src/client.js` and `helpers/fake-redis.js` - are imported
 * dynamically below: a static import combined with vi.mock('ioredis') can
 * deadlock the module loader under Bun's test runner.
 */
vi.mock('ioredis', async () => {
  const { default: MockBase, Cluster: ClusterBase } = await import(
    'ioredis-mock'
  );

  /**
   * ioredis-mock ignores the `mset(flatArray)` overload that ioredis supports
   * and {@link RedisClientWrapper} uses, so normalize it here.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function patchMset(instance: any): void {
    const original = instance.mset;
    instance.mset = (...msetArgs: any[]) => {
      if (msetArgs.length === 1 && Array.isArray(msetArgs[0])) {
        return original(...(msetArgs[0] as any[]));
      }
      return original(...msetArgs);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class MockRedis extends MockBase {
    constructor(...args: ConstructorParameters<typeof MockBase>) {
      super(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      patchMset(this);
    }
  }
  const MockClusterBase = ClusterBase;
  class MockCluster extends MockClusterBase {
    constructor(...args: ConstructorParameters<typeof MockClusterBase>) {
      super(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      patchMset(this);
    }
  }

  return {
    default: MockRedis,
    Cluster: MockCluster,
    Redis: MockRedis,
    RedisOptions: {},
  };
});

type ClientModule = typeof import('../src/client.js');
type RedisClientWrapper = InstanceType<ClientModule['RedisClientWrapper']>;
type ClusterRedisConfigInput = import('../src/types.js').ClusterRedisConfigInput;
type MockClient = InstanceType<typeof MockRedis>;

const { RedisClientWrapper } = await import('../src/client.js');

const silentLogger: import('../src/logger.js').LoggerLike = (() => {
  const l: import('../src/logger.js').LoggerLike = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => l,
  };
  return l;
})();

const config = {
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
  // password: 'secret',
  maxRetries: 3,
  retryDelay: 100,
  connectionTimeout: 5000,
} as const;

function rawClient(wrapper: RedisClientWrapper): MockClient {
  return wrapper.getRawClient() as unknown as MockClient;
}

describe('RedisClientWrapper', () => {
  let wrapper: RedisClientWrapper;

  beforeEach(async () => {
    wrapper = new RedisClientWrapper(config, silentLogger);
    await rawClient(wrapper).flushall();
  });

  afterEach(async () => {
    // Release mock clients so no handles/listeners are left behind.
    try {
      await wrapper.close();
    } catch {
      // already closed
    }
  });

  it('creates a standalone client', () => {
    expect(wrapper.isCluster()).toBe(false);
    expect(wrapper.getClusterNodes()).toEqual([]);
  });

  it('ping returns true when PONG', async () => {
    expect(await wrapper.ping()).toBe(true);
  });

  it('get returns stored value or null', async () => {
    expect(await wrapper.get('missing')).toBe(null);

    await wrapper.set('name', 'redis');
    expect(await wrapper.get('name')).toBe('redis');
  });

  it('set with ttl stores with an expiry', async () => {
    await wrapper.set('temp', 'v', 60);
    expect(await wrapper.ttl('temp')).toBeGreaterThan(0);
    expect(await wrapper.ttl('temp')).toBeLessThanOrEqual(60);
  });

  it('setnx sets once and returns 0 afterwards', async () => {
    expect(await wrapper.setnx('once', 'a')).toBe(1);
    expect(await wrapper.setnx('once', 'b')).toBe(0);
    expect(await wrapper.get('once')).toBe('a');
  });

  it('incr and decr', async () => {
    expect(await wrapper.incr('counter')).toBe(1);
    expect(await wrapper.incr('counter')).toBe(2);
    expect(await wrapper.decr('counter')).toBe(1);
  });

  it('del and exists', async () => {
    await wrapper.set('k', 'v');
    expect(await wrapper.exists('k')).toBe(1);
    expect(await wrapper.del('k')).toBe(1);
    expect(await wrapper.exists('k')).toBe(0);
  });

  it('mget and mset', async () => {
    await wrapper.mset(['a', '1'], ['b', '2']);
    expect(await wrapper.mget('a', 'b', 'c')).toEqual(['1', '2', null]);
  });

  it('hash operations', async () => {
    await wrapper.hset('user', 'name', 'alice');
    await wrapper.hset('user', 'age', '30');
    expect(await wrapper.hget('user', 'name')).toBe('alice');
    expect(await wrapper.hgetall('user')).toEqual({ name: 'alice', age: '30' });
    expect(await wrapper.hdel('user', 'name')).toBe(1);
  });

  it('returns results even when slow command logging is enabled', async () => {
    const slow = new RedisClientWrapper(
      { ...config, slowCommandThreshold: 0 } as const,
      silentLogger
    );
    try {
      await slow.set('k', 'v');
      expect(await slow.get('k')).toBe('v');
    } finally {
      await slow.close();
    }
  });

  it('close quits the client', async () => {
    const quitSpy = vi.spyOn(rawClient(wrapper), 'quit');
    await wrapper.close();
    expect(quitSpy).toHaveBeenCalled();
  });

  describe('cluster mode', () => {
    const clusterConfig: ClusterRedisConfigInput = {
      mode: 'cluster',
      clusterNodes: [
        { host: 'localhost', port: 7000 },
        { host: 'localhost', port: 7001 },
      ],
    };

    it('creates a cluster client', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);
      try {
        expect(cluster.isCluster()).toBe(true);
        expect(cluster.getClusterNodes()).toHaveLength(2);
      } finally {
        await cluster.close();
      }
    });

    it('mget groups keys by slot and falls back when getSlot is unavailable', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);
      try {
        await cluster.mset(['a', '1'], ['b', '2']);
        expect(await cluster.mget('a', 'b')).toEqual(['1', '2']);
        expect(await cluster.mget('a', 'b', 'c')).toEqual(['1', '2', null]);
      } finally {
        await cluster.close();
      }
    });

    it('mset splits pairs across slots and stores all of them', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);
      try {
        const result = await cluster.mset(['x', '1'], ['y', '2']);
        expect(result).toBe('OK');
        expect(await cluster.mget('x', 'y')).toEqual(['1', '2']);
      } finally {
        await cluster.close();
      }
    });

    it('scanIterator scans all nodes', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);
      try {
        const keys: string[] = [];
        for await (const key of cluster.scanIterator('*')) {
          keys.push(key);
        }
        expect(Array.isArray(keys)).toBe(true);
      } finally {
        await cluster.close();
      }
    });

    it('calculateSlot uses real CRC16 with hash tag support', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);
      try {
        const withoutTag = cluster.calculateSlot('user:1001');
        const taggedA = cluster.calculateSlot('{user}:a');
        const taggedB = cluster.calculateSlot('{user}:b');
        expect(taggedA).toBe(taggedB);
        expect(withoutTag).toBeGreaterThanOrEqual(0);
        expect(withoutTag).toBeLessThan(16384);
      } finally {
        await cluster.close();
      }
    });
  });
});
