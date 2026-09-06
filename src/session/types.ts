/** Lifecycle states that may be persisted for a session. */
export type SessionStatus = 'active' | 'consumed' | 'revoked';

/** Authoritative session state stored by the repository. Raw credentials are deliberately absent. */
export interface SessionRecord {
  /** Stable identifier derived from the token hash. */
  id: string;
  /** Public token identifier used for rotation/revocation bookkeeping; it is not the raw token. */
  jti: string;
  /** Application user identifier that owns the session. */
  userId: string;
  /** Unix timestamp in seconds at which the session was created. */
  createdAt: number;
  /** Unix timestamp in seconds of the last accepted access/touch. */
  lastAccessedAt: number;
  /** Hard storage/authentication expiration timestamp in Unix seconds. */
  expiresAt: number;
  /** Rolling idle expiration boundary, or `null` when idle expiry is disabled. */
  idleExpiresAt: number | null;
  /** Originally configured rolling idle-timeout duration in seconds, absent when idle expiry is disabled. Preserved across touch and rotation so the idle window does not drift from its configured value. */
  idleTimeoutSeconds?: number;
  /** Absolute application expiration boundary, or `null` when disabled. */
  absoluteExpiresAt: number | null;
  /** Current lifecycle state. Only `active` sessions can authenticate. */
  status: SessionStatus;
  /** Monotonically increasing optimistic-concurrency version. */
  version: number;
  /** User security version captured at creation, or `null` when disabled. */
  securityVersion: number | null;
  /** Optional application device identifier. */
  deviceId?: string;
  /** Optional source IP address when configured for storage. */
  ipAddress?: string;
  /** Optional user-agent string when configured for storage. */
  userAgent?: string;
  /** Bounded JSON-compatible application metadata. */
  metadata?: Record<string, string | number | boolean | null>;
  /** JTI of the predecessor session when this record came from rotation. */
  rotatedFrom?: string;
  /** Unix timestamp at which this session was consumed by rotation. */
  consumedAt?: number;
  /** Successor JTI when rotation recorded it. */
  successorJti?: string;
  /** Optional application-level rotation correlation ID. */
  rotationId?: string;
}

/** Input used to create a new authentication session. */
export interface CreateSessionInput {
  /** Owning application user ID. */
  userId: string;
  /** Optional hard TTL override in seconds. */
  ttl?: number;
  /** Optional rolling idle timeout in seconds. */
  idleTimeout?: number;
  /** Optional absolute timeout in seconds. */
  absoluteTimeout?: number;
  /** Optional user security version to capture. */
  securityVersion?: number;
  /** Optional device identifier. */
  deviceId?: string;
  /** Optional source IP address. */
  ipAddress?: string;
  /** Optional user-agent string. */
  userAgent?: string;
  /** Optional bounded metadata. */
  metadata?: Record<string, string | number | boolean | null>;
}

/** Mutable fields accepted by a session update. */
export interface SessionPatch {
  /** Replaces the complete metadata object when supplied. */
  metadata?: Record<string, string | number | boolean | null>;
  /** Replaces or clears the device identifier. */
  deviceId?: string | null;
  /** Replaces or clears the IP address. */
  ipAddress?: string | null;
  /** Replaces or clears the user-agent string. */
  userAgent?: string | null;
}

/** Newly created session plus the raw credential, which is returned only to the caller. */
export interface CreatedSession {
  /** Raw opaque session token. Never persist or log this value. */
  token: string;
  /** Authoritative persisted session representation. */
  session: SessionRecord;
}

/** Reasons returned when a raw session token cannot authenticate. */
export type InvalidReason = 'not_found' | 'expired' | 'idle_timeout' | 'absolute_timeout' | 'revoked' | 'consumed' | 'invalid';

/** Discriminated authentication result that separates invalid credentials from infrastructure failures. */
export type ValidationResult =
  | { valid: true; session: SessionRecord }
  | { valid: false; reason: InvalidReason };

/** Result of a successful session rotation. */
export interface RotationResult {
  /** Raw successor token; replace the predecessor credential with this value. */
  token: string;
  /** Newly created authoritative successor session. */
  session: SessionRecord;
  /** JTI of the consumed predecessor. */
  previousJti: string;
}

/** Lightweight result from the Redis-backed session health probe. */
export interface SessionHealth {
  /** Aggregate health classification. */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Round-trip latency measured by the probe. */
  latencyMs: number;
  /** Error-rate signal supplied by the health implementation. */
  errorRate: number;
  /** Redis client status string. */
  redisStatus: string;
}

/** Minimal metrics sink accepted by the session subsystem. */
export interface SessionMetrics {
  /** Increments a counter metric. */
  increment(name: string, value?: number, labels?: Record<string, string>): void;
  /** Records an observation such as latency. */
  observe(name: string, value: number, labels?: Record<string, string>): void;
  /** Sets a gauge value. */
  gauge(name: string, value: number, labels?: Record<string, string>): void;
}

/** Supplies versioned 32-byte encryption keys to the optional session serializer. */
export interface KeyManager {
  /** Returns the current encryption key and its version identifier. */
  current(): { version: string; key: Buffer };
  /** Returns a historical key by version for decryption, or `undefined` if unavailable. */
  get(version: string): Buffer | undefined;
}
