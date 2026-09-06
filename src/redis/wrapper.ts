import { Cluster } from 'ioredis';
import { redisHashSlot } from './cluster.js';
import type { ClusterFanoutOptions, RedisCommandClient, RedisConnection, RedisPipeline } from './types.js';
export type { ClusterFanoutOptions } from './types.js';

/**
 * Topology-independent Redis command adapter.
 *
 * The wrapper deliberately exposes only the commands required by this package and
 * centralizes Cluster-aware multi-key behavior so higher-level modules remain topology agnostic.
 */
export class RedisClientWrapper implements RedisCommandClient {
  /** Creates a wrapper around an existing ioredis Redis or Cluster connection. */
  constructor(private readonly client: RedisConnection) {}
  /** Reads a string value. */
  get(key: string): Promise<string | null> { return this.client.get(key); }
  /** Writes a string value using raw Redis option arguments. */
  set(key: string, value: string, ...args: string[]): Promise<string | null> {
    return (this.client.set as unknown as (...a: string[]) => Promise<string | null>)(key, value, ...args);
  }
  /** Reads multiple values in input-key order. */
  mget(...keys: string[]): Promise<Array<string | null>> {
    return (this.client.mget as unknown as (...a: string[]) => Promise<Array<string | null>>)(...keys);
  }
  /** Performs SETNX. */
  setnx(key: string, value: string): Promise<number> { return this.client.setnx(key, value); }
  /** Deletes keys, splitting cross-slot deletions into safe groups in Cluster mode. */
  async del(...keys: string[]): Promise<number> {
    if (keys.length <= 1 || !(this.client instanceof Cluster)) return this.client.del(...keys);
    const groups = new Map<number, string[]>();
    for (const key of keys) {
      const slot = redisHashSlot(key);
      const group = groups.get(slot) ?? [];
      group.push(key);
      groups.set(slot, group);
    }
    let deleted = 0;
    await boundedMap([...groups.values()], 4, async group => {
      for (const batch of chunk(group, 200)) deleted += await this.client.del(...batch);
    });
    return deleted;
  }
  /** Returns the number of existing keys. */
  exists(...keys: string[]): Promise<number> { return this.client.exists(...keys); }
  /** Sets an expiration in seconds. */
  expire(key: string, seconds: number): Promise<number> { return this.client.expire(key, seconds); }
  /** Sets an expiration in milliseconds. */
  pexpire(key: string, milliseconds: number): Promise<number> { return this.client.pexpire(key, milliseconds); }
  /** Reads remaining TTL in seconds. */
  ttl(key: string): Promise<number> { return this.client.ttl(key); }
  /** Adds one sorted-set member. */
  zadd(key: string, score: number, member: string): Promise<number> { return this.client.zadd(key, score, member); }
  /** Removes sorted-set members. */
  zrem(key: string, ...members: string[]): Promise<number> { return this.client.zrem(key, ...members); }
  /** Returns sorted-set cardinality. */
  zcard(key: string): Promise<number> { return this.client.zcard(key); }
  /** Reads a sorted-set member score. */
  zscore(key: string, member: string): Promise<string | null> { return this.client.zscore(key, member); }
  /** Reads sorted-set members by rank. */
  zrange(key: string, start: number, stop: number, ...args: string[]): Promise<string[]> {
    return (this.client.zrange as unknown as (...a: string[]) => Promise<string[]>)(key, String(start), String(stop), ...args);
  }
  /** Reads sorted-set members by score. */
  zrangebyscore(key: string, min: string | number, max: string | number, ...args: string[]): Promise<string[]> {
    return (this.client.zrangebyscore as unknown as (...a: string[]) => Promise<string[]>)(key, String(min), String(max), ...args);
  }
  /** Pops the lowest sorted-set members. */
  zpopmin(key: string, count?: number): Promise<string[]> { return count === undefined ? this.client.zpopmin(key) : this.client.zpopmin(key, count); }
  /** Atomically increments an integer. */
  incrby(key: string, increment: number): Promise<number> { return this.client.incrby(key, increment); }
  /** Atomically decrements an integer. */
  decrby(key: string, decrement: number): Promise<number> { return this.client.decrby(key, decrement); }
  /** Executes a cached Lua script. */
  evalsha(sha: string, numKeys: number, ...args: string[]): Promise<unknown> { return this.client.evalsha(sha, numKeys, ...args); }
  /** Executes Lua source. */
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> { return this.client.eval(script, numKeys, ...args); }
  /** Loads a Lua script. */
  script(command: 'LOAD', script: string): Promise<string> {
    return this.client.script(command, script) as Promise<string>;
  }
  /** Reads server time. */
  time(): Promise<[string, string]> {
    return (this.client.time() as Promise<[number, number]>).then(([seconds, microseconds]) => [String(seconds), String(microseconds)]);
  }
  /** Pings Redis. */
  ping(): Promise<string> { return this.client.ping(); }
  /** Scans one Redis node or the standalone server. */
  scan(cursor: string, ...args: string[]): Promise<[string, string[]]> {
    return (this.client.scan as unknown as (...a: string[]) => Promise<[string, string[]]>)(cursor, ...args);
  }
  /** Publishes a string message. */
  publish(channel: string, message: string): Promise<number> { return this.client.publish(channel, message); }
  /** Appends a Stream entry. */
  xadd(key: string, ...args: string[]): Promise<string> {
    return (this.client.xadd as unknown as (...a: string[]) => Promise<string | null>)(key, ...args) as Promise<string>;
  }
  /** Creates a consumer group. */
  xgroup(command: 'CREATE', key: string, group: string, id: string, ...args: string[]): Promise<string> {
    return (this.client.xgroup as unknown as (...a: string[]) => Promise<string>)(command, key, group, id, ...args);
  }
  /** Reads Stream entries. */
  xread(...args: string[]): Promise<unknown> {
    return (this.client.xread as unknown as (...a: string[]) => Promise<unknown>)(...args);
  }
  /** Reads Stream entries through a consumer group. */
  xreadgroup(...args: string[]): Promise<unknown> {
    return (this.client.xreadgroup as unknown as (...a: string[]) => Promise<unknown>)(...args);
  }
  /** Acknowledges Stream entries. */
  xack(key: string, group: string, ...ids: string[]): Promise<number> { return this.client.xack(key, group, ...ids); }
  /** Deletes Stream entries. */
  xdel(key: string, ...ids: string[]): Promise<number> { return this.client.xdel(key, ...ids); }
  /** Returns Stream length. */
  xlen(key: string): Promise<number> { return this.client.xlen(key); }
  /** Creates a pipeline. Command-level errors must be inspected in the returned tuples. */
  pipeline(): RedisPipeline { return this.client.pipeline() as unknown as RedisPipeline; }
  /** Creates a dedicated duplicate connection for Pub/Sub consumers. */
  duplicateConnection(): RedisConnection { return this.client.duplicate() as RedisConnection; }

