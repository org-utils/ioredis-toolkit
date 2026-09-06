export { createRedisConnection } from './redis/client.js';
export { RedisClientWrapper } from './redis/wrapper.js';
export { createRedisClient, RedisClient } from './redis/client-facade.js';
export type { RedisClientConfig, RedisClientDependencies } from './redis/client-facade.js';
export { redisHashSlot, safeUserTag, assertSameSlot } from './redis/cluster.js';
export { parseRedisConnectionConfig, RedisConnectionConfigSchema } from './redis/config.js';
export { RedisConfigurationError } from './redis/errors.js';
export type { RedisConfig, RedisMode, RedisConnection, RedisCommandClient } from './redis/types.js';

export { createSessionManager, createSessionManagerFromRedis } from './session/factory.js';
export type { CreateSessionManagerOptions } from './session/factory.js';
export { SessionManager } from './session/manager.js';
export { SessionService } from './session/service.js';
export { SessionRepository } from './session/repository.js';
export { SessionTokenManager } from './session/token.js';
export { SessionSerializer } from './session/serializer.js';
export { SessionKeyStrategy } from './session/keys.js';
export { SessionScriptRegistry } from './session/scripts.js';
export { RedisRevocationStore } from './session/revocation.js';
export { SessionHealthProvider } from './session/health.js';
export { NoopMetrics } from './session/metrics.js';
export { serializeCookie, serializeDeletionCookie } from './session/cookie.js';
export { parseSessionConfig, SessionConfigSchema } from './session/config.js';
export type { SessionConfig } from './session/config.js';
export type { SessionRecord, SessionStatus, CreateSessionInput, CreatedSession, ValidationResult, RotationResult, SessionPatch, SessionMetrics, SessionHealth, KeyManager } from './session/types.js';
export * from './session/errors.js';

export { RedisCache } from './cache/cache.js';
export { parseCacheConfig, CacheConfigSchema } from './cache/config.js';
export { CacheError } from './cache/types.js';
export type { CacheConfig, CacheSetOptions, CacheResult } from './cache/types.js';

export { RedisLock } from './lock/lock.js';
export { parseLockConfig, LockConfigSchema } from './lock/config.js';
export type { LockConfig, LockAcquireResult } from './lock/types.js';

export { RedisRateLimiter } from './rate-limit/rate-limiter.js';
export { parseRateLimitConfig, RateLimitConfigSchema } from './rate-limit/config.js';
export type { RateLimitConfig, RateLimitResult } from './rate-limit/types.js';

export { RedisPubSub } from './pubsub/pubsub.js';
export { parsePubSubConfig, PubSubConfigSchema } from './pubsub/config.js';
export type { PubSubConfig, PubSubMessage, Subscription } from './pubsub/types.js';

export { RedisStreams } from './streams/streams.js';
export { parseStreamsConfig, StreamsConfigSchema } from './streams/config.js';
export type { StreamsConfig, StreamEntry, StreamReadOptions } from './streams/types.js';

export type { ModuleConfigMode } from './modules-config.js';
