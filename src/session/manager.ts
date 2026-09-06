import type { SessionService } from './service.js';
import type { CreateSessionInput, CreatedSession, RotationResult, SessionPatch, SessionRecord, ValidationResult } from './types.js';

/** Stable, framework-independent facade for session lifecycle operations. */
export class SessionManager {
  /** Creates a manager backed by the supplied service. */
  constructor(private readonly service: SessionService) {}
  /** Creates a new opaque session and returns its raw token exactly once. */
  create(input: CreateSessionInput): Promise<CreatedSession> { return this.service.create(input); }
  /** Validates a raw session token and returns a discriminated authentication result. */
  validate(token: string): Promise<ValidationResult> { return this.service.validate(token); }
  /** Gets an active authoritative session or throws a typed session error. */
  get(token: string): Promise<SessionRecord> { return this.service.get(token); }
  /** Applies configured rolling idle-expiration behavior to an active session. */
  touch(token: string): Promise<void> { return this.service.touch(token); }
  /** Updates mutable session metadata with optional optimistic concurrency control. */
  update(token: string, patch: SessionPatch, expectedVersion?: number): Promise<SessionRecord> { return this.service.update(token, patch, expectedVersion); }
  /** Atomically consumes a predecessor and creates a successor token. */
  rotate(token: string): Promise<RotationResult> { return this.service.rotate(token); }
  /** Permanently removes the session's stored record and derived indexes. */
  destroy(token: string): Promise<void> { return this.service.destroy(token); }
  /** Marks a session unusable for authentication. */
  revoke(token: string): Promise<void> { return this.service.revoke(token); }
  /** Sets the user's security version used by session validation when enabled. */
  setSecurityVersion(userId: string, version: number): Promise<void> { return this.service.setSecurityVersion(userId, version); }
  /** Revokes a bounded number of sessions for a user and reports remaining indexed sessions. */
  revokeAll(userId: string, limit?: number): Promise<{ affected: number; remaining: number }> { return this.service.revokeAll(userId, limit); }
  /** Lists a bounded page of sessions for a user. */
  list(userId: string, offset?: number, limit?: number): Promise<SessionRecord[]> { return this.service.list(userId, offset, limit); }
}
