import { randomBytes } from 'node:crypto';
import { KeyStrategy, ScriptRegistry, type RedisClientWrapper } from '../redis/index.js';
import { LockError, type LockAcquireResult, type LockConfig } from './types.js';

const SCRIPT_SOURCES = {
  release: `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
  extend: `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`,
} as const;

/** Redis distributed lock using an ownership token and compare-and-delete semantics. */
export class RedisLock {
  private readonly keys: KeyStrategy;
  private readonly scripts: ScriptRegistry<keyof typeof SCRIPT_SOURCES>;
  /** Creates a lock bound to the shared Redis client. The client must be shared with the other modules. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: LockConfig) { this.keys = new KeyStrategy(config.namespace); this.scripts = new ScriptRegistry(redis, SCRIPT_SOURCES); }

  /** Builds the physical key for a logical lock name. */
  key(name: string): string { return this.keys.key(name); }

  /** Attempts to acquire a lock and returns a cryptographically random ownership token. */
  async acquire(name: string, ttl = this.config.defaultTtl): Promise<LockAcquireResult> {
    this.assertTtl(ttl);
    const token = randomBytes(32).toString('base64url');
    const result = await this.redis.set(this.key(name), token, 'PX', String(ttl * 1000), 'NX');
    return { acquired: result === 'OK', token };
  }

  /** Releases a lock only when the supplied ownership token still owns it. */
  async release(name: string, token: string): Promise<boolean> { return Number(await this.scripts.eval('release', [this.key(name)], [token])) === 1; }

  /** Extends a lock only when the supplied ownership token still owns it. */
  async extend(name: string, token: string, ttl = this.config.defaultTtl): Promise<boolean> {
    this.assertTtl(ttl);
    return Number(await this.scripts.eval('extend', [this.key(name)], [token, String(ttl * 1000)])) === 1;
  }

  /** Executes a function while holding a lock, releasing it in a finally block. */
  async using<T>(name: string, fn: (token: string) => Promise<T>, ttl = this.config.defaultTtl): Promise<T> {
    const acquired = await this.acquire(name, ttl);
    if (!acquired.acquired) throw new LockError('LOCK_HELD', `Lock is already held: ${name}`);
    try { return await fn(acquired.token); } finally { await this.release(name, acquired.token); }
  }

  /** Rejects a lease that is not positive or is longer than the configured maximum. */
  private assertTtl(ttl: number): void {
    if (ttl <= 0) throw new LockError('LOCK_INPUT', 'Lock TTL must be positive');
    if (ttl > this.config.maxTtl) throw new LockError('LOCK_LIMIT', `Lock TTL must not exceed maxTtl (${this.config.maxTtl})`);
  }
}
