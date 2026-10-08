/**
 * The session module's entry point: its class, the factory functions that construct it, and the
 * configuration, input, result and error types a consumer needs beside them.
 */
export { SessionManager } from './manager.js';
export { createSessionManager, createSessionManagerFromRedis } from './factory.js';
export type { CreateSessionManagerOptions } from './factory.js';
export { parseSessionConfig } from './config.js';
export type { SessionConfig } from './config.js';
export { serializeCookie, serializeDeletionCookie } from './cookie.js';
export type { CookieOptions } from './cookie.js';
export type {
  SessionRecord, SessionStatus, CreateSessionInput, CreatedSession, ValidationResult, InvalidReason,
  RotationResult, SessionPatch, SessionMetrics, KeyManager,
} from './types.js';
export {
  SessionError, SessionNotFoundError, SessionExpiredError, SessionRevokedError, SessionInvalidError,
  SessionReplayError, SessionRotationError, SessionConflictError, SessionStorageError,
  SessionSerializationError, SessionConfigurationError, SessionInputError, SessionLimitError,
} from './errors.js';
export type { SessionErrorCode } from './errors.js';
/** The connection configuration {@link createSessionManagerFromRedis} takes, so this entry point constructs what it returns. */
export type { RedisConfig } from '../redis/index.js';
