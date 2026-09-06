import { z } from 'zod';
import { RedisConfigurationError } from './errors.js';
import type { RedisConfig } from './types.js';

const endpoint = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
});

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
      port: z.number().int().min(1).max(65535).default(6379),
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
      nodes: z.array(endpoint).min(1),
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
  const result = RedisConnectionConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new RedisConfigurationError(result.error.issues.map((issue: { path: PropertyKey[]; message: string }) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return result.data as RedisConfig;
}
