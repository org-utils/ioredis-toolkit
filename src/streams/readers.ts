import { RedisClientWrapper, containedReporter, reportConnectionErrors, type ErrorReporter, type RedisConnection } from '../redis/index.js';

/** A leased connection, and the command wrapper a read is given for it. */
interface Reader { connection: RedisConnection; client: RedisClientWrapper }

/**
 * Connections for blocking stream reads, duplicated from the shared one so that a read waiting on a stream never holds up
 * another command. Grown lazily: a read leases an idle connection, or a new one when none is idle, and hands it back after.
 */
class StreamReaders {
  private readonly idle: Reader[] = [];
  private readonly open = new Set<Reader>();
  private closed = false;

  constructor(private readonly redis: RedisClientWrapper, private readonly report: ErrorReporter<'stream-reader'>) {}

  /**
   * Runs `read` on a leased connection. Once the readers are closed it runs on the shared connection instead, which is
   * closed with them, so the read fails as any other command on a closed client does and opens nothing.
   */
  async using<T>(read: (client: RedisClientWrapper) => Promise<T>): Promise<T> {
    if (this.closed) return read(this.redis);
    const reader = this.idleReader() ?? this.lease();
    try { return await read(reader.client); }
    finally { this.giveBack(reader); }
  }

  /** Disconnects every reader, idle or leased, so a read still blocked ends at once. Idempotent. */
  close(): void {
    this.closed = true;
    this.idle.length = 0;
    for (const { connection } of this.open) connection.disconnect();
    this.open.clear();
  }

  /** An idle reader whose connection has not given up for good while it sat idle, if there is one. */
  private idleReader(): Reader | undefined {
    for (let reader = this.idle.pop(); reader; reader = this.idle.pop()) {
      if (reader.connection.status !== 'end') return reader;
      this.open.delete(reader);
    }
    return undefined;
  }

  private lease(): Reader {
    const connection = this.redis.duplicateConnection();
    reportConnectionErrors(connection, this.report, 'stream-reader');
    const reader = { connection, client: new RedisClientWrapper(connection) };
    this.open.add(reader);
    return reader;
  }

  /** Returns a reader to the idle pool, unless the readers are closed or its connection has given up for good. */
  private giveBack(reader: Reader): void {
    if (!this.closed && reader.connection.status !== 'end') { this.idle.push(reader); return; }
    reader.connection.disconnect();
    this.open.delete(reader);
  }
}

/** One set of readers per shared connection, so every Streams module built on a client, reconfigured or not, shares it. */
const readersByConnection = new WeakMap<RedisClientWrapper, StreamReaders>();

/** The stream readers of a shared connection, created on first use with `report` receiving their connection errors. */
export function streamReadersOf(redis: RedisClientWrapper, report: ErrorReporter<'stream-reader'> = containedReporter()): StreamReaders {
  let readers = readersByConnection.get(redis);
  if (!readers) { readers = new StreamReaders(redis, report); readersByConnection.set(redis, readers); }
  return readers;
}
