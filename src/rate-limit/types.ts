/** Normalized configuration for the fixed-window rate limiter. */
export interface RateLimitConfig {
  /** Whether the application has enabled the module. The class remains directly constructible when false; {@link RedisClient}'s `rateLimiter` getter throws when disabled. */
  enabled: boolean;
  /** Prefix used for counter keys. */
  namespace: string;
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
  /** Approximate Unix timestamp at which the current fixed window expires. */
  resetAt: number;
  /** Seconds until the counter resets when the request is denied; otherwise zero. */
  retryAfterSeconds: number;
  /** Current counter value after the operation, or current value for `check()`. */
  count: number;
}
