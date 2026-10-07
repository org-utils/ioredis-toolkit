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

/** Every key under a namespace, as a consumer inspecting Redis would find them. */
export async function keysUnder(observer: Redis, namespace: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await observer.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 500);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys.sort();
}

/** Every key name and value under a namespace as one searchable text. */
export async function storedUnder(observer: Redis, namespace: string): Promise<string> {
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

/** Retries an assertion until it holds, for state that settles on another connection. */
export async function eventually(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await assertion(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Gives a real-server suite an observer — a raw connection for looking at, or
 * planting, what is in Redis — and namespaces no other test or run shares, which
 * it deletes afterwards. Shared servers are never flushed.
 */
export function redisFixture(): { readonly observer: Redis; namespace(): string } {
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
    namespace() { const namespace = `test-${randomUUID()}`; namespaces.push(namespace); return namespace; },
  };
}
