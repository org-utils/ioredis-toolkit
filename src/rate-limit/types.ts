import type { ModuleConfigBase } from '../redis/config-base.js';
import { RedisToolkitError } from '../redis/errors.js';

/** Stable machine-readable error codes emitted by the rate limiter. */
export type RateLimitErrorCode = 'RATE_LIMIT_CONFIGURATION' | 'RATE_LIMIT_INPUT';

/** Thrown when rate-limit configuration is invalid, or a cost is malformed. */
export class RateLimitError extends RedisToolkitError {
  declare readonly code: RateLimitErrorCode;
  constructor(code: RateLimitErrorCode, message: string, options?: ErrorOptions) { super(code, message, options); this.name = 'RateLimitError'; }
}

/** Normalized configuration for the fixed-window rate limiter. */
export interface RateLimitConfig extends ModuleConfigBase {
  /** Length of each fixed window in seconds. */
  windowSeconds: number;
  /** Maximum consumed units permitted during one window. */
  maxRequests: number;
}

/** Result returned by a rate-limit check or consumption operation. */
export interface RateLimitResult {
  /** Whether the attempted cost is within the configured limit. */
  allowed: boolean;
  /** Configured maximum number of units. */
  limit: number;
  /** Remaining units after the operation. */
  remaining: number;
  /** Approximate Unix timestamp, in Redis server time, at which the current fixed window expires. */
  resetAt: number;
  /** Seconds until the counter resets when the request is denied; otherwise zero. */
  retryAfterSeconds: number;
  /** Current counter value after the operation, or current value for `check()`. */
  count: number;
}
