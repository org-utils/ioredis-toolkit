import { z } from 'zod';
import type { CacheConfig } from './types.js';

/** Runtime schema for cache configuration. */
export const CacheConfigSchema = z.object({
  enabled: z.boolean().default(false),
  namespace: z.string().min(1).max(128).default('cache'),
  defaultTtl: z.number().int().positive().default(300),
  maxValueBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024),
});
/** Validates and normalizes cache configuration. */
export function parseCacheConfig(input: unknown): CacheConfig {
  return CacheConfigSchema.parse(input ?? {}) as CacheConfig;
}
