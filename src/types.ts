import type { Redis as RedisType } from "ioredis";
import { z } from "zod";
import type { SessionManagerOptions } from "./session/session-manager.js";


// ============================================================================
// Lock Types
// ============================================================================

/**
 * Information about a distributed lock.
 */
export type LockInfo = {
  /** Whether the lock is currently held. */
  locked: boolean;
  /** Remaining TTL in seconds (when held and TTL set). */
  ttl?: number;
  /** Unique owner id of the lock. */
  lockId?: string;
}

/**
 * Options for the distributed lock.
 */
export type DistributedLockOptions = {
  /** Lock TTL in milliseconds. Default: `30000`. */
  ttl?: number;
  /** Number of acquisition attempts. Default: `3`. */
  retryCount?: number;
  /** Base delay between retries in ms (grows exponentially). Default: `200`. */
  retryDelay?: number;
}

export const DistributedLockOptionsSchema = z.object({
  ttl: z.coerce.number().int().positive().default(30000),
  retryCount: z.coerce.number().int().positive().default(3),
  retryDelay: z.coerce.number().int().positive().default(200)
});
export type DistributedLockInputOptions = z.input<typeof DistributedLockOptionsSchema>;



// ============================================================================
// Cache Types
// ============================================================================

export type CacheOptions = {
  /**
   * TTL in seconds.
   *
   * Falls back to the cache's `defaultTTL`.
   */
  ttl?: number;

  /**
   * Enable/disable compression.
   *
   * Default: true.
   */
  compress?: boolean;

  /**
   * Namespace prefix.
   */
  namespace?: string;
};
export const CacheOptionsSchema = z.object({
  defaultTTL: z.number().int().min(0).default(3_600),

  compressionThreshold: z.number().int().min(1).default(1_024),
});
export type CacheInputConfig = z.input<typeof CacheOptionsSchema>
export type CacheStats = {
  namespace: string;
  connectionStatus: ConnectionStatus;
};

// ============================================================================
// Rate Limiting
// ============================================================================

export const RateLimitAlgorithmSchema = z.enum(["fixed", "sliding"]);

export const RateLimitOptionsSchema = z.object({
  limit: z.number().int().positive().default(100),
  duration: z.number().int().positive().default(60),
  algorithm: RateLimitAlgorithmSchema.default("sliding"),
  namespace: z.string().min(1).default("ratelimit"),
});

/**
 * User-supplied rate-limit configuration.
 *
 * Defaults have not necessarily been materialized yet.
 */
export type RateLimitOptionsInput = z.input<typeof RateLimitOptionsSchema>;

/**
 * Fully normalized rate-limit configuration.
 *
 * All properties are guaranteed to exist after parsing.
 */
export type RateLimitOptions = z.output<typeof RateLimitOptionsSchema>;

// ============================================================================
// Redis Topology
// ============================================================================

export const RedisModeSchema = z.enum(["standalone", "sentinel", "cluster"]);

export type RedisMode = z.infer<typeof RedisModeSchema>;

export const RedisNodeSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

export type RedisNode = z.output<typeof RedisNodeSchema>;

// ============================================================================
// TLS
// ============================================================================

export const RedisTlsOptionsSchema = z
  .object({
    ca: z.string().optional(),
    cert: z.string().optional(),
    key: z.string().optional(),
    rejectUnauthorized: z.boolean().default(true),
  })
  .strict();

export type RedisTlsOptionsInput = z.input<typeof RedisTlsOptionsSchema>;

export type RedisTlsOptions = z.output<typeof RedisTlsOptionsSchema>;

// ============================================================================
// Session
// ============================================================================

export const SessionOptionsSchema = z.custom<Partial<SessionManagerOptions>>();

export type SessionOptionsInput = z.input<typeof SessionOptionsSchema>;

export type SessionOptions = z.output<typeof SessionOptionsSchema>;

// ============================================================================
// Common Redis Configuration
// ============================================================================

/**
 * Configuration shared by all Redis topologies.
 *
 * IMPORTANT:
 * - This schema describes the user-facing input.
 * - `.default()` makes the property optional on input while guaranteeing
 *   the value exists on output.
 */
export const BaseRedisConfigSchema = z
  .object({
    password: z.string().optional(),

    username: z.string().optional(),

    database: z.number().int().min(0).max(15).default(0),

    tls: z.boolean().default(false),

    tlsOptions: RedisTlsOptionsSchema.optional(),

    maxRetries: z.number().int().min(0).max(10).default(3),

    retryDelay: z.number().int().min(50).max(5_000).default(250),

    connectionTimeout: z.number().int().min(100).default(5_000),

    maxFanOutConcurrency: z.number().int().min(1).max(128).default(8),

    maxBatchSize: z.number().int().min(1).max(10_000).default(500),

    lockOptions: DistributedLockOptionsSchema.optional(),

    // defaultTTL: z.number().int().min(0).default(3_600),

    // compressionThreshold: z.number().int().min(1).default(1_024),
    cacheOptions: CacheOptionsSchema.optional(),
    slowCommandThreshold: z.number().int().min(0).default(1_000),

    rateLimit: RateLimitOptionsSchema.optional(),
    // rateLimit: RateLimitOptionsSchema.default({
    //   algorithm: "sliding",
    //   duration: 60,
    //   limit: 100,
    //   namespace: "ratelimit",
    // }),

    sessionOptions: z.custom<Partial<SessionManagerOptions>>().optional(),
  })
  .strict();

export type RedisCommonConfigInput = z.input<typeof BaseRedisConfigSchema>;

export type RedisCommonConfig = z.output<typeof BaseRedisConfigSchema>;

// ============================================================================
// Standalone Configuration
// ============================================================================

