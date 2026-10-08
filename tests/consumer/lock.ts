import { LockError, parseLockConfig } from 'ioredis-toolkit/lock';
import type { LockAcquireResult, LockConfig, LockErrorCode, RedisLock } from 'ioredis-toolkit/lock';

export const configured: LockConfig = parseLockConfig({ enabled: true, namespace: 'app:lock' });
export const section: Partial<LockConfig> = { enabled: true, defaultTtl: 15, maxTtl: 60 };

export async function runOnce(lock: RedisLock, job: string, work: () => Promise<void>): Promise<boolean> {
  const lease: LockAcquireResult = await lock.acquire(job);
  if (!lease.acquired) return false;
  try { await work(); }
  finally { await lock.release(job, lease.token); }
  return true;
}

export function failureKind(error: unknown): LockErrorCode | undefined {
  return error instanceof LockError ? error.code : undefined;
}
