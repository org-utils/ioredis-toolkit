import { z } from 'zod';
import { moduleConfigSchema, parseConfig } from '../redis/index.js';
import { StreamsError, type StreamsConfig } from './types.js';
/** Runtime schema for Redis Streams configuration. */
export const StreamsConfigSchema = moduleConfigSchema('stream').extend({ maxEntries: z.number().int().positive().max(10_000_000).default(100_000), blockMs: z.number().int().nonnegative().max(300_000).default(5000) });
/** Validates and normalizes Streams configuration. */
export function parseStreamsConfig(input: unknown): StreamsConfig { return parseConfig(StreamsConfigSchema, input, message => new StreamsError('STREAMS_CONFIGURATION', message)) as StreamsConfig; }
