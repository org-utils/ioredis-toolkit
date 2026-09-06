import { createHash } from 'node:crypto';
import { safeUserTag } from '../redis/cluster.js';

/** Centralizes session Redis key construction and user hash-tagging. */
export class SessionKeyStrategy {
  /** Creates a key strategy for a single logical session namespace. */
  constructor(private readonly namespace: string) {}
  /** Returns the configured logical namespace. */
  getNamespace(): string { return this.namespace; }
  /** Returns a deterministic SHA-256 tag suitable for Redis Cluster hash-tagging. */
  userTag(userId: string): string { return safeUserTag(userId); }
  /** Builds an authoritative session key for a user and token hash. */
  session(userId: string, tokenHash: string): string { return `${this.namespace}:session:{${this.userTag(userId)}}:${tokenHash}`; }
  /** Builds the same session key when the precomputed user tag is already available. */
  sessionByTag(userTag: string, tokenHash: string): string { return `${this.namespace}:session:{${userTag}}:${tokenHash}`; }
  /** Builds the per-user sorted-set index key. */
  userIndex(userId: string): string { return `${this.namespace}:user-sessions:{${this.userTag(userId)}}`; }
  /** Builds the per-user security-version key. */
  securityVersion(userId: string): string { return `${this.namespace}:security-version:{${this.userTag(userId)}}`; }
  /** Builds the secondary token-hash locator key. */
  tokenIndex(tokenHash: string): string { return `${this.namespace}:token-index:${tokenHash}`; }
  /** Builds a user-scoped SHA-256 idempotency key without storing the raw idempotency value. */
  idempotency(userId: string, key: string): string { const h = createHash('sha256').update(key).digest('hex'); return `${this.namespace}:idem:{${this.userTag(userId)}}:${h}`; }
}
