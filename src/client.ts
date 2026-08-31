import Redis, {
  Cluster,
  Redis as RedisClient,
  type RedisOptions,
} from "ioredis";

import { ConfigurationError, RedisError } from "./errors.js";
import {
  type DistributedLockOptions,
  RateLimitOptionsInput,
  RateLimitOptionsSchema,
  RedisConfigSchema,
  type ClusterInfo,
  type ClusterRedisConfig,
  type ClusterSlotRange,
  type ConnectionStatus,
  type RedisConfig,
  type RedisConfigInput,
  type RedisMode,
  type SentinelRedisConfig,
  type StandaloneRedisConfig,
  DistributedLockInputOptions,
  DistributedLockOptionsSchema,
  CacheInputConfig,
  CacheOptionsSchema,
} from "./types.js";
import { defaultLogger, type LoggerLike } from "./logger.js";
import { executeBySlot } from "./cluster.js";
import { calculateRedisClusterSlot } from "./cluster-slot.js";
import { Cache } from "./cache.js";
import { PubSub } from "./pubsub.js";
import { DistributedLock } from "./lock.js";
import { RateLimiter, RateLimitOptions } from "./ratelimiter.js";
import {
  createSessionManager,
  SessionManager,
  WithSessionManagerOptions,
} from "./session/session-manager.js";
import { prettifyError } from "zod";
import { RedisRevocationStore, RedisRevocationStoreOptions, RedisRevocationStoreOptionsInput, RedisRevocationStoreOptionsSchema } from "./session/revocation-store.js";
import { deepMerge } from "./utils/deepmerge.js";

// ============================================================================
// Public Types
// ============================================================================

export interface RedisClientOptions {
  config: RedisConfigInput;
  logger?: LoggerLike;
}

/**
 * Cluster-only administrative/capability surface.
 */
export interface ClusterCapabilities {
  getClusterNodes(): RedisClient[];
  getClusterSlots(): Promise<ClusterSlotRange[]>;
  getClusterInfo(): ClusterInfo;
  calculateSlot(key: string): number;
  getSlotRanges(): Promise<Map<number, string[]>>;
  getNodeForKey(key: string): Promise<RedisClient | null>;
  isKeyServed(key: string): Promise<boolean>;
  executeOnNode<T>(
    key: string,
    command: string,
    ...args: unknown[]
  ): Promise<T>;
  mgetClusterAware(keys: string[]): Promise<(string | null)[]>;
  clearNamespaceClusterAware(
    prefix: string,
    options?: {
      batchSize?: number;
      scanCount?: number;
    },
  ): Promise<number>;
}

type ClusterMethodName = keyof ClusterCapabilities | "isCluster";

/**
 * Public client surface specialized by Redis topology.
 */
export type RedisClientForMode<M extends RedisMode> =
  M extends "cluster"
    ? Omit<
        RedisClientWrapper,
        "select" | ClusterMethodName
      > &
        ClusterCapabilities & {
          isCluster(): true;
        }
    : Omit<
        RedisClientWrapper,
        | "isCluster"
        | "getClusterNodes"
        | "getClusterSlots"
        | "getClusterInfo"
        | "calculateSlot"
        | "getSlotRanges"
        | "getNodeForKey"
        | "isKeyServed"
        | "executeOnNode"
        | "mgetClusterAware"
        | "clearNamespaceClusterAware"
      > & {
        isCluster(): false;
      };

// ============================================================================
// Internal Types
// ============================================================================

type RedisUnderlyingClient = RedisClient | Cluster;

type RedisCommandArgument =
  | string
  | number
  | Buffer;

type ScanOptions = {
  count?: number;
  batchSize?: number;
};

type DeletePatternOptions = {
  batchSize?: number;
  scanCount?: number;
};

type ClusterNodeDescriptor = {
  host: string;
  port: number;
  nodeId?: string;
};

type ClusterSlotsResponse = unknown;

type ClusterSlotEntry = [
  number,
  number,
  unknown,
  ...unknown[],
];

// ============================================================================
// Type Guards
// ============================================================================

export function isClusterConfig(
  config: RedisConfig,
): config is ClusterRedisConfig {
  return config.mode === "cluster";
}

export function isSentinelConfig(
  config: RedisConfig,
): config is SentinelRedisConfig {
  return config.mode === "sentinel";
}

export function isStandaloneConfig(
  config: RedisConfig,
): config is StandaloneRedisConfig {
  return config.mode === "standalone";
}

// ============================================================================
// Redis Client
// ============================================================================

/**
 * Production-grade Redis client wrapper supporting:
 *
 * - standalone Redis
 * - Redis Sentinel
 * - Redis Cluster
 * - connection lifecycle handling
 * - slow-command tracking
 * - cluster-aware multi-key operations
 * - cache
 * - pub/sub
 * - distributed locks
 * - rate limiting
 * - sessions
 */
export class RedisClientWrapper {
  private readonly client: RedisUnderlyingClient;

  private _cache?: Cache | undefined;
  private _pubsub?: PubSub;
  private _lock?: DistributedLock | undefined;
  private _rateLimiter?: RateLimiter | undefined;
  private _session?: SessionManager | undefined;
  private _revocationStore?: RedisRevocationStore;

  private readonly config: RedisConfig;
  private readonly logger: LoggerLike;

  private isReady = false;

  // ========================================================================
  // Constructor
  // ========================================================================

