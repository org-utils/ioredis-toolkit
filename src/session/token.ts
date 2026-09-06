import { createHash, randomBytes } from 'node:crypto';
import { SessionInputError } from './errors.js';

/** Generates, hashes, and validates opaque session credentials. */
export class SessionTokenManager {
  /** Creates a token manager; `bytes` controls random secret entropy and must be at least 32. */
  constructor(private readonly bytes = 32) {
    if (!Number.isInteger(bytes) || bytes < 32) throw new SessionInputError('Token entropy must be at least 256 bits');
  }
  /** Generates an opaque token containing a random JTI and random secret. */
  generate(): { token: string; jti: string } {
    const jti = randomBytes(16).toString('base64url');
    const secret = randomBytes(this.bytes).toString('base64url');
    return { token: `${jti}.${secret}`, jti };
  }
  /** Returns the SHA-256 digest used as the Redis lookup identifier. */
  hash(token: string): string {
    if (!this.validateFormat(token)) throw new SessionInputError('Invalid session token format');
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }
  /** Checks the token's non-secret syntactic structure without contacting Redis. */
  validateFormat(token: string): boolean {
    if (typeof token !== 'string' || token.length < 45 || token.length > 512) return false;
    const dot = token.indexOf('.');
    return dot > 0 && dot === token.lastIndexOf('.') && dot < token.length - 1 && /^[A-Za-z0-9_-]+$/.test(token.slice(0, dot)) && /^[A-Za-z0-9_-]+$/.test(token.slice(dot + 1));
  }
}
