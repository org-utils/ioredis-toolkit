/** Normalized configuration for {@link RedisLock}. */
export interface LockConfig {
  /** Whether the application has enabled the module. The class remains directly constructible when false; {@link RedisClient}'s `lock` getter throws when disabled. */
  enabled: boolean;
  /** Prefix used for physical lock keys. */
  namespace: string;
  /** Default lease duration in seconds. */
  defaultTtl: number;
  /** Maximum permitted lease duration in seconds. */
  maxTtl: number;
}

/** Result of a distributed-lock acquisition attempt. */
export interface LockAcquireResult {
  /** True when this caller acquired ownership. */
  acquired: boolean;
  /** Random ownership secret. Never log or expose it to untrusted callers. */
  token: string;
}
