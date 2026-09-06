import { z } from 'zod';
import type { PubSubConfig } from './types.js';
/** Runtime schema for Pub/Sub configuration. */
export const PubSubConfigSchema = z.object({ enabled: z.boolean().default(false), channelPrefix: z.string().min(1).max(128).default('events'), maxMessageBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024) });
/** Validates and normalizes Pub/Sub configuration. */
export function parsePubSubConfig(input: unknown): PubSubConfig { return PubSubConfigSchema.parse(input ?? {}) as PubSubConfig; }
