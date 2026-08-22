import { createRedisClient } from '../src/index.js';

const standalone = createRedisClient({
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
});

// @ts-expect-error Cluster-only capability must not be exposed for standalone.
standalone.calculateSlot('user:1');

const sentinel = createRedisClient({
  mode: 'sentinel',
  sentinelNodes: [{ host: 'sentinel-1', port: 26379 }],
  sentinelMasterName: 'mymaster',
});

// @ts-expect-error Cluster-only capability must not be exposed for Sentinel.
sentinel.getClusterSlots();

const cluster = createRedisClient({
  mode: 'cluster',
  clusterNodes: [{ host: 'redis-1', port: 6379 }],
});

cluster.calculateSlot('{user:1}:session');
cluster.getClusterSlots();