  constructor(
    config: RedisConfigInput,
    logger: LoggerLike = defaultLogger,
  ) {
    const parsed = RedisConfigSchema.safeParse(config);

    if (!parsed.success) {
      throw new ConfigurationError(
        `Invalid Redis config: ${parsed.error.message}`,
        {
          config,
          message: prettifyError(parsed.error),
        },
      );
    }

    /**
     * IMPORTANT:
     *
     * `parsed.data` is already `RedisConfig`.
     *
     * Do NOT cast it back to `RedisConfigInput`.
     * Do NOT normalize it manually.
     *
     * The Zod schema is the normalization boundary.
     */
    this.config = parsed.data;

    this.logger = logger.child({
      component: "RedisClient",
    });

    this.client = this.createClient();

    this.setupEventHandlers();
  }

  /**
   * Creates a new Redis client wrapper supporting standalone, sentinel, and cluster topologies.
   *
   * The client automatically adapts to the configured Redis topology and lazily creates
   * and shares sub-components: `cache`, `pubsub`, `lock`, `rateLimiter`, and `session`.
   *
     * @param config - Redis configuration (validated with Zod `RedisConfigSchema`).
     *   Must include `mode` (standalone/sentinel/cluster), and topology-specific fields.
     * @param logger - Optional pino-compatible logger; defaults to `console`.
     *
     * @example
     * ```ts
     * const client = new RedisClientWrapper({
     *   mode: 'standalone',
     *   host: 'localhost',
     *   port: 6379,
     * });
     * ```
     */

  // ========================================================================
  // Configuration
  // ========================================================================

  /**
   * Returns the Redis topology mode of this client.
   *
   * @returns `'standalone'`, `'sentinel'`, or `'cluster'`
   */
  get mode(): RedisMode {
    return this.config.mode;
  }

  // ========================================================================
  // Cache
  // ========================================================================

  /**
   * Returns the shared Cache instance (lazily created on first access).
   *
   * The Cache provides JSON serialization, optional gzip compression, namespace
   * support, TTLs, hash helpers, and pattern-based cleanup. All multi-key
   * operations are slot-aware and cluster-safe.
   *
   * @example
   * ```ts
   * const cache = client.cache;
   * await cache.set('user:1', { name: 'alice' });
   * const user = await cache.get('user:1');
   * ```
   */
  get cache(): Cache {
    if (!this._cache) {
      this._cache = new Cache(
        this,
        this.config.cacheOptions ??  {},
        this.logger,
      );
    }

    return this._cache;
  }

  withCache(value: CacheInputConfig): RedisClientWrapper {
    const parsed = CacheOptionsSchema.safeParse(value);
    if (parsed.success) {
      const data = { ...this.config.cacheOptions, ...parsed.data };
      this.config.cacheOptions = data;
    } else {
      this.logger.error("Invalid cache options", { error: parsed.error });
      throw new ConfigurationError(
        `Invalid cache options: ${parsed.error.message}`,
        {
          message: prettifyError(parsed.error),
        },
      );

    }
    this._cache = undefined;
    return this;
  }

  // ========================================================================
  // Pub/Sub
  // ========================================================================

  /**
   * Returns the shared Pub/Sub instance (lazily created on first access).
   *
   * Publishing works immediately; subscribing requires calling {@link connectSubscriber}
   * first. Messages are JSON-serialized on publish and auto-parsed on delivery.
   *
   * @example
   * ```ts
   * const pubsub = client.pubsub;
   * await pubsub.connectSubscriber({ mode: 'standalone', host: 'localhost', port: 6379 });
   * await pubsub.subscribe('orders:created', (message) => {
   *   console.log(message); // { id: 1 }
   * });
   * await pubsub.publish('orders:created', { id: 1 });
   * ```
   */
  get pubsub(): PubSub {
    if (!this._pubsub) {
      this._pubsub = new PubSub(
        this,
        this.logger,
      );
    }

    return this._pubsub;
  }

  // ========================================================================
  // Distributed Lock
  // ========================================================================

  /**
   * Returns the shared DistributedLock instance (lazily created on first access).
   *
   * Provides atomic distributed mutual-exclusion locks backed by Redis. Works in
   * standalone, sentinel, and cluster modes. Acquisition uses atomic `SET ... PX NX`;
   * release and extension use Lua scripts so only the lock owner can release or extend.
   *
   * @example
   * ```ts
   * const lock = client.lock;
   * const acquired = await lock.acquire('order:42');
   * if (acquired) {
   *   try {
   *     // critical section
   *   } finally {
   *     await lock.release('order:42');
   *   }
   * }
   * ```
   */
  get lock(): DistributedLock {
    if (!this._lock) {
      this._lock = new DistributedLock(
        this,
        this.logger,
        this.config.lockOptions
      );
    }

    return this._lock;
  }

  withLock(value: DistributedLockInputOptions): RedisClientWrapper {
    const parseResult = DistributedLockOptionsSchema.safeParse(value);
    if (parseResult.success) {
      const data = { ...this.config.lockOptions, ...parseResult.data };
      this.config.lockOptions = data;
    } else {
      this.logger.error("Invalid lock options", { error: parseResult.error });
      throw new ConfigurationError(
        `Invalid lock options: ${parseResult.error.message}`,
        {
          message: prettifyError(parseResult.error),
        },
      );
    }
    this._lock = undefined;
    return this;
  }

  // ========================================================================
  // Rate Limiter
  // ========================================================================

