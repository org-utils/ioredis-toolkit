import { CacheError, parseCacheConfig } from 'ioredis-toolkit/cache';
import type { CacheConfig, CacheErrorCode, CacheResult, CacheSetOptions, RedisCache } from 'ioredis-toolkit/cache';

export const configured: CacheConfig = parseCacheConfig({ enabled: true, namespace: 'app:cache' });
export const section: Partial<CacheConfig> = { enabled: true, defaultTtl: 60 };

const conditional: CacheSetOptions = { ttl: 60, nx: true };

export async function readThrough(cache: RedisCache, key: string, load: () => Promise<string>): Promise<string> {
  const cached: CacheResult<string> = await cache.get<string>(key);
  if (cached.hit && cached.value !== null) return cached.value;
  const value = await load();
  await cache.set(key, value, conditional);
  return value;
}

export function failureKind(error: unknown): CacheErrorCode | undefined {
  return error instanceof CacheError ? error.code : undefined;
}
