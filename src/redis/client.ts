import Redis, { Cluster } from 'ioredis';
import { RedisConfigurationError } from './errors.js';
import type { RedisConfig, RedisConnection } from './types.js';

/**
 * Refuses ioredis's `replyMapping`, at the top level or in a Cluster's `redisOptions`. The package reads replies in
 * ioredis's default shape, which `replyMapping: 'resp3'` would change. The types leave it out, but a caller without them can still pass it.
 */
function refuseReplyMapping(config: RedisConfig): void {
  const replyMappingOf = (options: object | undefined): unknown => (options as { replyMapping?: unknown } | undefined)?.replyMapping;
  const refused = (path: string) => new RedisConfigurationError(`${path}: not supported, the package reads replies in ioredis's default shape`);
  if (replyMappingOf(config) !== undefined) throw refused('replyMapping');
  if (config.mode === 'cluster' && replyMappingOf(config.redisOptions) !== undefined) throw refused('redisOptions.replyMapping');
}

function buildConnection(config: RedisConfig): RedisConnection {
  refuseReplyMapping(config);
  if (config.mode === "cluster") {
    const { mode: _mode, nodes, redisOptions, ...options } = config;
    void _mode;
    // ioredis takes `redisOptions` left out but not set to undefined.
    return new Cluster(nodes, redisOptions === undefined ? options : { ...options, redisOptions });
  }
  if (config.mode === "sentinel") {
    const { mode: _mode, sentinels, name, ...options } = config;
    void _mode;
    // Without the failover detector, ioredis stays on the old master until Sentinel demotes it, about 10 s after a
    // failover, and every write the old master acknowledges meanwhile is lost (#121). With it, the connection moves
    // once Sentinel announces +switch-master. Duplicates (the Pub/Sub subscriber, stream readers) inherit it.
    return new Redis.Redis({ failoverDetector: true, ...options, sentinels, name });
  }
  const { mode: _mode, ...options } = config;
  void _mode;
  return new Redis.Redis(options);
}

/**
 * Creates a topology-appropriate ioredis connection. Always attaches a no-op
 * `'error'` listener: ioredis (like every Node `EventEmitter`) throws an uncaught
 * exception and crashes the process when an `'error'` event fires with zero
 * listeners. The client facade forwards this connection's errors to its `onError`
 * hook; a caller using the connection directly can add a listener of its own.
 */
export function createRedisConnection(config: RedisConfig): RedisConnection {
  const connection = buildConnection(config);
  connection.on('error', () => { /* prevents unhandled 'error' event crashes; add your own listener for observability */ });
  return connection;
}
