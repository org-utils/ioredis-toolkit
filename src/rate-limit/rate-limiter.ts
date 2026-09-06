import type { RedisClientWrapper } from '../redis/wrapper.js';
import type { RateLimitConfig, RateLimitResult } from './types.js';

const SCRIPT = `local c=redis.call('INCRBY',KEYS[1],ARGV[2]); if c==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('TTL',KEYS[1]); return {c,ttl}`;

/** Fixed-window Redis rate limiter with atomic increment-and-expire behavior. */
export class RedisRateLimiter {
  /** Creates a rate limiter bound to the shared Redis client. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: RateLimitConfig) {}

  /** Builds the physical key for a subject and current time window. */
  key(subject: string, nowSeconds = Math.floor(Date.now() / 1000)): string { return `${this.config.namespace}:${subject}:${Math.floor(nowSeconds / this.config.windowSeconds)}`; }

  /** Consumes one request from the configured fixed window. */
  async consume(subject: string, cost = 1, nowSeconds = Math.floor(Date.now() / 1000)): Promise<RateLimitResult> {
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new RangeError('nowSeconds must be a non-negative safe integer');
    if (!Number.isInteger(cost) || cost <= 0) throw new RangeError('Rate-limit cost must be a positive integer');
    const key = this.key(subject, nowSeconds);
    const raw = await this.redis.eval(SCRIPT, 1, key, String(this.config.windowSeconds), String(cost));
    const [countRaw, ttlRaw] = raw as [number | string, number | string];
    const count = Number(countRaw); const ttl = Math.max(0, Number(ttlRaw));
    const resetAt = nowSeconds + ttl;
    return { allowed: count <= this.config.maxRequests, limit: this.config.maxRequests, remaining: Math.max(0, this.config.maxRequests - count), resetAt, retryAfterSeconds: count > this.config.maxRequests ? ttl : 0, count };
  }

  /** Checks the current window without consuming a request. */
  async check(subject: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<RateLimitResult> {
    const key = this.key(subject, nowSeconds); const count = Number((await this.redis.get(key)) ?? 0); const ttl = Math.max(0, await this.redis.ttl(key));
    return { allowed: count < this.config.maxRequests, limit: this.config.maxRequests, remaining: Math.max(0, this.config.maxRequests - count), resetAt: nowSeconds + ttl, retryAfterSeconds: count >= this.config.maxRequests ? ttl : 0, count };
  }

  /** Resets the current fixed-window counter for a subject. */
  async reset(subject: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> { return (await this.redis.del(this.key(subject, nowSeconds))) > 0; }
}
