import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import type { RedisClient, RedisClientConfig, RedisClientDependencies, RedisConfig } from '../../src/index.js';

/** Real-server suites run only when REDIS_URL names a Redis they may write to. */
export const redisUrl = process.env.REDIS_URL;

type ModuleSections = Pick<RedisClientConfig, 'cache' | 'lock' | 'rateLimit' | 'pubsub' | 'streams' | 'sessions'>;

/** REDIS_URL as the connection config the factories take; they do not accept a URL. */
export function connectionConfig(): RedisConfig {
  const url = new URL(redisUrl!);
  return {
    mode: 'standalone',
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.pathname.length > 1 ? { db: Number(url.pathname.slice(1)) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

/**
 * The client facade on REDIS_URL. The public surface has no way to close the
 * connection a factory opens (facade gap, recorded on #20), so these connections
 * are left for the test worker's exit to reap.
 */
export function connectClient(modules: ModuleSections = {}, dependencies: RedisClientDependencies = {}): RedisClient {
  return createRedisClient({ ...connectionConfig(), ...modules }, dependencies);
}

async function keysUnder(observer: Redis, namespace: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await observer.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 500);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys.sort();
}

async function storedUnder(observer: Redis, namespace: string): Promise<string> {
  const stored: string[] = [];
  for (const key of await keysUnder(observer, namespace)) {
    const type = await observer.type(key);
    stored.push(key);
    if (type === 'string') stored.push((await observer.get(key)) ?? '');
    else if (type === 'zset') stored.push(...await observer.zrange(key, 0, -1, 'WITHSCORES'));
    else throw new Error(`storedUnder cannot read the ${type} at ${key}`);
  }
  return stored.join('\n');
}

async function commandsFromClientsOf(observer: Redis, namespace: string, work: () => Promise<unknown>): Promise<string[][]> {
  // Not `observer.monitor()`: that rejects when other clients' traffic arrives together with MONITOR's own reply,
  // which ioredis reports as a queue-state error. Such traffic is from before `work`, so that one error is dropped;
  // any other (a refused MONITOR, a lost connection) fails the caller.
  const monitor = observer.duplicate({ monitor: true });
  const failed = new Promise<never>((_resolve, reject) => {
    monitor.on('error', (error: Error) => { if (!error.message.startsWith('Command queue state error')) reject(error); });
  });
  failed.catch(() => undefined);
  try {
    await Promise.race([new Promise<void>(resolve => { monitor.once('monitoring', () => resolve()); }), failed]);
    const sent: Array<{ source: string; args: string[] }> = [];
    const marker = `end-${randomUUID()}`;
    const ended = new Promise<void>(resolve => {
      monitor.on('monitor', (_time: string, args: string[], source: string) => {
        if (args.includes(marker)) resolve();
        else if (source !== 'lua') sent.push({ source, args });
      });
    });
    await work();
    await observer.echo(marker);
    await Promise.race([ended, failed]);
    const clients = new Set(sent.filter(({ args }) => args.some(arg => arg.startsWith(`${namespace}:`))).map(({ source }) => source));
    return sent.filter(({ source }) => clients.has(source)).map(({ args }) => args);
  } finally {
    monitor.disconnect();
  }
}

/** Retries an assertion until it holds, for state that settles on another connection. */
export async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try { await assertion(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** What a real-server suite uses to look at, or plant, what is in Redis. */
export interface RedisFixture {
  /** A raw connection, separate from any the package opens. */
  readonly observer: Redis;
  /** Mints a namespace no other test or run shares. */
  newNamespace(): string;
  /** Every key under a namespace. */
  keysUnder(namespace: string): Promise<string[]>;
  /** Every key name and value under a namespace as one searchable text. */
  storedUnder(namespace: string): Promise<string>;
  /** Runs `work` and returns, as argument lists in the order the server received them, everything sent meanwhile by each connection that named a key under a namespace. Commands a script runs are not included. */
  commandsFromClientsOf(namespace: string, work: () => Promise<unknown>): Promise<string[][]>;
  /**
   * Empties the script cache of the whole server, as a restart or failover would: the one server-wide effect a suite may have.
   * No stored data is touched, and a client that runs Lua by SHA sends the source again when the server asks for it,
   * so the only trace on a shared server is that one extra EVAL per script per client.
   */
  flushScriptCache(): Promise<void>;
}

/** Sets up a suite's {@link RedisFixture} and deletes the namespaces it minted afterwards. Stored data on a shared server is never flushed. */
export function redisFixture(): RedisFixture {
  let observer: Redis;
  const namespaces: string[] = [];
  beforeAll(() => { observer = new Redis(redisUrl!); });
  afterAll(async () => {
    for (const namespace of namespaces) {
      const keys = await keysUnder(observer, namespace);
      if (keys.length) await observer.del(...keys);
    }
    await observer.quit();
  });
  return {
    get observer() { return observer; },
    newNamespace() { const namespace = `test-${randomUUID()}`; namespaces.push(namespace); return namespace; },
    keysUnder: namespace => keysUnder(observer, namespace),
    storedUnder: namespace => storedUnder(observer, namespace),
    commandsFromClientsOf: (namespace, work) => commandsFromClientsOf(observer, namespace, work),
    flushScriptCache: async () => { await observer.script('FLUSH'); },
  };
}
