import type { Cluster, Redis } from 'ioredis';
import { isCluster, redisHashSlot } from './cluster.js';
import { closeConnection } from './lifecycle.js';
import { checkHealth, type RedisHealth, type RedisHealthOptions } from './health.js';
import type { ClusterFanoutOptions, RedisCommandClient, RedisConnection, RedisPipeline } from './types.js';
export type { ClusterFanoutOptions } from './types.js';

/**
 * The error for work that would need a connection the package has closed: the one ioredis rejects a command on a closed
 * connection with, so work after a close fails the same way whether or not it needed a new connection.
 */
export function connectionClosedError(): Error { return new Error('Connection is closed.'); }

/** The most keys one DEL names, and the COUNT hint each SCAN page is asked for. */
const DELETE_BATCH = 500;

/**
 * Topology-independent Redis command adapter.
 *
 * The wrapper deliberately exposes only the commands required by this package and
 * centralizes Cluster-aware multi-key behavior so higher-level modules remain topology agnostic.
 */
export class RedisClientWrapper implements RedisCommandClient {
  /** Whether {@link close} has been called, after which no connection is duplicated from this one. */
  private closed = false;
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
  /** Deletes keys in DELs of at most {@link DELETE_BATCH} keys, each within one slot in Cluster mode. Deleting no keys contacts no server. */
  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    if (!isCluster(this.client)) return deleteInBatches(this.client, keys);
    let deleted = 0;
    await boundedMap([...groupBySlot(keys).values()], 4, async group => {
      // Not `deleted += await …`, which reads the total before the wait and so loses what concurrent groups add meanwhile.
      const count = await deleteInBatches(this.client, group);
      deleted += count;
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
  /** Checks that Redis answers, within a timeout of its own. A Redis failure resolves as `unhealthy` rather than rejecting. */
  health(options: RedisHealthOptions = {}): Promise<RedisHealth> { return checkHealth(this.client, options); }
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
  /**
   * Creates a dedicated duplicate connection, for a Pub/Sub subscriber or a stream reader. Once this wrapper is closed it
   * throws instead, with the error ioredis gives a command on a closed connection, so nothing is opened that close() missed.
   */
  duplicateConnection(): RedisConnection {
    if (this.closed) throw connectionClosedError();
    // Each topology's duplicate() is generic, so a call on the union type does not type-check.
    return isCluster(this.client) ? this.client.duplicate() : this.client.duplicate();
  }
  /** Closes the wrapped connection: quit if it is up, disconnected otherwise. Idempotent. */
  async close(): Promise<void> { this.closed = true; await closeConnection(this.client); }

  /** Reads multiple keys while preserving input order and grouping Cluster requests by slot. */
  async mgetClusterAware(keys: string[], options: ClusterFanoutOptions = {}): Promise<Array<string | null>> {
    if (keys.length === 0) return [];
    if (!isCluster(this.client)) return this.client.mget(...keys);
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
    const out: string[] = [];
    await this.scanPages(pattern, count, options, async page => { out.push(...page); });
    return out;
  }

  /**
   * Scans and deletes matching keys without using `KEYS`, `FLUSHDB`, or cross-slot multi-key commands. Each page is
   * deleted as the scan returns it, in DELs of at most {@link DELETE_BATCH} keys, so neither the matching keys nor any
   * one command grows with the keyspace.
   */
  async deletePatternClusterAware(pattern: string, options: ClusterFanoutOptions = {}): Promise<number> {
    let deleted = 0;
    await this.scanPages(pattern, DELETE_BATCH, options, async (page, node) => {
      // As in del(), each count is awaited before it is added.
      const count = node ? await deleteOnNode(this.client as Cluster, node, page) : await deleteInBatches(this.client, page);
      deleted += count;
    });
    return deleted;
  }

  /**
   * Hands each SCAN page to `onPage` before asking for the next, together with the master it came from on Cluster.
   * A cluster that has not loaded its slot map yet knows no masters, so it is first given a command to wait on.
   */
  private async scanPages(pattern: string, count: number, options: ClusterFanoutOptions, onPage: (keys: string[], node?: Redis) => Promise<void>): Promise<void> {
    const scanNode = async (node: Redis | undefined): Promise<void> => {
      let cursor = '0';
      do {
        const [next, keys] = await (node ?? this.client as Redis).scan(cursor, 'MATCH', pattern, 'COUNT', String(count));
        if (keys.length) await onPage(keys, node);
        cursor = next;
      } while (cursor !== '0');
    };
    if (!isCluster(this.client)) { await scanNode(undefined); return; }
    if (this.client.nodes('master').length === 0) await this.client.ping();
    await boundedMap(this.client.nodes('master'), options.concurrency ?? 2, scanNode);
  }
}

/** Deletes keys from one server in DELs of at most {@link DELETE_BATCH} keys. */
async function deleteInBatches(server: RedisConnection, keys: string[]): Promise<number> {
  let deleted = 0;
  for (const batch of chunk(keys, DELETE_BATCH)) deleted += await server.del(...batch);
  return deleted;
}

/**
 * Deletes one master's SCAN page in one round trip: a pipeline of single-slot DELs on that master. A key whose slot
 * has moved since the scan is refused by the master, and is deleted again through the cluster, which follows the redirect.
 */
async function deleteOnNode(cluster: Cluster, node: Redis, keys: string[]): Promise<number> {
  const batches = [...groupBySlot(keys).values()].flatMap(group => chunk(group, DELETE_BATCH));
  const pipeline = node.pipeline();
  for (const batch of batches) pipeline.del(...batch);
  const results = (await pipeline.exec()) ?? [];
  let deleted = 0;
  for (const [index, batch] of batches.entries()) {
    const [error, count] = results[index] ?? [new Error('No reply')];
    deleted += error ? await cluster.del(...batch) : Number(count);
  }
  return deleted;
}

/** Groups keys by their Redis Cluster hash slot. */
function groupBySlot(keys: string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const key of keys) {
    const slot = redisHashSlot(key);
    const group = groups.get(slot);
    if (group) group.push(key); else groups.set(slot, [key]);
  }
  return groups;
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
