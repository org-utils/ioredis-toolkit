/** Stable machine-readable error codes emitted by the session subsystem. */
export type SessionErrorCode =
  | 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'SESSION_REVOKED' | 'SESSION_INVALID'
  | 'SESSION_REPLAY' | 'SESSION_ROTATION' | 'SESSION_CONFLICT' | 'SESSION_STORAGE'
  | 'SESSION_SERIALIZATION' | 'SESSION_CONFIGURATION' | 'SESSION_INPUT' | 'SESSION_LIMIT';

/** Base typed error for session validation, lifecycle, storage, and configuration failures. */
export class SessionError extends Error {
  constructor(public readonly code: SessionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'SessionError';
  }
}
/** Thrown when an authoritative session record cannot be found. */
export class SessionNotFoundError extends SessionError { constructor() { super('SESSION_NOT_FOUND', 'Session not found'); } }
/** Thrown when a session is outside its configured lifetime. */
export class SessionExpiredError extends SessionError { constructor() { super('SESSION_EXPIRED', 'Session expired'); } }
/** Thrown when a session has been explicitly revoked. */
export class SessionRevokedError extends SessionError { constructor() { super('SESSION_REVOKED', 'Session revoked'); } }
/** Thrown when session input or state fails validation. */
export class SessionInvalidError extends SessionError { constructor() { super('SESSION_INVALID', 'Session invalid'); } }
/** Thrown when a consumed session credential is replayed. */
export class SessionReplayError extends SessionError { constructor() { super('SESSION_REPLAY', 'Session replay detected'); } }
/** Thrown when rotation cannot complete safely. */
export class SessionRotationError extends SessionError { constructor(message = 'Session rotation failed', cause?: unknown) { super('SESSION_ROTATION', message, { cause }); } }
/** Thrown when optimistic session concurrency detects a conflict. */
export class SessionConflictError extends SessionError { constructor() { super('SESSION_CONFLICT', 'Session version conflict'); } }
/** Thrown when Redis-backed session persistence cannot be completed or read. */
export class SessionStorageError extends SessionError { constructor(message: string, cause?: unknown) { super('SESSION_STORAGE', message, { cause }); } }
/** Thrown when a session envelope cannot be serialized or validated. */
export class SessionSerializationError extends SessionError { constructor(message = 'Session serialization failed', cause?: unknown) { super('SESSION_SERIALIZATION', message, { cause }); } }
/** Thrown when session configuration is invalid or incomplete. */
export class SessionConfigurationError extends SessionError { constructor(message: string) { super('SESSION_CONFIGURATION', message); } }
/** Thrown when token or other session input is malformed. */
export class SessionInputError extends SessionError { constructor(message: string) { super('SESSION_INPUT', message); } }
/** Thrown when a configured session limit prevents an operation. */
export class SessionLimitError extends SessionError { constructor(message: string) { super('SESSION_LIMIT', message); } }
