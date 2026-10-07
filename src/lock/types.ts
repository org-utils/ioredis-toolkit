import type { ModuleConfigBase } from '../redis/config-base.js';

/** Normalized configuration for {@link RedisLock}. */
export interface LockConfig extends ModuleConfigBase {
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
