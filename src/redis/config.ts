import { z } from 'zod';
import { parseConfig } from './config-base.js';
import { RedisConfigurationError } from './errors.js';
import type { RedisConfig } from './types.js';

const port = z.number().int().min(1).max(65535);

const endpoint = z.object({
  host: z.string().min(1),
  port,
});

/** A Cluster startup node in any form ioredis takes: `host:port` or a URL, a bare port, or an address whose host or port may be left to the default. */
const clusterNode = z.union([z.string().min(1), port, z.object({ host: z.string().min(1).optional(), port: port.optional() }).passthrough()]);

/** Runtime schema for the standalone Redis connection subset accepted by this package. */
export const RedisConnectionConfigSchema = z.preprocess(
  (input) => {
    if (input && typeof input === 'object' && !('mode' in (input as Record<string, unknown>))) {
      return { ...(input as Record<string, unknown>), mode: 'standalone' };
    }
    return input;
  },
  z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('standalone'),
      host: z.string().default('127.0.0.1'),
      port: port.default(6379),
      password: z.string().optional(),
      username: z.string().optional(),
      db: z.number().int().nonnegative().default(0),
      tls: z.unknown().optional(),
    }).passthrough(),
    z.object({
      mode: z.literal('sentinel'),
      sentinels: z.array(endpoint).min(1),
      name: z.string().min(1),
      username: z.string().optional(),
      password: z.string().optional(),
      db: z.number().int().nonnegative().default(0),
      tls: z.unknown().optional(),
    }).passthrough(),
    z.object({
      mode: z.literal('cluster'),
      nodes: z.array(clusterNode).min(1),
      redisOptions: z.record(z.string(), z.unknown()).optional(),
    }).passthrough(),
  ])
);

/**
 * Validates the public Redis connection configuration and returns it in the
 * package's topology-independent shape. Unsupported extra ioredis options are
 * preserved so advanced users can still configure retries, TLS, timeouts, and
 * other supported client features. `mode` may be omitted for standalone Redis,
 * matching {@link StandaloneRedisConfig}'s optional `mode` field.
 */
export function parseRedisConnectionConfig(input: unknown): RedisConfig {
  return parseConfig(RedisConnectionConfigSchema, input, message => new RedisConfigurationError(message)) as RedisConfig;
}
