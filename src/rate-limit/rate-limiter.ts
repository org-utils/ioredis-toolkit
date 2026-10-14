import { RedisClock, KeyStrategy, ScriptRegistry, type RedisClientWrapper } from '../redis/index.js';
import { RateLimitError, type RateLimitConfig, type RateLimitResult } from './types.js';

/**
 * Both scripts read authoritative time themselves, so a call is one round trip. KEYS[1] is the subject's key; each window's
 * counter is that key followed by the window number, and shares its hash slot through the subject's hash tag. Each returns
 * the window's count, the window's end and the server time, in whole seconds.
 */
const WINDOW = `local now=tonumber(redis.call('TIME')[1]); local w=tonumber(ARGV[1]); local bucket=math.floor(now/w); local key=KEYS[1]..':'..bucket; local windowEnd=(bucket+1)*w;`;
const SCRIPT_SOURCES = {
  consume: `${WINDOW} local c=redis.call('INCRBY',key,ARGV[2]); if redis.call('TTL',key)==-1 then redis.call('EXPIREAT',key,windowEnd) end; return {c,windowEnd,now}`,
  check: `${WINDOW} return {tonumber(redis.call('GET',key) or '0'),windowEnd,now}`,
} as const;

/** Fixed-window Redis rate limiter with atomic increment-and-expire behavior. */
export class RedisRateLimiter {
  private readonly clock: RedisClock;
  private readonly keys: KeyStrategy;
  private readonly scripts: ScriptRegistry<keyof typeof SCRIPT_SOURCES>;
  /** Creates a rate limiter bound to the shared Redis client. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: RateLimitConfig) { this.clock = new RedisClock(redis); this.keys = new KeyStrategy(config.namespace); this.scripts = new ScriptRegistry(redis, SCRIPT_SOURCES); }

  /** Builds the physical key for a subject and the fixed window containing `serverSeconds`, which must be Redis server time to name the window the limiter uses. */
  key(subject: string, serverSeconds: number): string { return `${this.subjectKey(subject)}:${Math.floor(serverSeconds / this.config.windowSeconds)}`; }

  /** Consumes `cost` units from the subject's current fixed window. Denied requests still count against the window. */
  async consume(subject: string, cost = 1): Promise<RateLimitResult> {
    if (!Number.isInteger(cost) || cost <= 0) throw new RateLimitError('RATE_LIMIT_INPUT', 'Rate-limit cost must be a positive integer');
    const [count, windowEnd, now] = await this.run('consume', subject, [String(this.config.windowSeconds), String(cost)]);
    const allowed = count <= this.config.maxRequests;
    return { allowed, limit: this.config.maxRequests, remaining: Math.max(0, this.config.maxRequests - count), resetAt: windowEnd, retryAfterSeconds: allowed ? 0 : windowEnd - now, count };
  }

  /** Checks the current window without consuming a request. */
  async check(subject: string): Promise<RateLimitResult> {
    const [count, windowEnd, now] = await this.run('check', subject, [String(this.config.windowSeconds)]);
    const allowed = count < this.config.maxRequests;
    return { allowed, limit: this.config.maxRequests, remaining: Math.max(0, this.config.maxRequests - count), resetAt: windowEnd, retryAfterSeconds: allowed ? 0 : windowEnd - now, count };
  }

  /** Resets the current fixed-window counter for a subject. */
  async reset(subject: string): Promise<boolean> { return (await this.redis.del(this.key(subject, await this.clock.serverSeconds()))) > 0; }

  /**
   * The key every window of a subject extends, with the subject as its hash tag. A subject that is empty or starts with `}`
   * would make the tag empty, and Redis Cluster would then place each window apart from the key the script is routed by.
   */
  private subjectKey(subject: string): string {
    if (subject === '' || subject.startsWith('}')) throw new RateLimitError('RATE_LIMIT_INPUT', 'Rate-limit subject must not be empty or start with "}"');
    return this.keys.key(this.keys.hashTag(subject));
  }

  private async run(script: keyof typeof SCRIPT_SOURCES, subject: string, args: string[]): Promise<[count: number, windowEnd: number, now: number]> {
    const reply = await this.scripts.eval(script, [this.subjectKey(subject)], args) as [number, number, number];
    return [Number(reply[0]), Number(reply[1]), Number(reply[2])];
  }
}
