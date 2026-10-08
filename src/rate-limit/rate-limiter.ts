import { RedisClock } from '../redis/clock.js';
import { KeyStrategy } from '../redis/keys.js';
import { ScriptRegistry } from '../redis/scripts.js';
import type { RedisClientWrapper } from '../redis/wrapper.js';
import { RateLimitError, type RateLimitConfig, type RateLimitResult } from './types.js';

const SCRIPT_SOURCES = {
  consume: `local c=redis.call('INCRBY',KEYS[1],ARGV[2]); if c==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('TTL',KEYS[1]); return {c,ttl}`,
} as const;

/** Fixed-window Redis rate limiter with atomic increment-and-expire behavior. */
export class RedisRateLimiter {
  private readonly clock: RedisClock;
  private readonly keys: KeyStrategy;
  private readonly scripts: ScriptRegistry<keyof typeof SCRIPT_SOURCES>;
  /** Creates a rate limiter bound to the shared Redis client. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: RateLimitConfig) { this.clock = new RedisClock(redis); this.keys = new KeyStrategy(config.namespace); this.scripts = new ScriptRegistry(redis, SCRIPT_SOURCES); }

  /** Builds the physical key for a subject and the fixed window containing `serverSeconds`, which must be Redis server time to name the window the limiter uses. */
  key(subject: string, serverSeconds: number): string { return this.keys.key(subject, String(Math.floor(serverSeconds / this.config.windowSeconds))); }

  /** Consumes one request from the configured fixed window. */
  async consume(subject: string, cost = 1): Promise<RateLimitResult> {
    if (!Number.isInteger(cost) || cost <= 0) throw new RateLimitError('RATE_LIMIT_INPUT', 'Rate-limit cost must be a positive integer');
    const serverSeconds = await this.clock.serverSeconds();
    const key = this.key(subject, serverSeconds);
    const raw = await this.scripts.eval('consume', [key], [String(this.config.windowSeconds), String(cost)]);
    const [countRaw, ttlRaw] = raw as [number | string, number | string];
    const count = Number(countRaw); const ttl = Math.max(0, Number(ttlRaw));
    const resetAt = serverSeconds + ttl;
    return { allowed: count <= this.config.maxRequests, limit: this.config.maxRequests, remaining: Math.max(0, this.config.maxRequests - count), resetAt, retryAfterSeconds: count > this.config.maxRequests ? ttl : 0, count };
  }

  /** Checks the current window without consuming a request. */
  async check(subject: string): Promise<RateLimitResult> {
    const serverSeconds = await this.clock.serverSeconds();
    const key = this.key(subject, serverSeconds); const count = Number((await this.redis.get(key)) ?? 0); const ttl = Math.max(0, await this.redis.ttl(key));
    return { allowed: count < this.config.maxRequests, limit: this.config.maxRequests, remaining: Math.max(0, this.config.maxRequests - count), resetAt: serverSeconds + ttl, retryAfterSeconds: count >= this.config.maxRequests ? ttl : 0, count };
  }

  /** Resets the current fixed-window counter for a subject. */
  async reset(subject: string): Promise<boolean> { return (await this.redis.del(this.key(subject, await this.clock.serverSeconds()))) > 0; }
}