  /**
   * Returns the shared RateLimiter instance (lazily created on first access).
   *
   * Generic rate limiting for any resource — routes, API endpoints, users, IPs,
   * API keys, database writes, email sends, webhooks. Supports fixed and sliding
   * window algorithms. Fails open when Redis is unavailable.
   *
   * @example
   * ```ts
   * const limiter = client.rateLimiter;
   * const result = await limiter.consume('/api/login', 'ip-10.0.0.1');
   * if (!result.allowed) {
   *   // HTTP 429, set Retry-After: result.retryAfter
   * }
   * ```
   */
  get rateLimiter(): RateLimiter {
    if (!this._rateLimiter) {
      this._rateLimiter = new RateLimiter(this, this.config.rateLimit);
    }

    return this._rateLimiter;
  }

  withRateLimiter(value: RateLimitOptionsInput): RedisClientWrapper {
    const parseResult = RateLimitOptionsSchema.safeParse(value);
    if (parseResult.success) {
      const data = { ...this.config.rateLimit, ...parseResult.data };
      this.config.rateLimit = data;
    } else {
      this.logger.error("Invalid rate limit options", { error: parseResult.error });
      throw new ConfigurationError(
        `Invalid rate limit options: ${parseResult.error.message}`,
        {
          message: prettifyError(parseResult.error),
        },
      );
    }
    this._rateLimiter = undefined;
    return this;
  }


  get revocationStore(): RedisRevocationStore {
    if (!this._revocationStore) {
      this._revocationStore = new RedisRevocationStore({
        client: this

      });
      this.config.sessionOptions = { ...(this.config.sessionOptions ?? {}), revocationStore: this._revocationStore };
    };

    return this._revocationStore;
  }

  // ========================================================================
  // Session
  // ========================================================================

  /**
   * Returns the shared SessionManager instance (lazily created on first access).
   *
   * The production session stack: validation with fail-closed semantics, rotation
   * with retry-safe idempotency, throttled touches, idle/absolute expiry, per-user
   * eviction ceilings, security versioning, optional AES-256-GCM encryption at rest,
   * fail-closed circuit breaker, metrics and health. Cluster-safe by construction.
   *
   * @example
   * ```ts
   * const manager = client.session;
   * const { token, session } = await manager.service.create({ userId: 'user-42' });
   * const result = await manager.service.validate(token, { userId: 'user-42' });
   * ```
   */
  get session(): SessionManager {
    if (!this._session) {
      const options = this.config.sessionOptions ?? {};
      const params = {
        ...options,
        client: this,
        revocationStore:
          options.revocationStore ?? this.revocationStore,
      }
      this._session = createSessionManager(params);
      this.config.sessionOptions = params

    }

    return this._session;
  }
  withSession(value: WithSessionManagerOptions): RedisClientWrapper {
    const revocationRedisStore = this.revocationStore;
    const config = deepMerge( this.config.sessionOptions  ?? {},value) as WithSessionManagerOptions

    const newConfig = {
      ...config,
      client: this,
      revocationStore: revocationRedisStore,
    }
    this.config.sessionOptions = newConfig;
    this._session = undefined;
    return this;
  }

  // ========================================================================
  // Client Creation
  // ========================================================================

  private createClient(): RedisUnderlyingClient {
    const common = this.buildCommonRedisOptions();

    const retryStrategy = (
      times: number,
    ): number | null => {
      if (times > this.config.maxRetries) {
        return null;
      }

      return Math.min(
        times * this.config.retryDelay,
        5_000,
      );
    };

    switch (this.config.mode) {
      case "cluster":
        return this.createClusterClient(
          this.config,
          common,
          retryStrategy,
        );

      case "sentinel":
        return this.createSentinelClient(
          this.config,
          common,
          retryStrategy,
        );

      case "standalone":
        return this.createStandaloneClient(
          this.config,
          common,
          retryStrategy,
        );
    }
  }

  private createClusterClient(
    config: ClusterRedisConfig,
    common: Omit<
      RedisOptions,
      | "retryStrategy"
      | "connectTimeout"
      | "maxRetriesPerRequest"
    >,
    retryStrategy: (
      times: number,
    ) => number | null,
  ): Cluster {
    return new Cluster(
      config.clusterNodes.map(
        ({ host, port }) => ({
          host,
          port,
        }),
      ),
      {
        clusterRetryStrategy: retryStrategy,

        enableOfflineQueue: true,

        scaleReads: "master",

        redisOptions: {

          ...common,
          connectTimeout:
            config.connectionTimeout,
          maxRetriesPerRequest:
            config.maxRetries,
        },
      },
    );
  }

  private createSentinelClient(
    config: SentinelRedisConfig,
    common: Omit<
      RedisOptions,
      | "retryStrategy"
      | "connectTimeout"
      | "maxRetriesPerRequest"
    >,
    retryStrategy: (
      times: number,
    ) => number | null,
  ): RedisClient {
    return new RedisClient({
      ...common,

      connectTimeout:
        config.connectionTimeout,

      maxRetriesPerRequest:
        config.maxRetries,

      retryStrategy,

      // sentinel: true,

      sentinels: config.sentinelNodes.map(
        ({ host, port }) => ({
          host,
          port,
        }),
      ),

      name: config.sentinelMasterName,
    });
  }

  private createStandaloneClient(
    config: StandaloneRedisConfig,
    common: Omit<
      RedisOptions,
      | "retryStrategy"
      | "connectTimeout"
      | "maxRetriesPerRequest"
    >,
    retryStrategy: (
      times: number,
    ) => number | null,
  ): RedisClient {
    const connectionOptions = {
      ...common,

      connectTimeout:
        config.connectionTimeout,

      maxRetriesPerRequest:
        config.maxRetries,

      retryStrategy,
    };

    if (config.url !== undefined) {
      return new RedisClient(
        config.url,
        connectionOptions,
      );
    }

    return new RedisClient({
      ...connectionOptions,

      host: config.host,
      port: config.port,
      db: config.database,
    });
  }

