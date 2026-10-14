import { KeyStrategy, ScriptRegistry, type RedisClientWrapper } from '../redis/index.js';
import { RateLimitError, type RateLimitConfig, type RateLimitResult } from './types.js';

/**
 * Both scripts read authoritative time themselves, so a call is one round trip. KEYS[1] is the subject's key, the only key
 * either touches: a hash holding the number of the window it counts (`window`) and that window's count (`count`). A stored
 * window other than the current one counts as empty. Each returns the window's count, the window's end and the server
 * time, in whole seconds.
 */
const CURRENT_WINDOW = `local serverSeconds=tonumber(redis.call('TIME')[1]); local w=tonumber(ARGV[1]); local bucket=tostring(math.floor(serverSeconds/w)); local windowEnd=(bucket+1)*w; local current=redis.call('HGET',KEYS[1],'window')==bucket;`;
const SCRIPT_SOURCES = {
  consume: `${CURRENT_WINDOW} local c; if current then c=redis.call('HINCRBY',KEYS[1],'count',ARGV[2]) else redis.call('HSET',KEYS[1],'window',bucket,'count',ARGV[2]); c=tonumber(ARGV[2]) end; if not current or redis.call('TTL',KEYS[1])==-1 then redis.call('EXPIREAT',KEYS[1],windowEnd) end; return {c,windowEnd,serverSeconds}`,
  check: `${CURRENT_WINDOW} local c=0; if current then c=tonumber(redis.call('HGET',KEYS[1],'count')) end; return {c,windowEnd,serverSeconds}`,
} as const;

/** Fixed-window Redis rate limiter with atomic increment-and-expire behavior. */
export class RedisRateLimiter {
  private readonly keys: KeyStrategy;
  private readonly scripts: ScriptRegistry<keyof typeof SCRIPT_SOURCES>;
  /** Creates a rate limiter bound to the shared Redis client. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: RateLimitConfig) { this.keys = new KeyStrategy(config.namespace); this.scripts = new ScriptRegistry(redis, SCRIPT_SOURCES); }

  /** Builds the physical key that holds a subject's current fixed window. */
  key(subject: string): string;
  /** @deprecated `serverSeconds` has no effect: every window of a subject is counted under one key. Call `key(subject)`. */
  key(subject: string, serverSeconds: number): string;
  key(subject: string): string { return this.subjectKey(subject); }

  /** Consumes `cost` units from the subject's current fixed window. Denied requests still count against the window. */
  async consume(subject: string, cost = 1): Promise<RateLimitResult> {
    if (!Number.isInteger(cost) || cost <= 0) throw new RateLimitError('RATE_LIMIT_INPUT', 'Rate-limit cost must be a positive integer');
    const [count, windowEnd, serverSeconds] = await this.run('consume', subject, [String(this.config.windowSeconds), String(cost)]);
    const allowed = count <= this.config.maxRequests;
    return { allowed, limit: this.config.maxRequests, remaining: Math.max(0, this.config.maxRequests - count), resetAt: windowEnd, retryAfterSeconds: allowed ? 0 : windowEnd - serverSeconds, count };
  }

  /** Checks the current window without consuming a request. */
  async check(subject: string): Promise<RateLimitResult> {
    const [count, windowEnd, serverSeconds] = await this.run('check', subject, [String(this.config.windowSeconds)]);
    const allowed = count < this.config.maxRequests;
    return { allowed, limit: this.config.maxRequests, remaining: Math.max(0, this.config.maxRequests - count), resetAt: windowEnd, retryAfterSeconds: allowed ? 0 : windowEnd - serverSeconds, count };
  }

  /** Resets the current fixed-window counter for a subject. */
  async reset(subject: string): Promise<boolean> { return (await this.redis.del(this.key(subject))) > 0; }

  /**
   * The subject's key, with the subject as its hash tag as in earlier versions. A subject that is empty or starts with `}`
   * is still rejected, as it was when each window had a key of its own that had to share the subject's hash slot.
   */
  private subjectKey(subject: string): string {
    if (subject === '' || subject.startsWith('}')) throw new RateLimitError('RATE_LIMIT_INPUT', 'Rate-limit subject must not be empty or start with "}"');
    return this.keys.key(this.keys.hashTag(subject));
  }

  private async run(script: keyof typeof SCRIPT_SOURCES, subject: string, args: string[]): Promise<[count: number, windowEnd: number, serverSeconds: number]> {
    const reply = await this.scripts.eval(script, [this.subjectKey(subject)], args) as [number, number, number];
    return [Number(reply[0]), Number(reply[1]), Number(reply[2])];
  }
}
