import { byteCap, moduleConfigSchema, parseConfig } from '../redis/index.js';
import { PubSubError, type PubSubConfig } from './types.js';
/** Runtime schema for Pub/Sub configuration. */
export const PubSubConfigSchema = moduleConfigSchema('events').extend({ maxMessageBytes: byteCap() });
/** Validates and normalizes Pub/Sub configuration. */
export function parsePubSubConfig(input: unknown): PubSubConfig { return parseConfig(PubSubConfigSchema, input, message => new PubSubError('PUBSUB_CONFIGURATION', message)) as PubSubConfig; }