  private buildCommonRedisOptions(): Omit<
    RedisOptions,
    | "retryStrategy"
    | "connectTimeout"
    | "maxRetriesPerRequest"
  > {
    const options: Omit<
      RedisOptions,
      | "retryStrategy"
      | "connectTimeout"
      | "maxRetriesPerRequest"
    > = {
      enableReadyCheck: true,
      enableOfflineQueue: true,
      lazyConnect: false,
    };

    if (this.config.username !== undefined) {
      options.username = this.config.username;
    }

    if (this.config.password !== undefined) {
      options.password = this.config.password;
    }

    if (this.config.tls) {
      options.tls =
        this.config.tlsOptions ?? {
          rejectUnauthorized: true,
        };
    }

    return options;
  }

  // ========================================================================
  // Events
  // ========================================================================

  private setupEventHandlers(): void {
    this.client.on("connect", () => {
      this.logger.info("Redis connected");
    });

    this.client.on("ready", () => {
      this.isReady = true;

      this.logger.info("Redis ready");
    });

    this.client.on("error", (error) => {
      this.isReady = false;

      this.logger.error("Redis error:", {
        error,
      });
    });

    this.client.on("close", () => {
      this.isReady = false;

      this.logger.warn(
        "Redis connection closed",
      );
    });

    this.client.on("reconnecting", () => {
      this.isReady = false;

      this.logger.info(
        "Redis reconnecting...",
      );
    });
  }

  // ========================================================================
  // Raw Client
  // ========================================================================

  getRawClient<
    T extends RedisUnderlyingClient = RedisUnderlyingClient,
  >(): T {
    return this.client as T;
  }

  get raw(): RedisUnderlyingClient {
    return this.client;
  }

  // ========================================================================
  // Connection
  // ========================================================================

  async ping(): Promise<boolean> {
    try {
      const result = await this.exec(
        "PING",
        [],
        () => this.client.ping(),
      );

      return result === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } finally {
      this.isReady = false;
    }
  }

  // ========================================================================
  // Internal Helpers
  // ========================================================================

  private isClusterClient(
    client: RedisUnderlyingClient,
  ): client is Cluster {
    return client instanceof Cluster;
  }

