import { createHash } from 'node:crypto';
import { safeUserTag, KeyStrategy } from '../redis/index.js';

/** Centralizes session Redis key construction and user hash-tagging. */
export class SessionKeyStrategy {
  private readonly keys: KeyStrategy;
  /** Creates a key strategy for a single logical session namespace. */
  constructor(namespace: string) { this.keys = new KeyStrategy(namespace); }
  /** Returns the configured logical namespace. */
  getNamespace(): string { return this.keys.namespace; }
  /** Returns a deterministic SHA-256 tag suitable for Redis Cluster hash-tagging. */
  userTag(userId: string): string { return safeUserTag(userId); }
  /** Builds an authoritative session key for a user and token hash. */
  session(userId: string, tokenHash: string): string { return this.sessionByTag(this.userTag(userId), tokenHash); }
  /** Builds the same session key when the precomputed user tag is already available. */
  sessionByTag(userTag: string, tokenHash: string): string { return this.keys.key('session', this.keys.hashTag(userTag), tokenHash); }
  /** Builds the per-user sorted-set index key. */
  userIndex(userId: string): string { return this.keys.key('user-sessions', this.keys.hashTag(this.userTag(userId))); }
  /** Builds the per-user security-version key. */
  securityVersion(userId: string): string { return this.keys.key('security-version', this.keys.hashTag(this.userTag(userId))); }
  /** Builds the secondary token-hash locator key. */
  tokenIndex(tokenHash: string): string { return this.keys.key('token-index', tokenHash); }
  /** Builds a user-scoped SHA-256 idempotency key without storing the raw idempotency value. */
  idempotency(userId: string, key: string): string { return this.keys.key('idem', this.keys.hashTag(this.userTag(userId)), createHash('sha256').update(key).digest('hex')); }
  /** Builds the revocation record key for a JTI. */
  revoked(jti: string): string { return this.keys.key('revoked', jti); }
}
