// Core exports
export { RedisClientWrapper as RedisClient, createRedisClient } from './client.js';
export type { RedisClientForMode, ClusterCapabilities } from './client.js';
export { Cache } from './cache.js';
export { PubSub } from './pubsub.js';
export { DistributedLock } from './lock.js';
export { HealthChecker } from './health.js';
export { RateLimiter } from './ratelimiter.js';
export type { RateLimitAlgorithm, RateLimitOptions, RateLimitResult } from './ratelimiter.js';

// Session subsystem (new API; the legacy stores remain exported via ./session)
export { createSessionManager } from './session/session-manager.js';
export { SessionManager } from './session/session-manager.js';
export type { SessionManagerOptions } from './session/session-manager.js';
export { SessionService } from './session/session-service.js';
export type { SessionServiceDeps } from './session/session-service.js';
export { SessionRepository } from './session/session-repository.js';
export { SessionKeyStrategy, encodeUserId } from './session/session-keys.js';
export { SessionTokenManager } from './session/session-token.js';
export { SessionMetrics } from './session/session-metrics.js';
export type { SessionMetricsAdapter } from './session/session-metrics.js';
export { SessionCircuitBreaker } from './session/session-circuit-breaker.js';
export type { CircuitBreakerState } from './session/session-circuit-breaker.js';
export { SessionHealthChecker } from './session/session-health.js';
export type { SessionHealthStatus } from './session/session-health.js';
export {
  SessionCookieManager,
  type SerializeCookieOptions,
  type SerializedCookie,
  type SerializedCookieAttributes,
} from './session/session-cookie.js';
export {
  parseSessionConfig,
  redactSessionConfig,
  TTL,
  IDLE_TIMEOUT,
  TOUCH_INTERVAL,
} from './session/session-config.js';
export type {
  SessionConfig,
  SessionConfigInput,
  PartialSessionConfig,
} from './session/session-config.js';
export {
  SessionError,
  SessionNotFoundError,
  SessionExpiredError,
  SessionRevokedError,
  SessionInvalidError,
  SessionRotationError,
  SessionReplayError,
  SessionStorageError,
  SessionSerializationError,
  SessionConfigurationError,
  SessionConcurrencyError,
  RevocationError,
  RevocationBatchError,
  CircuitBreakerOpenError,
  redactIdentifier,
} from './session/session-errors.js';
export {
  serializeSession,
  serializeEncryptedSession,
  deserializeSession,
  validateSessionRecord,
  envelopeKind,
  encryptedHeaderOf,
  assertHeaderMatches,
} from './session/session-serializer.js';
export {
  StaticSessionKeyProvider,
  createRandomSessionKeyProvider,
  toKeyBuffer,
} from './session/session-encryption.js';
export type { SessionKeyProvider } from './session/session-encryption.js';
export type {
  SessionRecord,
  SessionCreateInput,
  SessionUpdatePatch,
  CreatedSession,
  RotatedSession,
  SessionValidationResult,
  SessionInvalidReason,
  TouchOutcome,
  SessionEnvelope,
  EncryptedSessionEnvelope,
  PlainSessionEnvelope,
  ListOptions,
  RotateOptions,
  TouchOptions,
  UpdateOptions,
  ValidateOptions,
  BindingMismatch,
} from './session/session-types.js';

// Re-export logger types for convenience


// Error exports
export { RedisError } from './errors.js';

// Types
export type {
  RedisConfig,
  RedisConfigInput,
  RedisCommonConfigInput,
  RedisMode,
  RedisNode,
  StandaloneRedisConfig,
  SentinelRedisConfig,
  ClusterRedisConfig,
  RedisConfigForMode,
  CacheOptions,
  LockInfo,
  DistributedLockOptions,
  HealthStatus,
  PubSubStats,
  PubSubMessage,
  ClusterInfo,
  ClusterSlotRange,
  ConnectionStatus,
  Redis
} from './types.js';

// Zod schema
export { RedisConfigSchema } from './types.js';
export { calculateRedisClusterSlot, hashTag } from './cluster-slot.js';

// Re-export for convenience
export type { RedisConfig as RedisConfiguration } from './types.js';

// Default export
import { RedisClientWrapper as RedisClient, createRedisClient } from './client.js';
import { Cache } from './cache.js';
import { PubSub } from './pubsub.js';
import { DistributedLock } from './lock.js';
import { HealthChecker } from './health.js';
import { RateLimiter } from './ratelimiter.js';

export default {
  RedisClient,
  createRedisClient,
  Cache,
  PubSub,
  DistributedLock,
  HealthChecker,
  RateLimiter,
};
