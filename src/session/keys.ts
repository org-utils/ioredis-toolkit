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
  /** Builds the key of the user's session set. */
  sessionSet(userId: string): string { return this.sessionSetByTag(this.userTag(userId)); }
  /** Builds the same session set key when the precomputed user tag is already available. */
  sessionSetByTag(userTag: string): string { return this.keys.key('user-sessions', this.keys.hashTag(userTag)); }
  /** Builds the per-user security-version key. */
  securityVersion(userId: string): string { return this.securityVersionByTag(this.userTag(userId)); }
  /** Builds the same security-version key when the precomputed user tag is already available. */
  securityVersionByTag(userTag: string): string { return this.keys.key('security-version', this.keys.hashTag(userTag)); }
  /** Builds the key of a credential's token locator. */
  tokenLocator(tokenHash: string): string { return this.keys.key('token-index', tokenHash); }
  /** Builds the revocation record key for a JTI. */
  revoked(jti: string): string { return this.keys.key('revoked', jti); }
}
