import { z } from 'zod';
import type { RateLimitConfig } from './types.js';
/** Runtime schema for rate-limiter configuration. */
export const RateLimitConfigSchema = z.object({ enabled: z.boolean().default(false), namespace: z.string().min(1).max(128).default('rate-limit'), windowSeconds: z.number().int().positive().max(86400).default(60), maxRequests: z.number().int().positive().max(10_000_000).default(100) });
/** Validates and normalizes rate-limiter configuration. */
export function parseRateLimitConfig(input: unknown): RateLimitConfig { return RateLimitConfigSchema.parse(input ?? {}) as RateLimitConfig; }
