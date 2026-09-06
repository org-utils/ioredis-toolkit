import type { RedisClientWrapper } from '../redis/wrapper.js';
import type { StreamEntry, StreamReadOptions, StreamsConfig } from './types.js';

/** Redis Streams abstraction for append, consumer groups, reads and acknowledgements. */
export class RedisStreams {
  /** Creates a Streams module bound to the shared Redis client. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: StreamsConfig) {}
  /** Builds the physical stream key. */
  key(name: string): string { return `${this.config.keyPrefix}:${name}`; }
  /** Appends a field map to a stream and optionally trims the stream length. */
  async add(name: string, fields: Record<string, string>, maxEntries = this.config.maxEntries): Promise<string> { return this.redis.xadd(this.key(name), 'MAXLEN', '~', String(maxEntries), '*', ...Object.entries(fields).flat()); }
  /** Creates a consumer group; when startId is omitted, the group starts at '$'. */
  async createGroup(name: string, group: string, startId = '$', mkStream = true): Promise<void> { try { await this.redis.xgroup('CREATE', this.key(name), group, startId, ...(mkStream ? ['MKSTREAM'] : [])); } catch (error) { if (!(error instanceof Error) || !/BUSYGROUP/.test(error.message)) throw error; } }
  /** Reads entries from a stream, optionally through a consumer group. */
  async read(name: string, options: StreamReadOptions = {}): Promise<StreamEntry[]> {
    if (options.group !== undefined && options.consumer === undefined) throw new RangeError('Stream reads via a consumer group require options.consumer');
    const useGroup = options.group !== undefined && options.consumer !== undefined;
    const count = options.count ?? 100;
    const id = options.id ?? (useGroup ? '>' : '$');
    const blockMs = options.blockMs ?? this.config.blockMs;
    const result = useGroup
      ? await this.redis.xreadgroup('GROUP', options.group!, options.consumer!, 'COUNT', String(count), 'BLOCK', String(blockMs), 'STREAMS', this.key(name), id)
      : await this.redis.xread('COUNT', String(count), 'BLOCK', String(blockMs), 'STREAMS', this.key(name), id);
    return parseStreamResult(result);
  }
  /** Acknowledges one or more group messages. */
  async ack(name: string, group: string, ...ids: string[]): Promise<number> { return this.redis.xack(this.key(name), group, ...ids); }
  /** Removes entries by ID from a stream. */
  async delete(name: string, ...ids: string[]): Promise<number> { return this.redis.xdel(this.key(name), ...ids); }
  /** Returns the stream length. */
  async length(name: string): Promise<number> { return this.redis.xlen(this.key(name)); }
}

function parseStreamResult(result: unknown): StreamEntry[] {
  if (!Array.isArray(result) || result.length === 0) return [];
  const stream = result[0] as [string, Array<[string, string[]]>]; if (!stream || !Array.isArray(stream[1])) return [];
  return stream[1].map(([id, values]) => { const fields: Record<string, string> = {}; for (let i = 0; i < values.length; i += 2) { const key = values[i]; const value = values[i + 1]; if (key !== undefined && value !== undefined) fields[key] = value; } return { id, fields }; });
}
