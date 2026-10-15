import { afterEach, describe, expect, it } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import type { RedisClient } from '../../src/index.js';
import { closedPort } from '../support/closed-port.js';

describe('client health check without Redis', () => {
  const opened: RedisClient[] = [];
  afterEach(async () => { await Promise.all(opened.splice(0).map(client => client.close())); });

  /** A client pointed at a port nothing listens on, retrying as ioredis does by default, so a plain command waits out every retry. */
  async function unreachableClient(): Promise<RedisClient> {
    const client = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: await closedPort() });
    opened.push(client);
    return client;
  }

  it('reports an unreachable server as unhealthy within the timeout, without waiting out the retries', async () => {
    const client = await unreachableClient();
    const started = performance.now();
    const health = await client.health({ timeoutMs: 200 });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(health).toMatchObject({ status: 'unhealthy', error: expect.any(String) });
  });

  it('reports a cluster whose nodes cannot be reached as unhealthy within the timeout, with no masters to list', async () => {
    const client = createRedisClient({ mode: 'cluster', nodes: [{ host: '127.0.0.1', port: await closedPort() }] });
    opened.push(client);
    const started = performance.now();
    const health = await client.health({ timeoutMs: 200 });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(health).toMatchObject({ status: 'unhealthy', error: expect.any(String), nodes: [] });
  });

  it('reports a closed client as unhealthy', async () => {
    const client = await unreachableClient();
    await client.close();
    expect(await client.health()).toMatchObject({ status: 'unhealthy', error: 'Connection is closed.' });
  });
});
