import { StreamsError, parseStreamsConfig } from 'ioredis-toolkit/streams';
import type { RedisStreams, StreamEntry, StreamReadOptions, StreamsConfig, StreamsErrorCode } from 'ioredis-toolkit/streams';

export const configured: StreamsConfig = parseStreamsConfig({ enabled: true, namespace: 'app:stream' });
export const section: Partial<StreamsConfig> = { enabled: true, maxEntries: 100_000 };

const asWorker: StreamReadOptions = { group: 'workers', consumer: 'worker-1', count: 10, id: '>' };

export async function drain(streams: RedisStreams, name: string, handle: (entry: StreamEntry) => Promise<void>): Promise<number> {
  const entries: StreamEntry[] = await streams.read(name, asWorker);
  for (const entry of entries) await handle(entry);
  return entries.length ? streams.ack(name, 'workers', ...entries.map(entry => entry.id)) : 0;
}

export function failureKind(error: unknown): StreamsErrorCode | undefined {
  return error instanceof StreamsError ? error.code : undefined;
}
