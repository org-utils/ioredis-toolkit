/** Normalized configuration for {@link RedisStreams}. */
export interface StreamsConfig {
  /** Whether the application has enabled the module. The class remains directly constructible when false; {@link RedisClient}'s `streams` getter throws when disabled. */
  enabled: boolean;
  /** Prefix used for physical stream keys. */
  keyPrefix: string;
  /** Approximate number of entries retained by the default `add()` trim operation. */
  maxEntries: number;
  /** Default configured blocking duration in milliseconds for application policy. */
  blockMs: number;
}

/** One decoded Redis Stream entry. */
export interface StreamEntry {
  /** Redis stream entry ID, for example `1750000000000-0`. */
  id: string;
  /** Field/value pairs returned by Redis. */
  fields: Record<string, string>;
}

/** Options controlling a stream read. */
export interface StreamReadOptions {
  /** Consumer group name. Supplying this selects `XREADGROUP`. */
  group?: string;
  /** Consumer name. Required when `group` is supplied. */
  consumer?: string;
  /** Maximum number of entries requested from Redis. */
  count?: number;
  /** Optional blocking duration in milliseconds. */
  blockMs?: number;
  /** Starting/continuation ID. Group reads commonly use `>`. */
  id?: string;
}
