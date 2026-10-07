import { z } from 'zod';
import { moduleConfigSchema } from '../redis/config-base.js';
import type { LockConfig } from './types.js';
/** Runtime schema for distributed-lock configuration. */
export const LockConfigSchema = moduleConfigSchema('lock').extend({ defaultTtl: z.number().int().positive().default(30), maxTtl: z.number().int().positive().default(300) })
  .superRefine((c, ctx) => { if (c.defaultTtl > c.maxTtl) ctx.addIssue({ code: 'custom', path: ['defaultTtl'], message: 'defaultTtl must not exceed maxTtl' }); });
/** Validates and normalizes lock configuration. */
export function parseLockConfig(input: unknown): LockConfig { return LockConfigSchema.parse(input ?? {}) as LockConfig; }
