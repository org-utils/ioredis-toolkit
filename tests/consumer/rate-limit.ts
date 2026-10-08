import { RateLimitError, parseRateLimitConfig } from 'ioredis-toolkit/rate-limit';
import type { RateLimitConfig, RateLimitErrorCode, RateLimitResult, RedisRateLimiter } from 'ioredis-toolkit/rate-limit';

export const configured: RateLimitConfig = parseRateLimitConfig({ enabled: true, namespace: 'app:limit' });
export const section: Partial<RateLimitConfig> = { enabled: true, windowSeconds: 60, maxRequests: 100 };

export async function retryAfter(limiter: RedisRateLimiter, subject: string): Promise<number> {
  const decision: RateLimitResult = await limiter.consume(subject);
  return decision.allowed ? 0 : decision.retryAfterSeconds;
}

export function failureKind(error: unknown): RateLimitErrorCode | undefined {
  return error instanceof RateLimitError ? error.code : undefined;
}
