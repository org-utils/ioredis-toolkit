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

// Internal under ADR-0003, and still exported until the public surface narrows. The kernel's entry point
// serves the package, so it carries the kernel's internals. An entry point behind a subpath carries none,
// so the root barrel reaches past those for the names below and for nothing else.
export { RedisClientWrapper, redisHashSlot, safeUserTag, assertSameSlot, RedisConnectionConfigSchema } from './redis/index.js';
/* eslint-disable boundaries/entry-point */
export { SessionService } from './session/service.js';
export { SessionRepository } from './session/repository.js';
export { SessionTokenManager } from './session/token.js';
export { SessionSerializer } from './session/serializer.js';
export { SessionKeyStrategy } from './session/keys.js';
export { SessionScriptRegistry } from './session/scripts.js';
export { RedisRevocationStore } from './session/revocation.js';
export { SessionHealthProvider } from './session/health.js';
export { NoopMetrics } from './session/metrics.js';
export { SessionConfigSchema } from './session/config.js';
export type { SessionHealth } from './session/types.js';
export { CacheConfigSchema } from './cache/config.js';
export { LockConfigSchema } from './lock/config.js';
export { RateLimitConfigSchema } from './rate-limit/config.js';
export { PubSubConfigSchema } from './pubsub/config.js';
export { StreamsConfigSchema } from './streams/config.js';
