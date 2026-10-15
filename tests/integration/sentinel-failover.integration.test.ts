import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import type { SentinelRedisConfig } from '../../src/index.js';

/**
 * The sentinels from REDIS_SENTINELS (`host:port,host:port,…`) and the master they watch, REDIS_SENTINEL_NAME
 * (`mymaster` when unset), or undefined when the environment names no Sentinel deployment. The suite fails the
 * master over, so it runs only against a deployment it may do that to, such as `docker/sentinel.compose.yml`.
 */
const sentinelConfig: SentinelRedisConfig | undefined = process.env.REDIS_SENTINELS
  ? {
    mode: 'sentinel',
    name: process.env.REDIS_SENTINEL_NAME ?? 'mymaster',
    sentinels: process.env.REDIS_SENTINELS.split(',').map(node => node.trim()).filter(Boolean).map(node => {
      const colon = node.lastIndexOf(':');
      return { host: node.slice(0, colon), port: Number(node.slice(colon + 1)) };
    }),
  }
  : undefined;

/** A failover, the wait for the replica to resync before it, and the wait for the old master's demotion after it. */
const FAILOVER_TEST_TIMEOUT_MS = 120_000;

/** A field of one entry of a `SENTINEL REPLICAS` reply, which lists each replica as alternating names and values. */
function field(entry: string[], name: string): string | undefined {
  const index = entry.indexOf(name);
  return index === -1 ? undefined : entry[index + 1];
}

async function masterOf(sentinel: Redis, name: string): Promise<{ host: string; port: number }> {
  const [host, port] = await sentinel.call('SENTINEL', 'GET-MASTER-ADDR-BY-NAME', name) as [string, string];
  return { host, port: Number(port) };
}

/**
 * Resolves once a failover can succeed: every sentinel agrees on the master and sees each replica up and in sync.
 * After a failover that takes about 20 s, while the old master resyncs as a replica.
 */
async function untilFailoverReady(sentinels: Redis[], name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const views = await Promise.all(sentinels.map(async sentinel => ({
      master: JSON.stringify(await masterOf(sentinel, name)),
      replicas: await sentinel.call('SENTINEL', 'REPLICAS', name) as string[][],
    })));
    const ready = new Set(views.map(view => view.master)).size === 1
      && views.every(view => view.replicas.length > 0 && view.replicas.every(entry => field(entry, 'flags') === 'slave' && field(entry, 'master-link-status') === 'ok'));
    if (ready) return;
    if (Date.now() > deadline) throw new Error(`The Sentinel deployment did not become failover-ready within 60 s: ${JSON.stringify(views)}`);
    await delay(250);
  }
}

/** What one workload across a failover saw: each write the client acknowledged, and when Sentinel announced what. */
interface FailoverRun {
  acknowledged: Array<{ key: string; at: number }>;
  failed: number;
  announced: Array<{ channel: string; at: number }>;
  /** Every acknowledged write the new master does not hold once the old master has been demoted. */
  lost: Array<{ key: string; at: number }>;
}

/**
 * Writes through the client's cache in a loop, triggers a graceful `SENTINEL FAILOVER` a moment in, keeps writing until
 * Sentinel has demoted the old master and a second more, then asks the new master which acknowledged writes it holds.
 */
async function writeAcrossGracefulFailover(config: SentinelRedisConfig): Promise<FailoverRun> {
  // Redis 8 sentinels refuse QUIT, so sentinel connections are closed with disconnect().
  const sentinels = config.sentinels.map(({ host, port }) => new Redis({ host, port }));
  // Every sentinel announces +switch-master, but only the one that demotes the old master announces +convert-to-slave.
  const listeners = config.sentinels.map(({ host, port }) => new Redis({ host, port }));
  const namespace = `test-${randomUUID()}`;
  const client = createRedisClient({ ...config, cache: { enabled: true, namespace } });
  let newMaster: Redis | undefined;
  try {
    await untilFailoverReady(sentinels, config.name);
    const oldMaster = await masterOf(sentinels[0]!, config.name);

    const announced: FailoverRun['announced'] = [];
    await Promise.all(listeners.map(listener => listener.subscribe('+switch-master', '+convert-to-slave')));
    const demoted = new Promise<void>(resolve => {
      for (const listener of listeners) {
        listener.on('message', (channel: string, message: string) => {
          announced.push({ channel, at: Date.now() });
          if (channel === '+convert-to-slave' && message.includes(`${oldMaster.host} ${oldMaster.port} @`)) resolve();
        });
      }
    });

    const acknowledged: FailoverRun['acknowledged'] = [];
    let failed = 0;
    let writing = true;
    await client.ping();
    const workload = (async () => {
      for (let n = 0; writing; n += 1) {
        const key = `write-${n}`;
        try {
          await client.cache.set(key, n, { ttl: 300 });
          acknowledged.push({ key, at: Date.now() });
        } catch {
          failed += 1;
        }
        await delay(10);
      }
    })();

    await delay(300);
    await sentinels[0]!.call('SENTINEL', 'FAILOVER', config.name);
    await Promise.race([demoted, delay(30_000).then(() => { throw new Error('Sentinel did not demote the old master within 30 s'); })]);
    await delay(1_000);
    writing = false;
    await workload;

    const promoted = await masterOf(sentinels[0]!, config.name);
    newMaster = new Redis(promoted);
    const exists = await newMaster.pipeline(acknowledged.map(({ key }) => ['exists', client.cache.key(key)])).exec();
    const lost = acknowledged.filter((_write, index) => exists?.[index]?.[1] !== 1);
    return { acknowledged, failed, announced, lost };
  } finally {
    if (newMaster) {
      const keys = await newMaster.keys(`${namespace}:*`);
      if (keys.length) await newMaster.del(...keys);
      newMaster.disconnect();
    }
    await client.close();
    for (const sentinel of [...sentinels, ...listeners]) sentinel.disconnect();
  }
}

