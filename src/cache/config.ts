import { z } from 'zod';
import { byteCap, moduleConfigSchema } from '../redis/config-base.js';
import type { CacheConfig } from './types.js';

/** Runtime schema for cache configuration. */
export const CacheConfigSchema = moduleConfigSchema('cache').extend({
  defaultTtl: z.number().int().positive().default(300),
  maxValueBytes: byteCap(),
});
/** Validates and normalizes cache configuration. */
export function parseCacheConfig(input: unknown): CacheConfig {
  return CacheConfigSchema.parse(input ?? {}) as CacheConfig;
}
