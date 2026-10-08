import { RedisToolkitError, createRedisClient, parseCacheConfig, parseRedisConnectionConfig, parseSessionConfig, serializeCookie } from 'ioredis-toolkit';
import type {
  CacheConfig, ClusterFanoutOptions, ClusterRedisConfig, CookieOptions, InvalidReason, KeyManager, LockConfig, ModuleConfigBase, ModuleConfigMode,
  PubSubConfig, RateLimitConfig, RedisCache, RedisClient, RedisClientConfig, RedisClientDependencies, RedisConfig, RedisLock, RedisPipeline,
  RedisPubSub, RedisRateLimiter, RedisStreams, SentinelRedisConfig, SessionConfig, SessionManager, SessionMetrics, StandaloneRedisConfig, StreamsConfig,
} from 'ioredis-toolkit';

const connection: RedisConfig = parseRedisConnectionConfig({ mode: 'standalone', host: '127.0.0.1', port: 6379 });
const cache: Partial<CacheConfig> = { enabled: true, namespace: 'app:cache' };
const lock: Partial<LockConfig> = { enabled: true };
const rateLimit: Partial<RateLimitConfig> = { enabled: true };
const pubsub: Partial<PubSubConfig> = { enabled: true };
const streams: Partial<StreamsConfig> = { enabled: true };
const sessions: Partial<SessionConfig> = { enabled: true, encryption: { enabled: true } };
const config: RedisClientConfig = { ...connection, cache, lock, rateLimit, pubsub, streams, sessions };

/** Each member of the connection union is nameable, so a topology can be configured in a typed variable of its own. */
export const topologies: [StandaloneRedisConfig, SentinelRedisConfig, ClusterRedisConfig] = [
  { host: '127.0.0.1', port: 6379 },
  { mode: 'sentinel', name: 'primary', sentinels: [{ host: '127.0.0.1', port: 26379 }] },
  { mode: 'cluster', nodes: [{ host: '127.0.0.1', port: 7000 }] },
];

/** What every module's configuration shares is nameable, so one function can take any of them. */
export function keyspace(module: ModuleConfigBase): string | undefined {
  return module.enabled ? `${module.namespace}:*` : undefined;
}

export const keyspaces: Array<string | undefined> = [parseCacheConfig(cache), parseSessionConfig(sessions)].map(keyspace);

/** What the client's own command surface takes and hands back is nameable too. */
export async function countKeys(client: RedisClient, pattern: string): Promise<number> {
  const fanout: ClusterFanoutOptions = { concurrency: 4 };
  const keys = await client.scanCluster(pattern, 500, fanout);
  const batch: RedisPipeline = client.pipeline();
  for (const key of keys) batch.exists(key);
  return (await batch.exec())?.filter(([, exists]) => exists === 1).length ?? 0;
}

export function connect(encryptionKeyManager: KeyManager, metrics: SessionMetrics): RedisClient {
  const dependencies: RedisClientDependencies = { encryptionKeyManager, metrics };
  return createRedisClient(config, dependencies);
}

export function modules(client: RedisClient): [RedisCache, RedisLock, RedisRateLimiter, RedisPubSub, RedisStreams, SessionManager] {
  return [client.cache, client.lock, client.rateLimiter, client.pubsub, client.streams, client.sessions];
}

export function reconfigure(client: RedisClient, mode: ModuleConfigMode): RedisClient {
  return client.withCache({ defaultTtl: 60 }, mode);
}

const cookie: CookieOptions = { name: 'session' };

export async function authenticate(client: RedisClient, token: string): Promise<string | InvalidReason> {
  const result = await client.sessions.validate(token);
  return result.valid ? serializeCookie(token, cookie) : result.reason;
}

export function failureKind(error: unknown): string | undefined {
  return error instanceof RedisToolkitError ? error.code : undefined;
}
