import type { RedisClientWrapper } from '../redis/wrapper.js';
import { SessionStorageError } from './errors.js';
import type { SessionKeyStrategy } from './keys.js';

/**
 * Stores short-lived JTI revocation records.
 *
 * This is a standalone utility for credentials whose authorization model is
 * JTI-based (e.g. externally issued JWTs) — see docs/README-API.md. It is
 * intentionally *not* wired into {@link SessionService}: this package's own
 * opaque sessions treat session state itself as the source of truth, and
 * deliberately avoid an extra revocation-key lookup on every `validate()` call.
 */
export class RedisRevocationStore {
  /** Creates a revocation store using the shared Redis client and session key strategy. */
  constructor(private readonly redis: RedisClientWrapper, private readonly keys: SessionKeyStrategy) {}
  /** Stores a bounded-TTL JTI revocation tombstone. `now` should be sourced from the same clock as the caller's other session operations (e.g. Redis server time) to avoid skew. */
  async revoke(jti: string, now: number, expiresAt: number, reason = 'revoked'): Promise<void> {
    const ttl = Math.ceil(expiresAt - now);
    if (ttl <= 0) return;
    try { await this.redis.set(`${this.keys.getNamespace()}:revoked:${jti}`, reason, 'EX', String(ttl), 'NX'); }
    catch (error) { throw new SessionStorageError('Unable to persist revocation', error); }
  }
  /** Checks whether a JTI currently has a revocation tombstone. */
  async isRevoked(jti: string): Promise<boolean> {
    try { return (await this.redis.exists(`${this.keys.getNamespace()}:revoked:${jti}`)) === 1; }
    catch (error) { throw new SessionStorageError('Unable to read revocation state', error); }
  }
}
