import { z } from 'zod';
import type { StreamsConfig } from './types.js';
/** Runtime schema for Redis Streams configuration. */
export const StreamsConfigSchema = z.object({ enabled: z.boolean().default(false), keyPrefix: z.string().min(1).max(128).default('stream'), maxEntries: z.number().int().positive().max(10_000_000).default(100_000), blockMs: z.number().int().nonnegative().max(300_000).default(5000) });
/** Validates and normalizes Streams configuration. */
export function parseStreamsConfig(input: unknown): StreamsConfig { return StreamsConfigSchema.parse(input ?? {}) as StreamsConfig; }
