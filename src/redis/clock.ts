import type { RedisCommandClient } from './types.js';

/**
 * Authoritative time: Redis server time (ADR-0002). It is the only clock permitted
 * for anything that expires, buckets, or orders state shared across processes,
 * because application servers' local clocks disagree with each other.
 */
export class RedisClock {
  /** Creates a clock reading the server the shared Redis client is connected to. */
  constructor(private readonly redis: Pick<RedisCommandClient, 'time'>) {}

  /** Returns Redis server time in whole Unix seconds. */
  async now(): Promise<number> {
    const [seconds] = await this.redis.time();
    return Number(seconds);
  }
}