/**
 * Standalone Redis configuration.
 *
 * `mode` is optional on input because standalone is the default topology.
 */
export const StandaloneRedisConfigSchema = BaseRedisConfigSchema.extend({
  mode: z.literal("standalone").optional(),

  host: z.string().min(1).default("localhost"),

  port: z.number().int().min(1).max(65_535).default(6379),

  url: z.url().optional(),
}).strict();

export type StandaloneRedisConfigInput = z.input<
  typeof StandaloneRedisConfigSchema
>;

// This is the normalized standalone configuration.
export type StandaloneRedisConfig = Omit<
  z.output<typeof StandaloneRedisConfigSchema>,
  "mode"
> & {
  mode: "standalone";
};

// ============================================================================
// Sentinel Configuration
// ============================================================================

export const SentinelRedisConfigSchema = BaseRedisConfigSchema.extend({
  mode: z.literal("sentinel"),

  sentinelNodes: z.array(RedisNodeSchema).min(1),

  sentinelMasterName: z.string().min(1),
}).strict();

export type SentinelRedisConfigInput = z.input<
  typeof SentinelRedisConfigSchema
>;

export type SentinelRedisConfig = z.output<typeof SentinelRedisConfigSchema>;

// ============================================================================
// Cluster Configuration
// ============================================================================

/**
 * Redis Cluster only supports database 0.
 */
export const ClusterRedisConfigSchema = BaseRedisConfigSchema.extend({
  mode: z.literal("cluster"),

  clusterNodes: z.array(RedisNodeSchema).min(1),

  database: z.literal(0).default(0),
}).strict();

export type ClusterRedisConfigInput = z.input<typeof ClusterRedisConfigSchema>;

export type ClusterRedisConfig = z.output<typeof ClusterRedisConfigSchema>;

// ============================================================================
// Public Redis Configuration
// ============================================================================

/**
 * Raw configuration union.
 *
 * This is intentionally a normal union rather than a discriminated union
 * because standalone allows `mode` to be omitted.
 */
export const RedisConfigInputSchema = z.union([
  StandaloneRedisConfigSchema,
  SentinelRedisConfigSchema,
  ClusterRedisConfigSchema,
]);

/**
 * User-facing configuration.
 *
 * This represents what callers are allowed to provide.
 */
export type RedisConfigInput = z.input<typeof RedisConfigInputSchema>;

/**
 * Normalized configuration.
 *
 * After parsing:
 *
 * - standalone.mode === "standalone"
 * - sentinel.mode === "sentinel"
 * - cluster.mode === "cluster"
 * - defaults have been materialized
 */
export const RedisConfigSchema = RedisConfigInputSchema.transform((config) => {
  if (config.mode === "sentinel") {
    return config;
  }

  if (config.mode === "cluster") {
    return config;
  }

  return {
    ...config,
    mode: "standalone" as const,
  };
});

export type RedisConfig = z.output<typeof RedisConfigSchema>;

// ============================================================================
// Mode-Specific Configuration
// ============================================================================

export type RedisConfigForMode<M extends RedisMode> = M extends "cluster"
  ? ClusterRedisConfig
  : M extends "sentinel"
  ? SentinelRedisConfig
  : StandaloneRedisConfig;



// ============================================================================
// Health Types
// ============================================================================

export type HealthStatus = {
  healthy: boolean;

  status: "healthy" | "degraded" | "unhealthy";

  latency: number;

  timestamp: Date;

  details: {
    ping: boolean;
    connections?: number;
    memory?: string;
  };
};

// ============================================================================
// Pub/Sub Types
// ============================================================================

export type PubSubMessage<T = unknown> = {
  channel: string;
  message: T;
};

export type PubSubStats = {
  subscriptions: number;
  patternSubscriptions: number;
  connected: boolean;
};

export type PubSubEventMap = {
  message: {
    channel: string;
    message: string;
  };

  pmessage: {
    pattern: string;
    channel: string;
    message: string;
  };

  subscribe: {
    channel: string;
    count: number;
  };

  unsubscribe: {
    channel: string;
    count: number;
  };

  psubscribe: {
    pattern: string;
    count: number;
  };

  punsubscribe: {
    pattern: string;
    count: number;
  };

  error: Error;
};

// ============================================================================
// Cluster Types
// ============================================================================

export type ClusterSlotNode = {
  host: string;
  port: number;
  nodeId?: string;
};

export type ClusterSlotRange = {
  start: number;
  end: number;
  master: ClusterSlotNode;
  replicas: ClusterSlotNode[];
};

export type ClusterInfo = {
  mode: RedisMode;

  status: "ready" | "connecting" | "error";

  nodeCount?: number;

  slotCount?: number;

  nodes?: Array<{
    host: string;
    port: number;
    role?: string;
  }>;

  host?: string;

  port?: number;

  error?: string;
};

// ============================================================================
// Connection Types
// ============================================================================

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "closed";

export type ConnectionStatus = {
  state: ConnectionState;

  connected: boolean;

  ready: boolean;

  lastError?: Error;

  reconnectAttempts: number;

  uptime: number;
};

// ============================================================================
// Redis Events
// ============================================================================

export type RedisEventMap = {
  connect: void;

  ready: void;

  close: void;

  reconnecting: {
    attempt: number;
    delay: number;
  };

  error: Error;

  end: void;

  status: ConnectionStatus;

  nodeAdded: {
    node: RedisType;
  };

  nodeRemoved: {
    node: RedisType;
  };

  nodeError: {
    node: RedisType;
    error: Error;
  };

  moved: {
    key: string;
    target: string;
  };

  ask: {
    key: string;
    target: string;
  };
};

// ============================================================================
// Raw Redis Client
// ============================================================================

export type Redis = RedisType;
