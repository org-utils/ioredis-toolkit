import { byteCap, moduleConfigSchema } from '../redis/config-base.js';
import type { PubSubConfig } from './types.js';
/** Runtime schema for Pub/Sub configuration. */
export const PubSubConfigSchema = moduleConfigSchema('events').extend({ maxMessageBytes: byteCap() });
/** Validates and normalizes Pub/Sub configuration. */
export function parsePubSubConfig(input: unknown): PubSubConfig { return PubSubConfigSchema.parse(input ?? {}) as PubSubConfig; }