/**
 * How many connections to each sentinel are subscribed to a channel. Each client connection with the failover detector
 * holds one, subscribed to +switch-master, on up to `sentinelMaxConnections` sentinels. A sentinel has no PUBSUB command,
 * so its CLIENT LIST is read.
 */
async function subscribedOn(sentinels: Redis[]): Promise<number[]> {
  return Promise.all(sentinels.map(async sentinel => (await sentinel.call('CLIENT', 'LIST') as string).split('\n').filter(line => / sub=[1-9]/.test(line)).length));
}

/** Resolves once every sentinel's subscribed count passes `test`, or throws with the last counts after 5 s. */
async function untilSubscribed(sentinels: Redis[], test: (count: number, index: number) => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const counts = await subscribedOn(sentinels);
    if (counts.every(test)) return;
    if (Date.now() > deadline) throw new Error(`${failure} within 5 s: subscribed connections per sentinel are ${JSON.stringify(counts)}`);
    await delay(100);
  }
}

/** A run as one line: how many writes were acknowledged and lost, and when the lost ones were acknowledged. */
function describeRun({ acknowledged, failed, announced, lost }: FailoverRun): string {
  const switched = announced.find(({ channel }) => channel === '+switch-master')?.at;
  const since = (at: number) => (switched === undefined ? `${at}` : `${at - switched} ms`);
  const span = lost.length ? `, acknowledged from ${since(lost[0]!.at)} to ${since(lost.at(-1)!.at)} after +switch-master` : '';
  const demoted = announced.find(({ channel }) => channel === '+convert-to-slave')?.at;
  return `${acknowledged.length} writes acknowledged, ${failed} failed, ${lost.length} lost${span}; old master demoted ${demoted === undefined ? 'never' : since(demoted)} after +switch-master`;
}

/**
 * How long after this suite hears +switch-master a write the old master acknowledges may still be lost: the client
 * hears the announcement on connections of its own, a few milliseconds earlier or later.
 */
const ANNOUNCEMENT_SKEW_MS = 100;

describe.skipIf(!sentinelConfig)('Sentinel failover against real Redis', () => {
  // ioredis's quit() leaves the failover detector's sentinel connections open, so a process waiting on them never exits (#125).
  it('leaves no connection to a sentinel open once closed, from the shared connection or a Pub/Sub subscriber', async () => {
    const config = sentinelConfig!;
    const sentinels = config.sentinels.map(({ host, port }) => new Redis({ host, port }));
    const client = createRedisClient({ ...config, pubsub: { enabled: true, namespace: `test-${randomUUID()}` } });
    try {
      const before = await subscribedOn(sentinels);
      await client.ping();
      await client.pubsub.subscribe('channel', () => undefined);
      await untilSubscribed(sentinels, (count, index) => count >= before[index]! + 2, 'The two connections\' failover detectors did not subscribe');
      await client.close();
      await untilSubscribed(sentinels, (count, index) => count <= before[index]!, 'close() did not close the failover detectors\' connections');
    } finally {
      await client.close();
      for (const sentinel of sentinels) sentinel.disconnect();
    }
  });

  // Not "loses no acknowledged write": Sentinel announces +switch-master about a second after it promotes the replica, and
  // the old master acknowledges writes meanwhile that no client can know are lost. What a client can do is leave the old
  // master once the switch is announced, rather than when Sentinel demotes it about 10 s later (#121).
  it('loses no write acknowledged after Sentinel announces the new master', async () => {
    const run = await writeAcrossGracefulFailover(sentinelConfig!);
    const switched = run.announced.find(({ channel }) => channel === '+switch-master')?.at;
    expect(switched, describeRun(run)).toBeDefined();
    expect(run.acknowledged.filter(({ at }) => at > switched!).length, describeRun(run)).toBeGreaterThan(0);
    expect(run.lost.filter(({ at }) => at > switched! + ANNOUNCEMENT_SKEW_MS).map(({ key }) => key), describeRun(run)).toEqual([]);
  }, FAILOVER_TEST_TIMEOUT_MS);
});
