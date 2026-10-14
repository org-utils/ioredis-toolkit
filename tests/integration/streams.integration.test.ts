import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { StreamEntry } from '../../src/index.js';
import { describeOnEachTopology, eventually } from '../support/redis.js';

describeOnEachTopology('Streams against real Redis', redis => {
  /** A client with Streams and a cache, every connection it opens named, so its blocked readers can be found. */
  function namedClient() {
    const connectionName = `streams-${randomUUID()}`;
    const client = redis.connectClient({
      ...redis.namedConnectionConfig(connectionName),
      streams: { enabled: true, namespace: redis.newNamespace() },
      cache: { enabled: true, namespace: redis.newNamespace() },
    });
    return { client, connectionName };
  }

  /** Resolves once `count` of the named connections are blocked in a stream read, so an entry added next is one they wait for. */
  async function readersBlocked(connectionName: string, count: number): Promise<void> {
    await eventually(async () => {
      const blocked = (await redis.connectionsNamed(connectionName)).filter(line => /\bcmd=xread(group)?\b/.test(line) && /\bflags=\w*b/.test(line));
      expect(blocked).toHaveLength(count);
    });
  }

  /** How long `work` takes, in milliseconds of local time. */
  async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
    const started = performance.now();
    const value = await work;
    return { value, ms: performance.now() - started };
  }

  it('leaves the shared connection free while a blocking read waits', async () => {
    const { client, connectionName } = namedClient();
    const read = client.streams.read('events', { blockMs: 5_000 });
    await readersBlocked(connectionName, 1);

    const { ms } = await timed(client.cache.get('k'));
    expect(ms).toBeLessThan(500);

    await client.streams.add('events', { n: '1' });
    expect((await read).map(entry => entry.fields)).toEqual([{ n: '1' }]);
  });

  it('lets two blocking reads on different streams wait at once', async () => {
    const { client, connectionName } = namedClient();
    const reads = [client.streams.read('first', { blockMs: 5_000 }), client.streams.read('second', { blockMs: 5_000 })];
    await readersBlocked(connectionName, 2);

    const { value, ms } = await timed((async (): Promise<StreamEntry[][]> => {
      await client.streams.add('second', { stream: 'second' });
      await client.streams.add('first', { stream: 'first' });
      return Promise.all(reads);
    })());
    expect(value.map(entries => entries.map(entry => entry.fields))).toEqual([[{ stream: 'first' }], [{ stream: 'second' }]]);
    expect(ms).toBeLessThan(1_000);
  });

  it('waits indefinitely with blockMs 0, until an entry arrives', async () => {
    const { client, connectionName } = namedClient();
    let settled = false;
    const read = client.streams.read('events', { blockMs: 0 }).finally(() => { settled = true; });
    await readersBlocked(connectionName, 1);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    await client.streams.add('events', { n: '1' });
    expect((await read).map(entry => entry.fields)).toEqual([{ n: '1' }]);
  });

  it('ends a read waiting indefinitely when the client is closed, and leaves no reader connection open', async () => {
    const { client, connectionName } = namedClient();
    // A reader that went back to the pool, and one still blocked when the client closes.
    const first = client.streams.read('events', { blockMs: 0 });
    await readersBlocked(connectionName, 1);
    await client.streams.add('events', { n: '1' });
    await first;
    const waiting = client.streams.read('events', { blockMs: 0 });
    waiting.catch(() => undefined);
    await readersBlocked(connectionName, 1);

    const { ms } = await timed(client.close().then(() => waiting.then(() => undefined, () => undefined)));
    expect(ms).toBeLessThan(1_000);
    await expect(waiting).rejects.toThrow();
    await eventually(async () => expect(await redis.connectionsNamed(connectionName)).toEqual([]));
  });

  it('returns a pending entry deleted since delivery with empty fields, so the consumer can still acknowledge it', async () => {
    const { client } = namedClient();
    await client.streams.createGroup('orders', 'workers');
    const id = await client.streams.add('orders', { a: '1' });
    await client.streams.read('orders', { group: 'workers', consumer: 'c', blockMs: 1 });
    await client.streams.delete('orders', id);

    expect(await client.streams.read('orders', { group: 'workers', consumer: 'c', id: '0', blockMs: 1 })).toEqual([{ id, fields: {} }]);
    expect(await client.streams.ack('orders', 'workers', id)).toBe(1);
    expect(await client.streams.read('orders', { group: 'workers', consumer: 'c', id: '0', blockMs: 1 })).toEqual([]);
  });

  it('refuses blocking reads once the Streams module is closed, leaving the shared connection free', async () => {
    const { client } = namedClient();
    await client.streams.close();
    await expect(client.streams.read('events', { blockMs: 5_000 })).rejects.toThrow();
    // The client itself is still open, and nothing is waiting on its shared connection.
    const started = performance.now();
    await client.cache.get('k');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
