import { KeyStrategy, type ErrorReporter, type RedisClientWrapper } from '../redis/index.js';
import { streamReadersOf } from './readers.js';
import { StreamsError, type StreamEntry, type StreamReadOptions, type StreamsConfig } from './types.js';

/**
 * Redis Streams abstraction for append, consumer groups, reads and acknowledgements. A blocking read runs on a connection
 * of its own, leased from a pool of duplicates of the shared connection, so it never holds up the client's other commands.
 */
export class RedisStreams {
  private readonly keys: KeyStrategy;
  private readonly readers: ReturnType<typeof streamReadersOf>;
  /**
   * Creates a Streams module bound to the shared Redis client. Errors on its reader connections go to `report` and never
   * crash the process; every Streams module on one client shares those connections.
   */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: StreamsConfig, report?: ErrorReporter<'stream-reader'>) {
    this.keys = new KeyStrategy(config.namespace);
    this.readers = streamReadersOf(redis, report);
  }
  /** Builds the physical stream key. */
  key(name: string): string { return this.keys.key(name); }
  /** Appends a field map to a stream and optionally trims the stream length. */
  async add(name: string, fields: Record<string, string>, maxEntries = this.config.maxEntries): Promise<string> {
    const values = Object.entries(fields).flat();
    if (values.length === 0) throw new StreamsError('STREAMS_INPUT', 'A stream entry needs at least one field');
    return this.redis.xadd(this.key(name), 'MAXLEN', '~', String(maxEntries), '*', ...values);
  }
  /** Creates a consumer group; when startId is omitted, the group starts at '$'. */
  async createGroup(name: string, group: string, startId = '$', mkStream = true): Promise<void> { try { await this.redis.xgroup('CREATE', this.key(name), group, startId, ...(mkStream ? ['MKSTREAM'] : [])); } catch (error) { if (!(error instanceof Error) || !/BUSYGROUP/.test(error.message)) throw error; } }
  /**
   * Reads entries from a stream, optionally through a consumer group, waiting up to `blockMs` (the configured default when
   * omitted, indefinitely when 0) for one to arrive. The wait happens on a leased reader connection, never the shared one.
   */
  async read(name: string, options: StreamReadOptions = {}): Promise<StreamEntry[]> {
    if (options.group !== undefined && options.consumer === undefined) throw new StreamsError('STREAMS_INPUT', 'Stream reads via a consumer group require options.consumer');
    const useGroup = options.group !== undefined && options.consumer !== undefined;
    const count = options.count ?? 100;
    const id = options.id ?? (useGroup ? '>' : '$');
    const blockMs = options.blockMs ?? this.config.blockMs;
    const result = await this.readers.using(reader => (useGroup
      ? reader.xreadgroup('GROUP', options.group!, options.consumer!, 'COUNT', String(count), 'BLOCK', String(blockMs), 'STREAMS', this.key(name), id)
      : reader.xread('COUNT', String(count), 'BLOCK', String(blockMs), 'STREAMS', this.key(name), id)));
    return parseStreamResult(result);
  }
  /** Acknowledges one or more group messages. */
  async ack(name: string, group: string, ...ids: string[]): Promise<number> { return this.redis.xack(this.key(name), group, ...ids); }
  /** Removes entries by ID from a stream. */
  async delete(name: string, ...ids: string[]): Promise<number> { return this.redis.xdel(this.key(name), ...ids); }
  /** Returns the stream length. */
  async length(name: string): Promise<number> { return this.redis.xlen(this.key(name)); }
  /** Disconnects the reader connections of every Streams module on this client, ending any read still waiting. Idempotent. */
  async close(): Promise<void> { this.readers.close(); }
}

function parseStreamResult(result: unknown): StreamEntry[] {
  if (!Array.isArray(result) || result.length === 0) return [];
  const stream = result[0] as [string, Array<[string, string[]]>]; if (!stream || !Array.isArray(stream[1])) return [];
  return stream[1].map(([id, values]) => { const fields: Record<string, string> = {}; for (let i = 0; i < values.length; i += 2) { const key = values[i]; const value = values[i + 1]; if (key !== undefined && value !== undefined) fields[key] = value; } return { id, fields }; });
}
