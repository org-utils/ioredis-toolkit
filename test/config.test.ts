import { describe, expect, it } from 'vitest';
import { RedisConfigSchema } from '../src/types.js';

describe('RedisConfigSchema', () => {
  it('defaults to standalone', () => {
    const config = RedisConfigSchema.parse({ host: 'localhost', port: 6379 });
    expect(config.mode).toBe('standalone');
  });

  it('requires Sentinel topology fields', () => {
    expect(() => RedisConfigSchema.parse({ mode: 'sentinel' })).toThrow();
  });

  it('requires Cluster topology fields', () => {
    expect(() => RedisConfigSchema.parse({ mode: 'cluster' })).toThrow();
  });

  it('rejects topology mixing', () => {
    expect(() => RedisConfigSchema.parse({
      mode: 'cluster',
      clusterNodes: [{ host: 'redis-1', port: 6379 }],
      sentinelNodes: [{ host: 'sentinel-1', port: 26379 }],
      sentinelMasterName: 'mymaster',
    })).toThrow();
  });

  it('rejects a non-zero database in Cluster mode', () => {
    expect(() => RedisConfigSchema.parse({
      mode: 'cluster',
      clusterNodes: [{ host: 'redis-1', port: 6379 }],
      database: 1,
    })).toThrow();
  });
});
