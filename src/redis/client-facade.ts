import type { RedisConfig } from './types.js';
import { createRedisConnection } from './client.js';
import { RedisClientWrapper } from './wrapper.js';
import { RedisConfigurationError } from './errors.js';
import { parseCacheConfig } from '../cache/config.js';
import { RedisCache } from '../cache/cache.js';
import type { CacheConfig } from '../cache/types.js';
import { parseLockConfig } from '../lock/config.js';
import { RedisLock } from '../lock/lock.js';
import type { LockConfig } from '../lock/types.js';
import { parseRateLimitConfig } from '../rate-limit/config.js';
import { RedisRateLimiter } from '../rate-limit/rate-limiter.js';
import type { RateLimitConfig } from '../rate-limit/types.js';
import { parsePubSubConfig } from '../pubsub/config.js';
import { RedisPubSub } from '../pubsub/pubsub.js';
import type { PubSubConfig } from '../pubsub/types.js';
import { parseStreamsConfig } from '../streams/config.js';
import { RedisStreams } from '../streams/streams.js';
import type { StreamsConfig } from '../streams/types.js';
import { parseSessionConfig, type SessionConfig } from '../session/config.js';
import { createSessionManager, type CreateSessionManagerOptions } from '../session/factory.js';
import type { KeyManager, SessionMetrics } from '../session/types.js';
import type { SessionManager } from '../session/manager.js';
import type { ModuleConfigMode } from '../modules-config.js';

/** Complete package configuration. Module sections are optional and disabled by default. */
export type RedisClientConfig = RedisConfig & {
  cache?: Partial<CacheConfig>;
  lock?: Partial<LockConfig>;
  rateLimit?: Partial<RateLimitConfig>;
  pubsub?: Partial<PubSubConfig>;
  streams?: Partial<StreamsConfig>;
  sessions?: Partial<SessionConfig>;
};

/** Optional dependencies for the session module: a key manager when encryption is enabled, and/or a metrics sink. */
export interface RedisClientDependencies { encryptionKeyManager?: KeyManager; metrics?: SessionMetrics; }

/** Shared Redis client facade exposing all package modules through one connection/configuration boundary. */
export class RedisClient extends RedisClientWrapper {
  private cacheModule?: RedisCache;
  private lockModule?: RedisLock;
  private rateLimitModule?: RedisRateLimiter;
  private pubsubModule: RedisPubSub | undefined;
  private streamsModule?: RedisStreams;
  private sessionModule: SessionManager | undefined;
  private readonly moduleConfig: { cache: CacheConfig; lock: LockConfig; rateLimit: RateLimitConfig; pubsub: PubSubConfig; streams: StreamsConfig; sessions: SessionConfig };
  private readonly dependencies: RedisClientDependencies;

  /** Creates the shared Redis facade and normalizes every module's global configuration. */
  constructor(connection: ReturnType<typeof createRedisConnection>, config: RedisClientConfig, dependencies: RedisClientDependencies = {}) {
    super(connection);
    this.dependencies = dependencies;
    this.moduleConfig = {
      cache: parseCacheConfig(config.cache), lock: parseLockConfig(config.lock), rateLimit: parseRateLimitConfig(config.rateLimit), pubsub: parsePubSubConfig(config.pubsub), streams: parseStreamsConfig(config.streams), sessions: parseSessionConfig(config.sessions),
    };
  }

  /** Returns the configured cache module, creating it lazily. Throws if the module is disabled. */
  get cache(): RedisCache {
    if (!this.moduleConfig.cache.enabled) throw new RedisConfigurationError('Cache module is disabled');
    return this.cacheModule ??= new RedisCache(this, this.moduleConfig.cache);
  }
  /** Returns the configured distributed-lock module, creating it lazily. Throws if the module is disabled. */
  get lock(): RedisLock {
    if (!this.moduleConfig.lock.enabled) throw new RedisConfigurationError('Lock module is disabled');
    return this.lockModule ??= new RedisLock(this, this.moduleConfig.lock);
  }
  /** Returns the configured rate-limiter module, creating it lazily. Throws if the module is disabled. */
  get rateLimiter(): RedisRateLimiter {
    if (!this.moduleConfig.rateLimit.enabled) throw new RedisConfigurationError('Rate-limit module is disabled');
    return this.rateLimitModule ??= new RedisRateLimiter(this, this.moduleConfig.rateLimit);
  }
  /** Returns the configured Pub/Sub module, creating it lazily. Throws if the module is disabled. */
  get pubsub(): RedisPubSub {
    if (!this.moduleConfig.pubsub.enabled) throw new RedisConfigurationError('Pub/Sub module is disabled');
    return this.pubsubModule ??= new RedisPubSub(this, this.moduleConfig.pubsub);
  }
  /** Returns the configured Streams module, creating it lazily. Throws if the module is disabled. */
  get streams(): RedisStreams {
    if (!this.moduleConfig.streams.enabled) throw new RedisConfigurationError('Streams module is disabled');
    return this.streamsModule ??= new RedisStreams(this, this.moduleConfig.streams);
  }
  /** Returns the configured session manager, creating it lazily. */
  get sessions(): SessionManager {
    if (!this.sessionModule) {
      const options: CreateSessionManagerOptions = { redis: this, config: this.moduleConfig.sessions, ...(this.dependencies.encryptionKeyManager ? { encryptionKeyManager: this.dependencies.encryptionKeyManager } : {}), ...(this.dependencies.metrics ? { metrics: this.dependencies.metrics } : {}) };
      this.sessionModule = createSessionManager(options);
    }
    return this.sessionModule;
  }