  /** Reads multiple keys while preserving input order and grouping Cluster requests by slot. */
  async mgetClusterAware(keys: string[], options: ClusterFanoutOptions = {}): Promise<Array<string | null>> {
    if (keys.length === 0) return [];
    if (!(this.client instanceof Cluster)) return this.client.mget(...keys);
    const grouped = new Map<number, Array<{ key: string; index: number }>>();
    keys.forEach((key, index) => {
      const slot = redisHashSlot(key);
      const group = grouped.get(slot) ?? [];
      group.push({ key, index });
      grouped.set(slot, group);
    });
    const result: Array<string | null> = Array.from({ length: keys.length }, () => null);
    await boundedMap([...grouped.values()], options.concurrency ?? 4, async group => {
      const values = await this.client.mget(...group.map(item => item.key));
      values.forEach((value, index) => { result[group[index]!.index] = value; });
    });
    return result;
  }

  /** Scans all master nodes in Cluster mode or the standalone server otherwise. */
  async scanCluster(pattern: string, count = 500, options: ClusterFanoutOptions = {}): Promise<string[]> {
    if (!(this.client instanceof Cluster)) {
      const out: string[] = [];
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', String(count));
        out.push(...keys);
        cursor = next;
      } while (cursor !== '0');
      return out;
    }
    const nodes = this.client.nodes('master');
    const out: string[] = [];
    await boundedMap(nodes, options.concurrency ?? 2, async node => {
      let cursor = '0';
      do {
        const [next, keys] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', String(count));
        out.push(...keys);
        cursor = next;
      } while (cursor !== '0');
    });
    return out;
  }

  /** Scans and deletes matching keys without using `KEYS`, `FLUSHDB`, or cross-slot multi-key commands. */
  async deletePatternClusterAware(pattern: string, options: ClusterFanoutOptions = {}): Promise<number> {
    const keys = await this.scanCluster(pattern, 500, options);
    if (keys.length === 0) return 0;
    if (!(this.client instanceof Cluster)) return this.del(...keys);
    const groups = new Map<number, string[]>();
    for (const key of keys) {
      const slot = redisHashSlot(key);
      const group = groups.get(slot) ?? [];
      group.push(key);
      groups.set(slot, group);
    }
    let deleted = 0;
    await boundedMap([...groups.values()], options.concurrency ?? 4, async group => {
      for (const batch of chunk(group, 200)) deleted += await this.del(...batch);
    });
    return deleted;
  }
}

/** Runs bounded concurrent asynchronous work over an array. */
async function boundedMap<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const width = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
}

/** Splits an array into bounded chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
