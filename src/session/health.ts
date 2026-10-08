import type { RedisClientWrapper } from '../redis/index.js';
import type { SessionHealth } from './types.js';
/** Performs a lightweight Redis health check for session infrastructure. */
export class SessionHealthProvider {
  /** Creates a health provider. `degradedMs` is the latency threshold for degraded status. */
  constructor(private readonly redis: RedisClientWrapper, private readonly degradedMs = 100) {}
  /** Performs one cheap Redis PING and classifies latency or availability. */
  async check(): Promise<SessionHealth> {
    // Local high-resolution timing is correct here: latency is a duration inside this process, not
    // shared state, so ADR-0002's rule that shared state reads the kernel clock does not apply.
    const started = performance.now();
    try {
      const response = await this.redis.ping();
      const latencyMs = performance.now() - started;
      return { status: latencyMs > this.degradedMs ? 'degraded' : 'healthy', latencyMs, errorRate: 0, redisStatus: response };
    } catch {
      return { status: 'unhealthy', latencyMs: performance.now() - started, errorRate: 1, redisStatus: 'unavailable' };
    }
  }
}
