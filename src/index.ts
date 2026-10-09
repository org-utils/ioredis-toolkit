/**
 * The root barrel: the client facade, and a curated re-export of each module's entry point.
 * Every name is listed, never a wildcard, so adding one to the public surface is a deliberate act.
 */
export { createRedisClient, RedisClient } from './client-facade.js';
export type { RedisClientConfig, RedisClientDependencies } from './client-facade.js';
export type { ModuleConfigMode } from './modules-config.js';

export { createRedisConnection, parseRedisConnectionConfig, RedisToolkitError, RedisConfigurationError } from './redis/index.js';
export type {
  RedisConfig, RedisMode, StandaloneRedisConfig, SentinelRedisConfig, ClusterRedisConfig,
  RedisConnection, RedisCommandClient, RedisPipeline, ClusterFanoutOptions, ModuleConfigBase,
} from './redis/index.js';

export {
  SessionManager, createSessionManager, createSessionManagerFromRedis, parseSessionConfig, serializeCookie, serializeDeletionCookie,
  SessionError, SessionNotFoundError, SessionExpiredError, SessionRevokedError, SessionInvalidError,
  SessionReplayError, SessionRotationError, SessionConflictError, SessionStorageError,
  SessionSerializationError, SessionConfigurationError, SessionInputError, SessionLimitError,
} from './session/index.js';
export type {
  CreateSessionManagerOptions, SessionConfig, CookieOptions, SessionErrorCode,
  SessionRecord, SessionStatus, CreateSessionInput, CreatedSession, ValidationResult, InvalidReason,
  RotationResult, SessionPatch, SessionMetrics, KeyManager,
} from './session/index.js';

export { RedisCache, parseCacheConfig, CacheError } from './cache/index.js';
export type { CacheConfig, CacheSetOptions, CacheResult, CacheErrorCode } from './cache/index.js';

export { RedisLock, parseLockConfig, LockError } from './lock/index.js';
export type { LockConfig, LockAcquireResult, LockErrorCode } from './lock/index.js';

export { RedisRateLimiter, parseRateLimitConfig, RateLimitError } from './rate-limit/index.js';
export type { RateLimitConfig, RateLimitResult, RateLimitErrorCode } from './rate-limit/index.js';

export { RedisPubSub, parsePubSubConfig, PubSubError } from './pubsub/index.js';
export type { PubSubConfig, PubSubMessage, Subscription, PubSubErrorCode } from './pubsub/index.js';

export { RedisStreams, parseStreamsConfig, StreamsError } from './streams/index.js';
export type { StreamsConfig, StreamEntry, StreamReadOptions, StreamsErrorCode } from './streams/index.js';
