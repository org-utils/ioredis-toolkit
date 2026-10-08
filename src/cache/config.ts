import { z } from 'zod';
import { byteCap, moduleConfigSchema, parseConfig } from '../redis/index.js';
import { CacheError, type CacheConfig } from './types.js';

/** Runtime schema for cache configuration. */
export const CacheConfigSchema = moduleConfigSchema('cache').extend({
  defaultTtl: z.number().int().positive().default(300),
  maxValueBytes: byteCap(),
});
/** Validates and normalizes cache configuration. */
export function parseCacheConfig(input: unknown): CacheConfig {
  return parseConfig(CacheConfigSchema, input, message => new CacheError('CACHE_CONFIGURATION', message)) as CacheConfig;
}
