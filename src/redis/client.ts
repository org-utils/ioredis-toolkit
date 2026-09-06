import Redis, { Cluster } from 'ioredis';
import type { RedisConfig, RedisConnection } from './types.js';

function buildConnection(config: RedisConfig): RedisConnection {
  if (config.mode === "cluster") {
    const { mode: _mode, nodes, ...options } = config;
    void _mode;
    return new Cluster(nodes, options);
  }
  if (config.mode === "sentinel") {
    const { mode: _mode, sentinels, name, ...options } = config;
    void _mode;
    return new Redis.Redis({ ...options, sentinels, name });
  }
  const { mode: _mode, ...options } = config;
  void _mode;
  return new Redis.Redis(options);
}

/**
 * Creates a topology-appropriate ioredis connection. Always attaches a no-op
 * `'error'` listener: ioredis (like every Node `EventEmitter`) throws an uncaught
 * exception and crashes the process when an `'error'` event fires with zero
 * listeners. Attaching this default does not prevent callers from adding their
 * own listener on the returned connection for real observability/alerting.
 */
export function createRedisConnection(config: RedisConfig): RedisConnection {
  const connection = buildConnection(config);
  connection.on('error', () => { /* prevents unhandled 'error' event crashes; add your own listener for observability */ });
  return connection;
}
