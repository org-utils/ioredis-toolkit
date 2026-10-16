import { randomBytes } from 'node:crypto';
import { KeyStrategy, ScriptRegistry, containedReporter, type ErrorReporter, type RedisClientWrapper } from '../redis/index.js';
import { LockError, type LockAcquireResult, type LockConfig } from './types.js';

const SCRIPT_SOURCES = {
  // A key that already holds the caller's token was set by this same acquisition, run again after a lost reply.
  acquire: `if redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') or redis.call('get', KEYS[1]) == ARGV[1] then return 1 else return 0 end`,
  release: `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
  extend: `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`,
} as const;

/** Redis distributed lock using an ownership token and compare-and-delete semantics. */
export class RedisLock {
  private readonly keys: KeyStrategy;
  private readonly scripts: ScriptRegistry<keyof typeof SCRIPT_SOURCES>;
  /**
   * Creates a lock bound to the shared Redis client. The client must be shared with the other modules. A release that
   * fails inside {@link using} goes to `report`, since the callback's outcome is what `using()` returns.
   */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: LockConfig, private readonly report: ErrorReporter<'lock-release'> = containedReporter()) {
    this.keys = new KeyStrategy(config.namespace);
    this.scripts = new ScriptRegistry(redis, SCRIPT_SOURCES);
  }

  /** Builds the physical key for a logical lock name. */
  key(name: string): string { return this.keys.key(name); }

  /**
   * Attempts to acquire a lock and returns a cryptographically random ownership token. Safe to run twice: when ioredis sends
   * the acquisition again after its reply was lost, a key already holding this token counts as acquired, with the lease
   * dating from the first run.
   */
  async acquire(name: string, ttl = this.config.defaultTtl): Promise<LockAcquireResult> {
    const milliseconds = this.leaseMilliseconds(ttl);
    const token = randomBytes(32).toString('base64url');
    const acquired = Number(await this.scripts.eval('acquire', [this.key(name)], [token, String(milliseconds)])) === 1;
    return { acquired, token };
  }

  /** Releases a lock only when the supplied ownership token still owns it. */
  async release(name: string, token: string): Promise<boolean> { return Number(await this.scripts.eval('release', [this.key(name)], [token])) === 1; }

  /** Extends a lock only when the supplied ownership token still owns it. */
  async extend(name: string, token: string, ttl = this.config.defaultTtl): Promise<boolean> {
    const milliseconds = this.leaseMilliseconds(ttl);
    return Number(await this.scripts.eval('extend', [this.key(name)], [token, String(milliseconds)])) === 1;
  }

  /**
   * Executes a function while holding a lock, and releases it afterwards. Resolves with the callback's result, or rejects
   * with its error, whatever the release does: a release that fails is reported to the error hook with source
   * `lock-release` instead, and the lock then lapses at the end of its TTL.
   */
  async using<T>(name: string, fn: (token: string) => Promise<T>, ttl = this.config.defaultTtl): Promise<T> {
    const acquired = await this.acquire(name, ttl);
    if (!acquired.acquired) throw new LockError('LOCK_HELD', `Lock is already held: ${name}`);
    let result: T;
    try { result = await fn(acquired.token); }
    catch (error) { await this.releaseReporting(name, acquired.token); throw error; }
    await this.releaseReporting(name, acquired.token);
    return result;
  }

  /** Releases a lock, reporting a failure rather than throwing it. */
  private async releaseReporting(name: string, token: string): Promise<void> {
    try { await this.release(name, token); }
    catch (error) { this.report(error, { source: 'lock-release' }); }
  }

  /**
   * The lease in whole milliseconds. Rejects one that is not a finite positive number, is not a whole number of
   * milliseconds, or is longer than the configured maximum, before anything is sent.
   */
  private leaseMilliseconds(ttl: number): number {
    if (!Number.isFinite(ttl) || ttl <= 0) throw new LockError('LOCK_INPUT', 'Lock TTL must be a finite positive number of seconds');
    const exact = ttl * 1000;
    const milliseconds = Math.round(exact);
    // Within float error of a whole millisecond: 1.001 seconds is 1000.9999999999999 milliseconds once multiplied.
    if (milliseconds < 1 || Math.abs(exact - milliseconds) > 1e-6) throw new LockError('LOCK_INPUT', 'Lock TTL must be a whole number of milliseconds');
    if (ttl > this.config.maxTtl) throw new LockError('LOCK_LIMIT', `Lock TTL must not exceed maxTtl (${this.config.maxTtl})`);
    return milliseconds;
  }
}