  /** Merges or replaces the global cache configuration and returns this client for fluent chaining. */
  withCache(options: Partial<CacheConfig> = {}, mode: ModuleConfigMode = 'merge'): this { this.moduleConfig.cache = parseCacheConfig(mode === 'merge' ? { ...this.moduleConfig.cache, ...options } : options); this.cacheModule = new RedisCache(this, this.moduleConfig.cache); return this; }
  /** Merges or replaces the global lock configuration and returns this client for fluent chaining. */
  withLock(options: Partial<LockConfig> = {}, mode: ModuleConfigMode = 'merge'): this { this.moduleConfig.lock = parseLockConfig(mode === 'merge' ? { ...this.moduleConfig.lock, ...options } : options); this.lockModule = new RedisLock(this, this.moduleConfig.lock); return this; }
  /** Alias for withLock for codebases that prefer lowercase module naming. */
  withlock(options: Partial<LockConfig> = {}, mode: ModuleConfigMode = 'merge'): this { return this.withLock(options, mode); }
  /** Merges or replaces the global rate-limit configuration and returns this client for fluent chaining. */
  withRateLimit(options: Partial<RateLimitConfig> = {}, mode: ModuleConfigMode = 'merge'): this { this.moduleConfig.rateLimit = parseRateLimitConfig(mode === 'merge' ? { ...this.moduleConfig.rateLimit, ...options } : options); this.rateLimitModule = new RedisRateLimiter(this, this.moduleConfig.rateLimit); return this; }
  /** Merges or replaces the global Pub/Sub configuration and returns this client for fluent chaining. */
  withPubSub(options: Partial<PubSubConfig> = {}, mode: ModuleConfigMode = 'merge'): this { void this.pubsubModule?.close().catch(() => undefined); this.pubsubModule = undefined; this.moduleConfig.pubsub = parsePubSubConfig(mode === 'merge' ? { ...this.moduleConfig.pubsub, ...options } : options); this.pubsubModule = new RedisPubSub(this, this.moduleConfig.pubsub); return this; }
  /** Merges or replaces the global Streams configuration and returns this client for fluent chaining. */
  withStreams(options: Partial<StreamsConfig> = {}, mode: ModuleConfigMode = 'merge'): this { this.moduleConfig.streams = parseStreamsConfig(mode === 'merge' ? { ...this.moduleConfig.streams, ...options } : options); this.streamsModule = new RedisStreams(this, this.moduleConfig.streams); return this; }
  /** Merges or replaces the global session configuration and returns this client for fluent chaining. */
  withSessions(options: Partial<SessionConfig> = {}, mode: ModuleConfigMode = 'merge'): this { this.moduleConfig.sessions = parseSessionConfig(mode === 'merge' ? { ...this.moduleConfig.sessions, ...options } : options); this.sessionModule = undefined; return this; }
  /** Alias for withSession for singular naming. */
  withSession(options: Partial<SessionConfig> = {}, mode: ModuleConfigMode = 'merge'): this { return this.withSessions(options, mode); }

  /** Returns a snapshot of normalized global module configuration. */
  get config(): Readonly<typeof this.moduleConfig> { return this.moduleConfig; }
}

/** Creates a single shared Redis client with all optional modules configured from one object. */
export function createRedisClient(config: RedisClientConfig, dependencies: RedisClientDependencies = {}): RedisClient {
  const { cache: _cache, lock: _lock, rateLimit: _rateLimit, pubsub: _pubsub, streams: _streams, sessions: _sessions, ...redisConfig } = config;
  void _cache; void _lock; void _rateLimit; void _pubsub; void _streams; void _sessions;
  return new RedisClient(createRedisConnection(redisConfig), config, dependencies);
}
