import { RedisToolkitError, type ModuleConfigBase } from '../redis/index.js';

/** Stable machine-readable error codes emitted by the distributed lock. */
export type LockErrorCode = 'LOCK_CONFIGURATION' | 'LOCK_INPUT' | 'LOCK_LIMIT' | 'LOCK_HELD';

/** Thrown when lock configuration is invalid, a lock TTL is malformed or over the configured maximum, or `using()` finds the lock already held. */
export class LockError extends RedisToolkitError {
  declare readonly code: LockErrorCode;
  constructor(code: LockErrorCode, message: string, options?: ErrorOptions) { super(code, message, options); this.name = 'LockError'; }
}

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
