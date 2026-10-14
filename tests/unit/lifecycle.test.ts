import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import type { RedisClient, RedisClientConfig, RedisErrorContext } from '../../src/index.js';
import { closedPort } from '../support/closed-port.js';

describe('client lifecycle and error hook', () => {
  // ioredis reports an 'error' event nobody listens for on console.error.
  let unhandled: MockInstance;
  const opened: RedisClient[] = [];
  beforeEach(() => { unhandled = vi.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(async () => {
    await Promise.all(opened.splice(0).map(client => client.close()));
    unhandled.mockRestore();
  });

  /** A client pointed at a port nothing listens on, which gives up after the first refused connect. */
  async function unreachableClient(config: Partial<RedisClientConfig> = {}, onError?: (error: unknown, context: RedisErrorContext) => void): Promise<RedisClient> {
    const client = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: await closedPort(), retryStrategy: () => null, ...config } as RedisClientConfig, onError ? { onError } : {});
    opened.push(client);
    return client;
  }

  it('delivers a connection error to the hook with source connection', async () => {
    const heard: Array<{ error: unknown; context: RedisErrorContext }> = [];
    const client = await unreachableClient({}, (error, context) => { heard.push({ error, context }); });
    await expect(client.ping()).rejects.toThrow();
    expect(heard).toContainEqual({ error: expect.objectContaining({ code: 'ECONNREFUSED' }), context: { source: 'connection' } });
  });

  it('delivers a subscriber-connection error to the hook with source subscriber', async () => {
    const heard: RedisErrorContext[] = [];
    const { pubsub } = await unreachableClient({ lazyConnect: true, pubsub: { enabled: true } }, (_error, context) => { heard.push(context); });
    await expect(pubsub.subscribe('orders', () => undefined)).rejects.toThrow();
    expect(heard).toEqual([{ source: 'subscriber' }]);
  });

  it('keeps a connection error from crashing the process or reaching console.error when no hook is supplied', async () => {
    const client = await unreachableClient();
    await expect(client.ping()).rejects.toThrow();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('contains a hook that throws', async () => {
    let calls = 0;
    const client = await unreachableClient({}, () => { calls += 1; throw new Error('hook failed'); });
    await expect(client.ping()).rejects.toThrow();
    expect(calls).toBeGreaterThan(0);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('contains a hook that returns a rejected promise', async () => {
    let calls = 0;
    const client = await unreachableClient({}, async () => { calls += 1; throw new Error('hook failed'); });
    await expect(client.ping()).rejects.toThrow();
    expect(calls).toBeGreaterThan(0);
  });

  it('closes a client whose modules were never touched, and closes it again', async () => {
    const client = await unreachableClient({ lazyConnect: true, pubsub: { enabled: true }, streams: { enabled: true } });
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('closes a client whose connections never came up, including its subscriber', async () => {
    const client = await unreachableClient({ pubsub: { enabled: true } });
    await expect(client.pubsub.subscribe('orders', () => undefined)).rejects.toThrow();
    await expect(Promise.all([client.close(), client.close()])).resolves.toEqual([undefined, undefined]);
  });
});
