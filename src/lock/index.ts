/** The lock module's entry point: its class, with the configuration, result and error types a consumer needs beside it. */
export { RedisLock } from './lock.js';
export { parseLockConfig } from './config.js';
export { LockError } from './types.js';
export type { LockConfig, LockAcquireResult, LockErrorCode } from './types.js';
