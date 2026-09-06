import type { Cluster, ClusterNode, ClusterOptions, Redis, RedisOptions } from 'ioredis';

/** Supported Redis deployment topologies. */
export type RedisMode = 'standalone' | 'sentinel' | 'cluster';

/** Connection options for a single Redis server. */
export interface StandaloneRedisConfig extends RedisOptions {
  /** Selects standalone Redis. Optional for backwards-compatible single-node configuration. */
  mode?: 'standalone';
}

/** Connection options for Redis Sentinel. */
export interface SentinelRedisConfig extends RedisOptions {
  /** Selects Sentinel mode. */
  mode: 'sentinel';
  /** Sentinel endpoints used to discover the current master. */
  sentinels: Array<{ host: string; port: number }>;
  /** Sentinel master service name. */
  name: string;
}

/** Connection options for Redis Cluster. */
export interface ClusterRedisConfig extends ClusterOptions {
  /** Selects Cluster mode. */
  mode: 'cluster';
  /** Initial cluster startup nodes. */
  nodes: ClusterNode[];
}

/** Union of supported Redis topology configurations. */
export type RedisConfig = StandaloneRedisConfig | SentinelRedisConfig | ClusterRedisConfig;

/** Runtime connection type created by this package. */
export type RedisConnection = Redis | Cluster;

/** Options controlling bounded fan-out against Redis Cluster nodes/slots. */
export interface ClusterFanoutOptions {
  /** Maximum number of concurrent node/slot operations. Defaults to a conservative value. */
  concurrency?: number;
}

/** Minimal Redis command surface consumed by the package modules. */
export interface RedisCommandClient {
  /** Reads a string value. */
  get(key: string): Promise<string | null>;
  /** Writes a string value with raw Redis option arguments. */
  set(key: string, value: string, ...args: string[]): Promise<string | null>;
  /** Performs legacy SETNX. */
  setnx(key: string, value: string): Promise<number>;
  /** Deletes one or more keys. */
  del(...keys: string[]): Promise<number>;
  /** Returns the number of existing keys. */
  exists(...keys: string[]): Promise<number>;
  /** Sets a TTL in seconds. */
  expire(key: string, seconds: number): Promise<number>;
  /** Sets a TTL in milliseconds. */
  pexpire(key: string, milliseconds: number): Promise<number>;
  /** Reads TTL in seconds. */
  ttl(key: string): Promise<number>;
  /** Adds one sorted-set member. */
  zadd(key: string, score: number, member: string): Promise<number>;
  /** Removes sorted-set members. */
  zrem(key: string, ...members: string[]): Promise<number>;
  /** Returns sorted-set cardinality. */
  zcard(key: string): Promise<number>;
  /** Reads one sorted-set member score. */
  zscore(key: string, member: string): Promise<string | null>;
  /** Reads sorted-set members by rank. */
  zrange(key: string, start: number, stop: number, ...args: string[]): Promise<string[]>;
  /** Reads sorted-set members by score. */
  zrangebyscore(key: string, min: string | number, max: string | number, ...args: string[]): Promise<string[]>;
  /** Pops the lowest-score sorted-set members. */
  zpopmin(key: string, count?: number): Promise<string[]>;
  /** Atomically increments an integer value. */
  incrby(key: string, increment: number): Promise<number>;
  /** Atomically decrements an integer value. */
  decrby(key: string, decrement: number): Promise<number>;
  /** Executes a cached Lua script by SHA. */
  evalsha(sha: string, numKeys: number, ...args: string[]): Promise<unknown>;
  /** Executes Lua source directly. */
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  /** Loads Lua source and returns its SHA-1. */
  script(command: 'LOAD', script: string): Promise<string>;
  /** Reads Redis server time. */
  time(): Promise<[string, string]>;
  /** Pings Redis. */
  ping(): Promise<string>;
  /** Scans keys from one Redis node. */
  scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
  /** Publishes a string message. */
  publish(channel: string, message: string): Promise<number>;
  /** Appends a Redis Stream entry. */
  xadd(key: string, ...args: string[]): Promise<string>;
  /** Executes an XGROUP CREATE operation. */
  xgroup(command: 'CREATE', key: string, group: string, id: string, ...args: string[]): Promise<string>;
  /** Reads a Redis Stream. */
  xread(...args: string[]): Promise<unknown>;
  /** Reads a Redis Stream through a consumer group. */
  xreadgroup(...args: string[]): Promise<unknown>;
  /** Acknowledges consumer-group entries. */
  xack(key: string, group: string, ...ids: string[]): Promise<number>;
  /** Deletes Stream entries. */
  xdel(key: string, ...ids: string[]): Promise<number>;
  /** Returns Stream length. */
  xlen(key: string): Promise<number>;
  /** Creates a Redis pipeline. */
  pipeline(): RedisPipeline;
  /** Reads multiple values in input-key order. */
  mget(...keys: string[]): Promise<Array<string | null>>;
  /** Creates a dedicated duplicate connection, e.g. for Pub/Sub consumers. */
  duplicateConnection(): RedisConnection;
  /** Reads multiple keys while preserving input order and grouping Cluster requests by slot. */
  mgetClusterAware(keys: string[], options?: ClusterFanoutOptions): Promise<Array<string | null>>;
  /** Scans all master nodes in Cluster mode or the standalone server otherwise. */
  scanCluster(pattern: string, count?: number, options?: ClusterFanoutOptions): Promise<string[]>;
  /** Scans and deletes matching keys without using `KEYS`, `FLUSHDB`, or cross-slot multi-key commands. */
  deletePatternClusterAware(pattern: string, options?: ClusterFanoutOptions): Promise<number>;
}

/** Minimal pipeline surface needed by this package. */
export interface RedisPipeline {
  /** Queues GET. */
  get(key: string): RedisPipeline;
  /** Queues EXISTS. */
  exists(key: string): RedisPipeline;
  /** Queues DEL. */
  del(...keys: string[]): RedisPipeline;
  /** Queues ZRANGE. */
  zrange(key: string, start: number, stop: number, ...args: string[]): RedisPipeline;
  /** Queues ZREM. */
  zrem(key: string, ...members: string[]): RedisPipeline;
  /** Queues ZSCORE. */
  zscore(key: string, member: string): RedisPipeline;
  /** Queues SET. */
  set(key: string, value: string, ...args: string[]): RedisPipeline;
  /** Queues EXPIRE. */
  expire(key: string, seconds: number): RedisPipeline;
  /** Executes the pipeline. Each tuple contains a command-level error and result. */
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}