  private async exec<T>(
    command: string,
    args: readonly unknown[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();

    try {
      const result = await operation();

      const duration =
        Date.now() - startedAt;

      if (
        duration >
        this.config.slowCommandThreshold
      ) {
        this.logger.warn(
          `Slow command: ${command} took ${duration}ms`,
          {
            command,
            args: args.slice(0, 5),
            duration,
          },
        );
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Command failed: ${command}`,
        {
          command,
          error,
        },
      );

      throw error;
    }
  }

  // ========================================================================
  // Basic Commands
  // ========================================================================

  async get(
    key: string,
  ): Promise<string | null> {
    return this.exec(
      "GET",
      [key],
      () => this.client.get(key),
    );
  }

  async set(
    key: string,
    value: string | Buffer,
    ttl?: number,
  ): Promise<"OK" | null> {
    if (ttl !== undefined) {
      return this.exec(
        "SET",
        [key, value, "EX", ttl],
        () =>
          this.client.set(
            key,
            value,
            "EX",
            ttl,
          ),
      );
    }

    return this.exec(
      "SET",
      [key, value],
      () =>
        this.client.set(
          key,
          value,
        ),
    );
  }

  async setexnx(
    key: string,
    value: string | Buffer,
    ttl?: number,
  ): Promise<"OK" | null> {
    if (ttl !== undefined) {
      return this.exec(
        "SET",
        [key, value, "EX", ttl, "NX"],
        () =>
          this.client.set(
            key,
            value,
            "EX",
            ttl,
            "NX",
          ),
      );
    }

    return this.exec(
      "SET",
      [key, value, "NX"],
      () =>
        this.client.set(
          key,
          value,
          "NX",
        ),
    );
  }

  defineCommand(
    ...args: Parameters<
      RedisClient["defineCommand"]
    >
  ): ReturnType<
    RedisClient["defineCommand"]
  > {
    return this.client.defineCommand(
      ...args,
    );
  }

  async eval(
    script: string,
    numKeys: number,
    ...args: RedisCommandArgument[]
  ): Promise<unknown> {
    return this.exec(
      "EVAL",
      [script, numKeys, ...args],
      () =>
        this.client.eval(
          script,
          numKeys,
          ...args,
        ),
    );
  }

  async evalsha(
    sha: string,
    script: string,
    numKeys: number,
    ...args: RedisCommandArgument[]
  ): Promise<unknown> {
    try {
      return await this.exec(
        "EVALSHA",
        [sha, numKeys, ...args],
        () =>
          this.client.evalsha(
            sha,
            numKeys,
            ...args,
          ),
      );
    } catch (error) {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        code === "NOSCRIPT" ||
        message.includes("NOSCRIPT")
      ) {
        return this.eval(
          script,
          numKeys,
          ...args,
        );
      }

      throw error;
    }
  }

  async scriptLoad(
    script: string,
  ): Promise<string> {
    return this.exec(
      "SCRIPT LOAD",
      [script],
      () =>
        this.client.script(
          "LOAD",
          script,
        ) as Promise<string>,
    );
  }

  async setnx(
    key: string,
    value: string | Buffer,
    ttl?: number,
  ): Promise<number> {
    const result =
      ttl !== undefined
        ? await this.exec(
            "SET",
            [key, value, "EX", ttl, "NX"],
            () =>
              this.client.set(
                key,
                value,
                "EX",
                ttl,
                "NX",
              ),
          )
        : await this.exec(
            "SET",
            [key, value, "NX"],
            () =>
              this.client.set(
                key,
                value,
                "NX",
              ),
          );

    return result === "OK" ? 1 : 0;
  }

  async del(
    ...keys: string[]
  ): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }

    return this.exec(
      "DEL",
      keys,
      () =>
        this.client.del(...keys),
    );
  }

  async getdel(
    key: string,
  ): Promise<string | null> {
    return this.exec(
      "GETDEL",
      [key],
      () => this.client.getdel(key),
    );
  }

  async exists(
    key: string,
  ): Promise<number> {
    return this.exec(
      "EXISTS",
      [key],
      () => this.client.exists(key),
    );
  }

  async expire(
    key: string,
    ttl: number,
  ): Promise<number> {
    return this.exec(
      "EXPIRE",
      [key, ttl],
      () =>
        this.client.expire(
          key,
          ttl,
        ),
    );
  }

  async ttl(
    key: string,
  ): Promise<number> {
    return this.exec(
      "TTL",
      [key],
      () => this.client.ttl(key),
    );
  }

  async incr(
    key: string,
  ): Promise<number> {
    return this.exec(
      "INCR",
      [key],
      () => this.client.incr(key),
    );
  }

  async decr(
    key: string,
  ): Promise<number> {
    return this.exec(
      "DECR",
      [key],
      () => this.client.decr(key),
    );
  }

  async incrby(
    key: string,
    amount: number,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      throw new RedisError(
        "INCRBY amount must be a positive safe integer",
        "INVALID_AMOUNT",
      );
    }

    return this.exec(
      "INCRBY",
      [key, amount],
      () =>
        this.client.incrby(
          key,
          amount,
        ),
    );
  }

  async decrby(
    key: string,
    amount: number,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      throw new RedisError(
        "DECRBY amount must be a positive safe integer",
        "INVALID_AMOUNT",
      );
    }

    return this.exec(
      "DECRBY",
      [key, amount],
      () =>
        this.client.decrby(
          key,
          amount,
        ),
    );
  }

  async time(): Promise<number> {
    const result = await this.exec(
      "TIME",
      [],
      () => this.client.time(),
    );

    if (
      Array.isArray(result) &&
      result.length > 0
    ) {
      const seconds = Number(result[0]);

      if (
        Number.isSafeInteger(seconds)
      ) {
        return seconds;
      }
    }

    throw new RedisError(
      "Unexpected TIME response from Redis",
      "TIME_ERROR",
    );
  }

  // ========================================================================
  // Multi-Key Commands
  // ========================================================================

  async mget(
    ...keys: string[]
  ): Promise<(string | null)[]> {
    if (keys.length === 0) {
      return [];
    }

    if (this.isClusterClient(this.client)) {
      return this.mgetClusterAware(keys);
    }

    return this.exec(
      "MGET",
      keys,
      () =>
        this.client.mget(...keys),
    );
  }

  async mset(
    ...pairs: Array<
      [string, string | Buffer]
    >
  ): Promise<"OK"> {
    if (pairs.length === 0) {
      return "OK";
    }

    if (
      this.isClusterClient(this.client)
    ) {
      const groups =
        new Map<
          number,
          Array<string | Buffer>
        >();

      for (const [
        key,
        value,
      ] of pairs) {
        const slot =
          this.calculateSlot(key);

        const group =
          groups.get(slot) ?? [];

        group.push(key, value);

        groups.set(
          slot,
          group,
        );
      }

      const tasks =
        [...groups.values()];

      await this.runWithConcurrency(
        tasks,
        this.config.maxFanOutConcurrency,
        async (flat) => {
          await this.exec(
            "MSET",
            flat,
            () =>
              this.client.mset(
                flat,
              ),
          );
        },
      );

      return "OK";
    }

    const flat =
      pairs.flat();

    return this.exec(
      "MSET",
      flat,
      () =>
        this.client.mset(
          flat,
        ),
    );
  }

  // ========================================================================
  // Hash Commands
  // ========================================================================

  async hget(
    key: string,
    field: string,
  ): Promise<string | null> {
    return this.exec(
      "HGET",
      [key, field],
      () =>
        this.client.hget(
          key,
          field,
        ),
    );
  }

  async hset(
    key: string,
    field: string,
    value: string | Buffer,
  ): Promise<number> {
    return this.exec(
      "HSET",
      [key, field, value],
      () =>
        this.client.hset(
          key,
          field,
          value,
        ),
    );
  }

  async hgetall(
    key: string,
  ): Promise<Record<string, string>> {
    return this.exec(
      "HGETALL",
      [key],
      () =>
        this.client.hgetall(key),
    );
  }

  async hdel(
    key: string,
    ...fields: string[]
  ): Promise<number> {
    if (fields.length === 0) {
      return 0;
    }

    return this.exec(
      "HDEL",
      [key, ...fields],
      () =>
        this.client.hdel(
          key,
          ...fields,
        ),
    );
  }

  // ========================================================================
  // Set Commands
  // ========================================================================

  async sadd(
    key: string,
    ...members: string[]
  ): Promise<number> {
    if (members.length === 0) {
      return 0;
    }

    return this.exec(
      "SADD",
      [key, ...members],
      () =>
        this.client.sadd(
          key,
          ...members,
        ),
    );
  }

  async srem(
    key: string,
    ...members: string[]
  ): Promise<number> {
    if (members.length === 0) {
      return 0;
    }

    return this.exec(
      "SREM",
      [key, ...members],
      () =>
        this.client.srem(
          key,
          ...members,
        ),
    );
  }

  async smembers(
    key: string,
  ): Promise<string[]> {
    return this.exec(
      "SMEMBERS",
      [key],
      () =>
        this.client.smembers(key),
    );
  }

  async sismember(
    key: string,
    member: string,
  ): Promise<number> {
    return this.exec(
      "SISMEMBER",
      [key, member],
      () =>
        this.client.sismember(
          key,
          member,
        ),
    );
  }

  // ========================================================================
  // Sorted Set Commands
  // ========================================================================

  async zadd(
    key: string,
    score: number,
    member: string,
  ): Promise<number> {
    return this.exec(
      "ZADD",
      [key, score, member],
      () =>
        this.client.zadd(
          key,
          score,
          member,
        ),
    );
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
  ): Promise<string[]> {
    return this.exec(
      "ZRANGE",
      [key, start, stop],
      () =>
        this.client.zrange(
          key,
          start,
          stop,
        ),
    );
  }

  async zcard(
    key: string,
  ): Promise<number> {
    return this.exec(
      "ZCARD",
      [key],
      () =>
        this.client.zcard(key),
    );
  }

  async zrem(
    key: string,
    ...members: string[]
  ): Promise<number> {
    if (members.length === 0) {
      return 0;
    }

    return this.exec(
      "ZREM",
      [key, ...members],
      () =>
        this.client.zrem(
          key,
          ...members,
        ),
    );
  }

  // ========================================================================
  // Pipeline
  // ========================================================================

  pipeline(): ReturnType<
    RedisClient["pipeline"]
  > {
    return this.client.pipeline();
  }

  // ========================================================================
  // Scanning
  // ========================================================================

  async *scanIterator(
    pattern: string,
    count = 100,
  ): AsyncIterable<string> {
    for await (
      const batch of this.scanCluster(
        pattern,
        {
          count,
          batchSize: 1,
        },
      )
    ) {
      for (const key of batch) {
        yield key;
      }
    }
  }

  async *scanCluster(
    pattern: string,
    options: ScanOptions = {},
  ): AsyncIterable<string[]> {
    const count =
      options.count ?? 100;

    const batchSize = Math.max(
      1,
      options.batchSize ?? 100,
    );

    const scanNode = async function* (
      node: RedisClient,
    ): AsyncIterable<string[]> {
      let cursor = "0";
      let buffer: string[] = [];

      do {
        const [
          nextCursor,
          keys,
        ] = await node.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          count,
        );

        cursor = nextCursor;

        buffer.push(...keys);

        while (
          buffer.length >=
          batchSize
        ) {
          yield buffer.splice(
            0,
            batchSize,
          );
        }
      } while (
        cursor !== "0"
      );

      if (buffer.length > 0) {
        yield buffer;
      }
    };

    const nodes: RedisClient[] =
      this.isClusterClient(
        this.client,
      )
        ? this.getClusterNodes()
        : [this.client];

    for (const node of nodes) {
      yield* scanNode(node);
    }
  }

  // ========================================================================
  // Cluster
  // ========================================================================

  isCluster(): boolean {
    return this.isClusterClient(
      this.client,
    );
  }

  getClusterNodes(): RedisClient[] {
    if (
      !this.isClusterClient(
        this.client,
      )
    ) {
      return [];
    }

    return this.client.nodes(
      "master",
    );
  }

  async getClusterSlots(): Promise<
    ClusterSlotRange[]
  > {
    if (
      !this.isClusterClient(
        this.client,
      )
    ) {
      return [];
    }

    const raw =
      (await this.exec(
        "CLUSTER SLOTS",
        [],
        () =>
          this.client.cluster(
            "SLOTS",
          ),
      )) as ClusterSlotsResponse;

    if (!Array.isArray(raw)) {
      return [];
    }

    return raw.flatMap(
      (entry): ClusterSlotRange[] => {
        if (
          !Array.isArray(entry) ||
          entry.length < 3
        ) {
          return [];
        }

        const [
          start,
          end,
          master,
          ...replicas
        ] = entry as ClusterSlotEntry;

        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          !Array.isArray(master)
        ) {
          return [];
        }

        const parseNode = (
          node: unknown,
        ): ClusterNodeDescriptor | null => {
          if (
            !Array.isArray(node) ||
            node.length < 2
          ) {
            return null;
          }

          const host =
            typeof node[0] === "string"
              ? node[0]
              : String(node[0]);

          const port =
            typeof node[1] === "number"
              ? node[1]
              : Number(node[1]);

          if (
            host.length === 0 ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65_535
          ) {
            return null;
          }

          const nodeId =
            node[2] === undefined
              ? undefined
              : String(node[2]);

          return nodeId === undefined
            ? {
                host,
                port,
              }
            : {
                host,
                port,
                nodeId,
              };
        };

        const parsedMaster =
          parseNode(master);

        if (!parsedMaster) {
          return [];
        }

        const parsedReplicas =
          replicas
            .map(parseNode)
            .filter(
              (
                node,
              ): node is ClusterNodeDescriptor =>
                node !== null,
            );

        return [
          {
            start,
            end,
            master: parsedMaster,
            replicas:
              parsedReplicas,
          },
        ];
      },
    );
  }

  calculateSlot(
    key: string,
  ): number {
    return calculateRedisClusterSlot(
      key,
    );
  }

  async getNodeForKey(
    key: string,
  ): Promise<RedisClient | null> {
    if (
      !this.isClusterClient(
        this.client,
      )
    ) {
      return null;
    }

    const nodes =
      this.client.nodes("master");

    if (nodes.length === 0) {
      return null;
    }

    try {
      const slot =
        this.calculateSlot(key);

      const raw =
        await this.client.cluster(
          "SLOTS",
        );

      if (!Array.isArray(raw)) {
        return null;
      }

      for (const entry of raw) {
        if (
          !Array.isArray(entry) ||
          entry.length < 3
        ) {
          continue;
        }

        const [
          startSlot,
          endSlot,
          master,
        ] = entry;

        if (
          typeof startSlot !==
            "number" ||
          typeof endSlot !==
            "number" ||
          !Array.isArray(master)
        ) {
          continue;
        }

        if (
          slot < startSlot ||
          slot > endSlot
        ) {
          continue;
        }

        const host =
          String(
            master[2] ?? "",
          );

        const port =
          Number(master[1]);

        if (
          host.length === 0 ||
          !Number.isInteger(port)
        ) {
          continue;
        }

        const node =
          nodes.find(
            (candidate) =>
              candidate.options
                .host === host &&
              candidate.options
                .port === port,
          );

        if (node) {
          return node;
        }
      }
    } catch (error) {
      this.logger.debug(
        "Unable to resolve cluster node for key",
        {
          error,
        },
      );
    }

    return null;
  }

  async getSlotRanges(): Promise<
    Map<number, string[]>
  > {
    const result =
      new Map<
        number,
        string[]
      >();

    const ranges =
      await this.getClusterSlots();

    for (const range of ranges) {
      const nodeId =
        `${range.master.host}:${range.master.port}`;

      for (
        let slot = range.start;
        slot <= range.end;
        slot++
      ) {
        result.set(slot, [
          nodeId,
        ]);
      }
    }

    return result;
  }

  async isKeyServed(
    key: string,
  ): Promise<boolean> {
    if (
      !this.isClusterClient(
        this.client,
      )
    ) {
      return true;
    }

    try {
      const node =
        await this.getNodeForKey(
          key,
        );

      return node !== null;
    } catch {
      return false;
    }
  }

  async executeOnNode<T>(
    key: string,
    command: string,
    ...args: unknown[]
  ): Promise<T> {
    if (
      this.isClusterClient(
        this.client,
      )
    ) {
      const node =
        await this.getNodeForKey(
          key,
        );

      if (node) {
        return this.executeCommandOnClient<T>(
          node,
          command,
          args,
        );
      }
    }

    return this.executeCommandOnClient<T>(
      this.client,
      command,
      args,
    );
  }

  private executeCommandOnClient<T>(
    client: RedisUnderlyingClient,
    command: string,
    args: readonly unknown[],
  ): Promise<T> {
    const method =
      Reflect.get(
        client,
        command,
      );

    if (
      typeof method !==
      "function"
    ) {
      throw new RedisError(
        `Unsupported Redis command: ${command}`,
        "UNSUPPORTED_COMMAND",
      );
    }

    return Reflect.apply(
      method,
      client,
      args,
    ) as Promise<T>;
  }

  // ========================================================================
  // Cluster-Aware MGET
  // ========================================================================

  async mgetClusterAware(
    keys: string[],
  ): Promise<(string | null)[]> {
    if (keys.length === 0) {
      return [];
    }

    if (
      !this.isClusterClient(
        this.client,
      )
    ) {
      return this.mget(...keys);
    }

    const groups =
      new Map<
        number,
        string[]
      >();

    for (const key of keys) {
      const slot =
        this.calculateSlot(key);

      const group =
        groups.get(slot) ?? [];

      group.push(key);

      groups.set(
        slot,
        group,
      );
    }

    const values =
      new Map<
        string,
        string | null
      >();

    await this.runWithConcurrency(
      [...groups.values()],
      this.config
        .maxFanOutConcurrency,
      async (slotKeys) => {
        const result =
          await this.exec(
            "MGET",
            slotKeys,
            () =>
              this.client.mget(
                ...slotKeys,
              ),
          );

        slotKeys.forEach(
          (
            key,
            index,
          ) => {
            values.set(
              key,
              result[index] ??
                null,
            );
          },
        );
      },
    );

    return keys.map(
      (key) =>
        values.get(key) ??
        null,
    );
  }

  // ========================================================================
  // Namespace Operations
  // ========================================================================

  async deletePattern(
    pattern: string,
    options: DeletePatternOptions = {},
  ): Promise<number> {
    const batchSize =
      Math.max(
        1,
        options.batchSize ??
          100,
      );

    const scanCount =
      Math.max(
        1,
        options.scanCount ??
          100,
      );

    let deleted = 0;

    for await (
      const batch of this.scanCluster(
        pattern,
        {
          count: scanCount,
          batchSize,
        },
      )
    ) {
      if (batch.length === 0) {
        continue;
      }

      const commands =
        batch.map(
          (key) => ({
            command: "del",
            args: [key],
            slot:
              this.calculateSlot(
                key,
              ),
          }),
        );

      const results =
        await executeBySlot(
          this,
          commands,
          {
            concurrency:
              this.config
                .maxFanOutConcurrency,
            retry: 1,
          },
        );

      for (const result of results) {
        if (
          !result[0] &&
          typeof result[1] ===
            "number"
        ) {
          deleted += result[1];
        }
      }
    }

    return deleted;
  }

  async clearNamespace(
    prefix: string,
    options: DeletePatternOptions = {},
  ): Promise<number> {
    return this.deletePattern(
      `${prefix}*`,
      options,
    );
  }

  async clearNamespaceClusterAware(
    prefix: string,
    options: DeletePatternOptions = {},
  ): Promise<number> {
    return this.clearNamespace(
      prefix,
      options,
    );
  }

  // ========================================================================
  // Cluster Information
  // ========================================================================

  getClusterInfo(): ClusterInfo {
    if (
      this.isClusterClient(
        this.client,
      )
    ) {
      try {
        const nodes =
          this.client.nodes(
            "master",
          );

        return {
          mode: "cluster",

          status: this.isReady
            ? "ready"
            : "connecting",

          nodeCount:
            nodes.length,

          nodes: nodes.map(
            (node) => ({
              host:
                String(
                  node.options
                    .host ??
                    "",
                ),

              port:
                Number(
                  node.options
                    .port,
                ),

              role: "master",
            }),
          ),
        };
      } catch (error) {
        return {
          mode: "cluster",
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : String(error),
        };
      }
    }

    if (
      isStandaloneConfig(
        this.config,
      )
    ) {
      return {
        mode: "standalone",

        host: this.config.host,

        port: this.config.port,

        status: this.isReady
          ? "ready"
          : "connecting",
      };
    }

    return {
      mode: this.config.mode,

      status: this.isReady
        ? "ready"
        : "connecting",
    };
  }

  // ========================================================================
  // INFO
  // ========================================================================

  async info(
    section?: string,
  ): Promise<string> {
    if (section !== undefined) {
      return this.exec(
        "INFO",
        [section],
        () =>
          this.client.info(
            section,
          ),
      );
    }

    return this.exec(
      "INFO",
      [],
      () => this.client.info(),
    );
  }

  // ========================================================================
  // SELECT
  // ========================================================================

  async select(
    database: number,
  ): Promise<"OK"> {
    if (
      this.isClusterClient(
        this.client,
      )
    ) {
      throw new RedisError(
        "SELECT is not supported in Redis Cluster mode",
        "CLUSTER_MODE",
      );
    }

    if (
      !Number.isInteger(
        database,
      ) ||
      database < 0 ||
      database > 15
    ) {
      throw new RedisError(
        "Database must be an integer between 0 and 15",
        "INVALID_DATABASE",
      );
    }

    return this.client.select(
      database,
    );
  }

  // ========================================================================
  // Connection Status
  // ========================================================================

  getConnectionStatus(): ConnectionStatus {
    const state =
      this.isReady
        ? "connected"
        : this.client.status ===
            "connecting"
          ? "connecting"
          : this.client.status ===
              "end"
            ? "closed"
            : this.client.status ===
                "ready"
              ? "connected"
              : "disconnected";

    return {
      state,
      connected: this.isReady,
      ready: this.isReady,
      reconnectAttempts: 0,
      uptime: 0,
    };
  }

  // ========================================================================
  // Concurrency Helper
  // ========================================================================

  private async runWithConcurrency<
    T,
  >(
    items: readonly T[],
    concurrency: number,
    worker: (
      item: T,
    ) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const limit = Math.max(
      1,
      Math.min(
        concurrency,
        items.length,
      ),
    );

    let cursor = 0;

    const workers =
      Array.from(
        {
          length: limit,
        },
        async () => {
          while (true) {
            const index =
              cursor++;

            if (
              index >=
              items.length
            ) {
              return;
            }

            await worker(
              items[index]!,
            );
          }
        },
      );

    await Promise.all(
      workers,
    );
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Cluster-specific factory overload.
 */
export function createRedisClient(
  config: Extract<
    RedisConfigInput,
    { mode: "cluster" }
  >,
  logger?: LoggerLike,
): RedisClientForMode<"cluster">;

/**
 * Sentinel-specific factory overload.
 */
export function createRedisClient(
  config: Extract<
    RedisConfigInput,
    { mode: "sentinel" }
  >,
  logger?: LoggerLike,
): RedisClientForMode<"sentinel">;

/**
 * Standalone factory overload.
 *
 * Standalone is also the default topology, therefore the input type permits
 * the discriminator to be omitted.
 */
export function createRedisClient(
  config: Exclude<
    RedisConfigInput,
    {
      mode:
        | "cluster"
        | "sentinel";
    }
  >,
  logger?: LoggerLike,
): RedisClientForMode<"standalone">;

/**
 * Generic runtime factory.
 */
export function createRedisClient(
  config: RedisConfigInput,
  logger?: LoggerLike,
):
  | RedisClientForMode<"cluster">
  | RedisClientForMode<"sentinel">
  | RedisClientForMode<"standalone"> {
  const client =
    new RedisClientWrapper(
      config,
      logger,
    );

  /**
   * The runtime configuration has already been validated by
   * RedisConfigSchema inside RedisClientWrapper.
   *
   * The specialized public API is therefore safe to expose according to
   * the validated discriminator.
   *
   * The cast is isolated to this factory boundary instead of being spread
   * throughout the implementation.
   */
  switch (client.mode) {
    case "cluster":
      return client as RedisClientForMode<"cluster">;

    case "sentinel":
      return client as RedisClientForMode<"sentinel">;

    case "standalone":
      return client as RedisClientForMode<"standalone">;
  }
}
