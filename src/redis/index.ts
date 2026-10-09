/**
 * The kernel's entry point: everything the rest of the package builds on, and the only kernel file it imports.
 * The kernel has no subpath of its own; the root barrel chooses which of these names are public surface.
 */
export { createRedisConnection } from './client.js';
export { RedisClientWrapper } from './wrapper.js';
export { RedisClock } from './clock.js';
export { KeyStrategy } from './keys.js';
export { ScriptRegistry } from './scripts.js';
export { safeUserTag } from './cluster.js';
export { parseRedisConnectionConfig } from './config.js';
export { byteCap, moduleConfigSchema, parseConfig } from './config-base.js';
export type { ByteCapOptions, ModuleConfigBase } from './config-base.js';
export { RedisToolkitError, RedisConfigurationError } from './errors.js';
export type {
  RedisConfig, RedisMode, StandaloneRedisConfig, SentinelRedisConfig, ClusterRedisConfig,
  RedisConnection, RedisCommandClient, RedisPipeline, ClusterFanoutOptions,
} from './types.js';
