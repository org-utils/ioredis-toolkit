import type { SessionConfig } from './config.js';
import { SessionConflictError, SessionExpiredError, SessionInvalidError, SessionLimitError, SessionNotFoundError, SessionReplayError, SessionRotationError, SessionStorageError, SessionRevokedError } from './errors.js';
import { NoopMetrics } from './metrics.js';
import type { SessionRepository } from './repository.js';
import type { SessionTokenManager } from './token.js';
import type { CreateSessionInput, CreatedSession, RotationResult, SessionMetrics, SessionPatch, SessionRecord, ValidationResult } from './types.js';
import type { RedisClientWrapper } from '../redis/wrapper.js';

/** Dependencies required by {@link SessionService}. */
export interface SessionServiceOptions { repository: SessionRepository; tokens: SessionTokenManager; redis: RedisClientWrapper; config: SessionConfig; metrics?: SessionMetrics; }

/** Domain service enforcing session lifecycle and authentication invariants. */
export class SessionService {
  private readonly metrics: SessionMetrics;
  /** Creates the domain service from repository, token, Redis-clock, and normalized configuration dependencies. */
  constructor(private readonly o: SessionServiceOptions) { this.metrics = o.metrics ?? new NoopMetrics(); }

  /** Creates a new session and returns its raw credential exactly once. */
  async create(input: CreateSessionInput): Promise<CreatedSession> {
    validateUserId(input.userId);
    validateMetadata(input.metadata, this.o.config.maxMetadataBytes);
    validateOptionalString(input.deviceId, 256);
    validateOptionalString(input.ipAddress, 128);
    validateOptionalString(input.userAgent, 1024);
    if (this.o.config.securityVersionEnabled && input.securityVersion === undefined) throw new SessionInvalidError();
    const now = await this.now();
    const ttl = input.ttl ?? this.o.config.ttl;
    const absoluteDuration = input.absoluteTimeout ?? this.o.config.absoluteTimeout;
    const idleDuration = input.idleTimeout ?? this.o.config.idleTimeout;
    if (ttl <= 0 || (absoluteDuration !== undefined && absoluteDuration <= 0) || (idleDuration !== undefined && idleDuration <= 0)) throw new SessionInvalidError();
    if (absoluteDuration !== undefined && ttl > absoluteDuration) throw new SessionInvalidError();
    const tokenData = this.o.tokens.generate();
    const tokenHash = this.o.tokens.hash(tokenData.token);
    const absoluteExpiresAt = absoluteDuration === undefined ? null : now + absoluteDuration;
    const expiresAt = absoluteExpiresAt === null ? now + ttl : Math.min(now + ttl, absoluteExpiresAt);
    const idleExpiresAt = idleDuration === undefined ? null : Math.min(now + idleDuration, expiresAt);
    const session: SessionRecord = {
      id: tokenHash, jti: tokenData.jti, userId: input.userId, createdAt: now, lastAccessedAt: now,
      expiresAt, idleExpiresAt, absoluteExpiresAt, status: 'active', version: 1,
      securityVersion: input.securityVersion ?? null,
      ...(idleDuration !== undefined ? { idleTimeoutSeconds: idleDuration } : {}),
      ...(this.o.config.storeDeviceId && input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(this.o.config.storeIpAddress && input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(this.o.config.storeUserAgent && input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {})
    };
    await this.o.repository.create(session);
    this.metrics.increment('session.created');
    return { token: tokenData.token, session };
  }

  /** Validates an opaque credential and returns a discriminated authentication result. */
  async validate(token: string): Promise<ValidationResult> {
    const result = await this.validateInternal(token);
    this.metrics.increment('session.validate', 1, result.valid ? { result: 'valid' } : { result: 'invalid', reason: result.reason });
    return result;
  }

  private async validateInternal(token: string): Promise<ValidationResult> {
    if (!this.o.tokens.validateFormat(token)) return { valid: false, reason: 'invalid' };
    const tokenHash = this.o.tokens.hash(token);
    const session = await this.o.repository.resolve(tokenHash);
    if (!session) return { valid: false, reason: 'not_found' };
    const now = await this.now();
    if (session.status === 'revoked') return { valid: false, reason: 'revoked' };
    if (session.status === 'consumed') return { valid: false, reason: 'consumed' };
    if (session.expiresAt <= now) return { valid: false, reason: 'expired' };
    if (session.absoluteExpiresAt !== null && session.absoluteExpiresAt <= now) return { valid: false, reason: 'absolute_timeout' };
    if (session.idleExpiresAt !== null && session.idleExpiresAt <= now) return { valid: false, reason: 'idle_timeout' };
    if (!(await this.o.repository.isIndexed(session))) return { valid: false, reason: 'invalid' };
    if (this.o.config.securityVersionEnabled) {
      const current = await this.o.repository.getSecurityVersion(session.userId);
      if (current === null || session.securityVersion !== Number(current)) return { valid: false, reason: 'invalid' };
    }
    return { valid: true, session };
  }

  /** Validates and returns an active session, throwing a typed error for invalid state. */
  async get(token: string): Promise<SessionRecord> {
    const result = await this.validate(token);
    if (!result.valid) throw errorForReason(result.reason);
    return result.session;
  }

  /** Applies rolling idle-expiration rules with repository-level touch throttling. */
  async touch(token: string): Promise<void> {
    const session = await this.get(token);
    if (!this.o.config.rolling) return;
    const result = await this.o.repository.touch(session, await this.now());
    if (result === 'invalid') throw new SessionExpiredError();
  }

  /** Updates mutable session fields with optional optimistic-concurrency protection. */
  async update(token: string, patch: SessionPatch, expectedVersion?: number): Promise<SessionRecord> {
    const session = await this.get(token);
    validateMetadata(patch.metadata, this.o.config.maxMetadataBytes);
    const replacement: SessionRecord = { ...session, version: session.version + 1 };
    if (patch.metadata !== undefined) replacement.metadata = patch.metadata;
    if (patch.deviceId !== undefined) { if (patch.deviceId === null) delete replacement.deviceId; else replacement.deviceId = patch.deviceId; }
    if (patch.ipAddress !== undefined) { if (patch.ipAddress === null) delete replacement.ipAddress; else replacement.ipAddress = patch.ipAddress; }
    if (patch.userAgent !== undefined) { if (patch.userAgent === null) delete replacement.userAgent; else replacement.userAgent = patch.userAgent; }
    if (expectedVersion !== undefined && expectedVersion !== session.version) throw new SessionConflictError();
    await this.o.repository.update(session, replacement, expectedVersion ?? session.version, await this.now());
    return replacement;
  }

  /** Consumes the predecessor credential and creates a successor credential with explicit partial-failure semantics. */
  async rotate(token: string): Promise<RotationResult> {
    const current = await this.get(token);
    if (current.status !== 'active') throw new SessionReplayError();
    const now = await this.now();
    const remaining = current.expiresAt - now;
    if (remaining <= 0) throw new SessionExpiredError();
    const tokenData = this.o.tokens.generate();
    const successorHash = this.o.tokens.hash(tokenData.token);
    const absoluteExpiresAt = current.absoluteExpiresAt;
    const expiresAt = absoluteExpiresAt === null ? current.expiresAt : Math.min(current.expiresAt, absoluteExpiresAt);
    const idleExpiresAt = current.idleExpiresAt === null ? null : Math.min(expiresAt, now + (current.idleTimeoutSeconds ?? this.o.config.idleTimeout ?? Math.max(1, current.idleExpiresAt - current.lastAccessedAt)));
    const successor: SessionRecord = {
      ...current, id: successorHash, jti: tokenData.jti, createdAt: now, lastAccessedAt: now,
      expiresAt, idleExpiresAt, status: 'active', version: 1, rotatedFrom: current.jti
    };
    // Cross-slot successor creation is deliberately two-phase. Consuming the predecessor
    // is authoritative and atomic; failure afterwards can only deny access, never create two valid successors.
    await this.o.repository.consume(current, now, Math.min(300, Math.max(1, remaining)));
    try { await this.o.repository.create(successor); }
    catch (error) { throw new SessionRotationError('Rotation consumed the predecessor but successor creation failed', error); }
    this.metrics.increment('session.rotated');
    return { token: tokenData.token, session: successor, previousJti: current.jti };
  }

  /** Best-effort idempotently removes a session and its derived indexes. */
  async destroy(token: string): Promise<void> {
    if (!this.o.tokens.validateFormat(token)) return;
    const hash = this.o.tokens.hash(token);
    const session = await this.o.repository.resolve(hash);
    if (!session) return;
    await this.o.repository.destroy(session);
    this.metrics.increment('session.destroyed');
  }

  /** Marks a session revoked and persists a bounded revocation tombstone when applicable. */
  async revoke(token: string): Promise<void> {
    if (!this.o.tokens.validateFormat(token)) return;
    const hash = this.o.tokens.hash(token);
    const session = await this.o.repository.resolve(hash);
    if (!session) return;
    const now = await this.now();
    await this.o.repository.revoke(session, now, Math.min(300, Math.max(1, session.expiresAt - now)));
    this.metrics.increment('session.revoked');
  }

  /** Sets the user's security version used to invalidate older sessions. */
  async setSecurityVersion(userId: string, version: number): Promise<void> {
    validateUserId(userId);
    if (!Number.isSafeInteger(version) || version < 0) throw new SessionInvalidError();
    await this.o.repository.setSecurityVersion(userId, version);
  }

  /** Revokes a bounded batch of the user's indexed sessions without unbounded memory use. */
  async revokeAll(userId: string, limit = this.o.config.maxBatchSize): Promise<{ affected: number; remaining: number }> {
    validateUserId(userId);
    return this.o.repository.revokeAll(userId, limit);
  }

  /** Returns a bounded page of authoritative sessions for a user. */
  async list(userId: string, offset = 0, limit = this.o.config.maxBatchSize): Promise<SessionRecord[]> {
    validateUserId(userId);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw new SessionInvalidError();
    if (limit > this.o.config.maxBatchSize) throw new SessionLimitError(`limit must not exceed maxBatchSize (${this.o.config.maxBatchSize})`);
    return this.o.repository.list(userId, offset, limit);
  }

  private async now(): Promise<number> {
    try { const [seconds] = await this.o.redis.time(); return Number(seconds); }
    catch (error) { throw new SessionStorageError('Redis time unavailable', error); }
  }
}

function validateUserId(value: string): void { if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new SessionInvalidError(); }
function validateOptionalString(value: string | undefined, max: number): void { if (value !== undefined && (typeof value !== 'string' || value.length > max)) throw new SessionInvalidError(); }
function validateMetadata(value: SessionPatch['metadata'], maxBytes: number): void { if (value === undefined) return; try { const encoded = JSON.stringify(value); if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new SessionInvalidError(); } catch (error) { if (error instanceof SessionInvalidError) throw error; throw new SessionInvalidError(); } }
function errorForReason(reason: Exclude<ValidationResult, { valid: true }>['reason']): Error {
  if (reason === 'not_found') return new SessionNotFoundError();
  if (reason === 'expired' || reason === 'idle_timeout' || reason === 'absolute_timeout') return new SessionExpiredError();
  if (reason === 'revoked') return new SessionRevokedError();
  return new SessionInvalidError();
}
