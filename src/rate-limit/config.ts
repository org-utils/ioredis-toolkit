import { z } from 'zod';
import { moduleConfigSchema, parseConfig } from '../redis/config-base.js';
import { RateLimitError, type RateLimitConfig } from './types.js';
/** Runtime schema for rate-limiter configuration. */
export const RateLimitConfigSchema = moduleConfigSchema('rate-limit').extend({ windowSeconds: z.number().int().positive().max(86400).default(60), maxRequests: z.number().int().positive().max(10_000_000).default(100) });
/** Validates and normalizes rate-limiter configuration. */
export function parseRateLimitConfig(input: unknown): RateLimitConfig { return parseConfig(RateLimitConfigSchema, input, message => new RateLimitError('RATE_LIMIT_CONFIGURATION', message)) as RateLimitConfig; }
