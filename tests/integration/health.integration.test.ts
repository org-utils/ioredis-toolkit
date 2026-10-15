import type { Cluster } from 'ioredis';
import { expect, it } from 'vitest';
import { describeOnEachTopology } from '../support/redis.js';

describeOnEachTopology('client health check against real Redis', redis => {
  it('reports a connected client as healthy', async () => {
    const client = redis.connectClient();
    // Connected first, so the round trip measured is a PING's and not the connection's setup.
    await client.ping();
    const health = await client.health();
    expect(health).toMatchObject({ status: 'healthy', latencyMs: expect.any(Number) });
    expect(health).not.toHaveProperty('error');
  });

  it('reports a round trip slower than degradedMs as degraded', async () => {
    const client = redis.connectClient();
    await client.ping();
    // Every real round trip takes longer than 0 ms.
    expect(await client.health({ degradedMs: 0 })).toMatchObject({ status: 'degraded' });
  });

  it.skipIf(redis.topology !== 'standalone')('reports no nodes on standalone', async () => {
    expect(await redis.connectClient().health()).not.toHaveProperty('nodes');
  });

  it.skipIf(redis.topology !== 'cluster')('reports every master of a cluster, each by its address', async () => {
    // The masters as the server itself states them: each slot range's first node is the master that serves it.
    const slots = await (redis.observer as Cluster).cluster('SLOTS') as Array<[number, number, [string, number, ...unknown[]], ...unknown[]]>;
    const masters = [...new Set(slots.map(([, , [host, port]]) => `${host}:${port}`))].sort();
    const health = await redis.connectClient().health();
    expect(health.nodes?.map(node => node.address).sort()).toEqual(masters);
    for (const node of health.nodes ?? []) expect(node).toMatchObject({ status: expect.stringMatching(/^(healthy|degraded)$/), latencyMs: expect.any(Number) });
  });
});
