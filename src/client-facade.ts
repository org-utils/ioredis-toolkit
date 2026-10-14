import { RedisClientWrapper, RedisConfigurationError, containedReporter, createRedisConnection, reportConnectionErrors, type ErrorReporter, type RedisConfig } from './redis/index.js';
import { RedisCache, parseCacheConfig, type CacheConfig } from './cache/index.js';
import { RedisLock, parseLockConfig, type LockConfig } from './lock/index.js';
import { RedisRateLimiter, parseRateLimitConfig, type RateLimitConfig } from './rate-limit/index.js';
import { RedisPubSub, parsePubSubConfig, type PubSubConfig } from './pubsub/index.js';
import { RedisStreams, parseStreamsConfig, type StreamsConfig } from './streams/index.js';
import { createSessionManager, parseSessionConfig, type CreateSessionManagerOptions, type KeyManager, type SessionConfig, type SessionManager, type SessionMetrics } from './session/index.js';
import type { ModuleConfigMode } from './modules-config.js';

/** Complete package configuration. Module sections are optional and disabled by default. */
export type RedisClientConfig = RedisConfig & {
  cache?: Partial<CacheConfig>;
  lock?: Partial<LockConfig>;
  rateLimit?: Partial<RateLimitConfig>;
  pubsub?: Partial<PubSubConfig>;
  streams?: Partial<StreamsConfig>;
  sessions?: Partial<SessionConfig>;
};

/** The connection or component that produced an error passed to {@link RedisClientDependencies.onError}. */
export type RedisErrorSource = 'connection' | 'subscriber' | 'stream-reader' | 'pubsub-handler' | 'lock-release';

/** Where an error passed to {@link RedisClientDependencies.onError} came from. */
export interface RedisErrorContext {
  /** `connection` is the shared connection, `subscriber` the Pub/Sub subscriber connection. */
  source: RedisErrorSource;
  /** The logical channel, without the namespace, where the error concerns one. */
  channel?: string;
}

/** Optional dependencies: a key manager when session encryption is enabled, a session metrics sink, and an error hook. */
export interface RedisClientDependencies {
  encryptionKeyManager?: KeyManager;
  metrics?: SessionMetrics;
  /** Receives errors no caller can be given, such as a connection error. Without a hook they are dropped; a hook that throws or rejects is contained. */
  onError?: (error: unknown, context: RedisErrorContext) => void;
}

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
  private readonly report: ErrorReporter<RedisErrorSource>;
  private retiredPubSub: Promise<void> = Promise.resolve();

  /** Creates the shared Redis facade and normalizes every module's global configuration. */
  constructor(connection: ReturnType<typeof createRedisConnection>, config: RedisClientConfig, dependencies: RedisClientDependencies = {}) {
    super(connection);
    this.dependencies = dependencies;
    this.report = containedReporter(dependencies.onError);
    reportConnectionErrors(connection, this.report, 'connection');
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
    return this.pubsubModule ??= new RedisPubSub(this, this.moduleConfig.pubsub, this.report);
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
  withPubSub(options: Partial<PubSubConfig> = {}, mode: ModuleConfigMode = 'merge'): this { const retiring = this.pubsubModule?.close().catch(() => undefined); this.retiredPubSub = Promise.all([this.retiredPubSub, retiring]).then(() => undefined); this.pubsubModule = undefined; this.moduleConfig.pubsub = parsePubSubConfig(mode === 'merge' ? { ...this.moduleConfig.pubsub, ...options } : options); this.pubsubModule = new RedisPubSub(this, this.moduleConfig.pubsub, this.report); return this; }
  /** Merges or replaces the global Streams configuration and returns this client for fluent chaining. */
  withStreams(options: Partial<StreamsConfig> = {}, mode: ModuleConfigMode = 'merge'): this { this.moduleConfig.streams = parseStreamsConfig(mode === 'merge' ? { ...this.moduleConfig.streams, ...options } : options); this.streamsModule = new RedisStreams(this, this.moduleConfig.streams); return this; }
  /** Merges or replaces the global session configuration and returns this client for fluent chaining. */
  withSessions(options: Partial<SessionConfig> = {}, mode: ModuleConfigMode = 'merge'): this { this.moduleConfig.sessions = parseSessionConfig(mode === 'merge' ? { ...this.moduleConfig.sessions, ...options } : options); this.sessionModule = undefined; return this; }
  /** Alias for withSession for singular naming. */
  withSession(options: Partial<SessionConfig> = {}, mode: ModuleConfigMode = 'merge'): this { return this.withSessions(options, mode); }

  /** Closes the shared connection and every Pub/Sub subscriber connection: quit if up, disconnected otherwise. Idempotent. */
  override async close(): Promise<void> { await Promise.all([this.pubsubModule?.close(), this.retiredPubSub, super.close()]); }

  /** Returns a snapshot of normalized global module configuration. */
  get config(): Readonly<typeof this.moduleConfig> { return this.moduleConfig; }
}

/** Creates a single shared Redis client with all optional modules configured from one object. */
export function createRedisClient(config: RedisClientConfig, dependencies: RedisClientDependencies = {}): RedisClient {
  const { cache: _cache, lock: _lock, rateLimit: _rateLimit, pubsub: _pubsub, streams: _streams, sessions: _sessions, ...redisConfig } = config;
  void _cache; void _lock; void _rateLimit; void _pubsub; void _streams; void _sessions;
  return new RedisClient(createRedisConnection(redisConfig), config, dependencies);
}
