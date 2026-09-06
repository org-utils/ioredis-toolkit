import { randomBytes } from 'node:crypto';
import type { RedisClientWrapper } from '../redis/wrapper.js';
import type { LockAcquireResult, LockConfig } from './types.js';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

/** Redis distributed lock using an ownership token and compare-and-delete semantics. */
export class RedisLock {
  /** Creates a lock bound to the shared Redis client. The client must be shared with the other modules. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: LockConfig) {}

  /** Builds the physical key for a logical lock name. */
  key(name: string): string { return `${this.config.namespace}:${name}`; }

  /** Attempts to acquire a lock and returns a cryptographically random ownership token. */
  async acquire(name: string, ttl = this.config.defaultTtl): Promise<LockAcquireResult> {
    if (ttl <= 0 || ttl > this.config.maxTtl) throw new RangeError('Lock TTL is outside the configured bounds');
    const token = randomBytes(32).toString('base64url');
    const result = await this.redis.set(this.key(name), token, 'PX', String(ttl * 1000), 'NX');
    return { acquired: result === 'OK', token };
  }

  /** Releases a lock only when the supplied ownership token still owns it. */
  async release(name: string, token: string): Promise<boolean> { return Number(await this.redis.eval(RELEASE, 1, this.key(name), token)) === 1; }

  /** Extends a lock only when the supplied ownership token still owns it. */
  async extend(name: string, token: string, ttl = this.config.defaultTtl): Promise<boolean> {
    if (ttl <= 0 || ttl > this.config.maxTtl) throw new RangeError('Lock TTL is outside the configured bounds');
    return Number(await this.redis.eval(EXTEND, 1, this.key(name), token, String(ttl * 1000))) === 1;
  }

  /** Executes a function while holding a lock, releasing it in a finally block. */
  async using<T>(name: string, fn: (token: string) => Promise<T>, ttl = this.config.defaultTtl): Promise<T> {
    const acquired = await this.acquire(name, ttl);
    if (!acquired.acquired) throw new Error(`Lock is already held: ${name}`);
    try { return await fn(acquired.token); } finally { await this.release(name, acquired.token); }
  }
}
