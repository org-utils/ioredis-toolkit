import { randomUUID } from 'node:crypto';
import { Cluster, Redis } from 'ioredis';
import { afterAll, beforeAll, describe, inject, it } from 'vitest';
import { createRedisClient, createSessionManagerFromRedis } from '../../src/index.js';
import type { RedisClient, RedisClientConfig, RedisClientDependencies, RedisConfig, SessionConfig, SessionManager } from '../../src/index.js';

declare module 'vitest' {
  interface ProvidedContext {
    /** Whether the running suite may call `flushScriptCache()`. Unprovided means it may not. */
    scriptCacheMayBeFlushed: boolean;
  }
}

/** A Redis deployment shape every real-server suite runs against. */
export type Topology = 'standalone' | 'cluster';

/**
 * The connection config the factories take for each topology the environment names, or undefined
 * for one it does not: standalone from REDIS_URL, Cluster from REDIS_CLUSTER_NODES (`host:port,host:port,…`).
 * Real-server suites run only against a Redis they may write to.
 */
const configByTopology: Record<Topology, RedisConfig | undefined> = {
  standalone: process.env.REDIS_URL ? standaloneConfig(process.env.REDIS_URL) : undefined,
  cluster: process.env.REDIS_CLUSTER_NODES ? clusterConfig(process.env.REDIS_CLUSTER_NODES) : undefined,
};

/** REDIS_URL as the connection config the factories take; they do not accept a URL. */
function standaloneConfig(redisUrl: string): RedisConfig {
  const url = new URL(redisUrl);
  return {
    mode: 'standalone',
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.pathname.length > 1 ? { db: Number(url.pathname.slice(1)) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

function clusterConfig(nodes: string): RedisConfig {
  return {
    mode: 'cluster',
    nodes: nodes.split(',').map(node => node.trim()).filter(Boolean).map(node => {
      const colon = node.lastIndexOf(':');
      return { host: node.slice(0, colon), port: Number(node.slice(colon + 1)) };
    }),
  };
}

/** How many times a test known to fail on Cluster runs there before its passing is believed, and how long they may all take. */
const CLUSTER_ATTEMPTS = 32;
const CLUSTER_ATTEMPTS_TIMEOUT_MS = 60_000;

/** An error's message followed by the messages of its causes, so a package error can be matched by what Redis said. */
function messagesOf(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) messages.push(`${current.name}: ${current.message}`);
  return messages.length ? messages.join('\n') : String(error);
}

type ModuleSections = Pick<RedisClientConfig, 'cache' | 'lock' | 'rateLimit' | 'pubsub' | 'streams' | 'sessions'>;

/** A raw connection to either topology. */
type Observer = Redis | Cluster;

async function openObserver(config: RedisConfig): Promise<Observer> {
  if (config.mode !== 'cluster') {
    const { mode: _mode, ...options } = config;
    void _mode;
    return new Redis(options);
  }
  const cluster = new Cluster(config.nodes);
  // Until the slot map arrives a cluster knows no masters to fan out to.
  await new Promise((resolve, reject) => { cluster.once('ready', resolve); cluster.once('error', reject); });
  return cluster;
}

/** Every server: each node of a cluster, replicas included, or the one standalone server. */
function nodesOf(observer: Observer): Redis[] {
  return observer instanceof Cluster ? observer.nodes('all') : [observer];
}

/** The servers that hold keys: every master of a cluster, or the one standalone server. */
function mastersOf(observer: Observer): Redis[] {
  return observer instanceof Cluster ? observer.nodes('master') : [observer];
}

async function keysUnder(observer: Observer, namespace: string): Promise<string[]> {
  const keys: string[] = [];
  for (const master of mastersOf(observer)) {
    let cursor = '0';
    do {
      const [next, batch] = await master.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
  }
  return keys.sort();
}

async function storedUnder(observer: Observer, namespace: string): Promise<string> {
  const stored: string[] = [];
  for (const key of await keysUnder(observer, namespace)) {
    const type = await observer.type(key);
    stored.push(key);
    if (type === 'string') stored.push((await observer.get(key)) ?? '');
    else if (type === 'zset') stored.push(...await observer.zrange(key, 0, -1, 'WITHSCORES'));
    else throw new Error(`storedUnder cannot read the ${type} at ${key}`);
  }
  return stored.join('\n');
}

/** One command a server's MONITOR saw, with the client that sent it. */
interface MonitoredCommand { time: number; client: string; args: string[] }

/**
 * Starts one server's MONITOR and resolves once it is in place, to a function that stops it and returns
 * what every other client sent that server meanwhile, scripts' own commands aside.
 */
async function recordOn(master: Redis): Promise<() => Promise<MonitoredCommand[]>> {
  // Not `master.monitor()`: that rejects when other clients' traffic arrives together with MONITOR's own reply,
  // which ioredis reports as a queue-state error. Such traffic is from before the recording, so that one error is dropped;
  // any other (a refused MONITOR, a lost connection) fails the caller. A cluster's own node connections are lazy.
  const monitor = master.duplicate({ monitor: true, lazyConnect: false });
  const failed = new Promise<never>((_resolve, reject) => {
    monitor.on('error', (error: Error) => { if (!error.message.startsWith('Command queue state error')) reject(error); });
  });
  failed.catch(() => undefined);
  try {
    await Promise.race([new Promise<void>(resolve => { monitor.once('monitoring', () => resolve()); }), failed]);
  } catch (error) {
    monitor.disconnect();
    throw error;
  }
  const sent: MonitoredCommand[] = [];
  const marker = `end-${randomUUID()}`;
  const ended = new Promise<void>(resolve => {
    monitor.on('monitor', (time: string, args: string[], source: string) => {
      if (args.includes(marker)) resolve();
      // A source is a client address as this server sees it, so it names a client only together with the server.
      else if (source !== 'lua') sent.push({ time: Number(time), client: `${master.options.host}:${master.options.port} ${source}`, args });
    });
  });
  return async () => {
    try {
      await master.echo(marker);
      await Promise.race([ended, failed]);
      return sent;
    } finally {
      monitor.disconnect();
    }
  };
}

async function commandsFromClientsOf(observer: Observer, namespace: string, work: () => Promise<unknown>): Promise<string[][]> {
  const recordings = await Promise.allSettled(mastersOf(observer).map(recordOn));
  const stops = recordings.flatMap(recording => (recording.status === 'fulfilled' ? [recording.value] : []));
  const refused = recordings.find(recording => recording.status === 'rejected');
  let sent: MonitoredCommand[];
  try {
    if (refused) throw refused.reason;
    await work();
  } finally {
    sent = (await Promise.all(stops.map(stop => stop()))).flat();
  }
  sent.sort((a, b) => a.time - b.time);
  const clients = new Set(sent.filter(({ args }) => args.some(arg => arg.startsWith(`${namespace}:`))).map(({ client }) => client));
  return sent.filter(({ client }) => clients.has(client)).map(({ args }) => args);
}

/** Retries an assertion until it holds, for state that settles on another connection. */
export async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try { await assertion(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** What a real-server suite uses to reach the package on one topology, and to look at, or plant, what is in Redis. */
export interface RedisFixture {
  /** The topology this run of the suite is against. */
  readonly topology: Topology;
  /** A raw connection, separate from any the package opens. On Cluster it routes each command by its key. */
  readonly observer: Observer;
  /** The topology's connection config, as the factories take it. */
  connectionConfig(): RedisConfig;
  /** The topology's connection config, with every connection the package opens from it named `connectionName`. */
  namedConnectionConfig(connectionName: string): RedisConfig;
  /** The connections any server holds open under a client name, one `CLIENT LIST` line each. */
  connectionsNamed(connectionName: string): Promise<string[]>;
  /** The client facade on this topology, closed once the suite is done. */
  connectClient(modules?: ModuleSections, dependencies?: RedisClientDependencies): RedisClient;
  /** The session manager `createSessionManagerFromRedis` builds on this topology. Its connection is closed once the suite is done. */
  connectSessionManager(sessionConfig: Partial<SessionConfig>): SessionManager;
  /**
   * `it` on standalone. On Cluster the test is known to fail until `ticket` is fixed, with an error whose message, or a cause's,
   * matches `failure`. Such a bug may show only when keys land on different masters, or when a race goes one way, so there
   * the body runs up to {@link CLUSTER_ATTEMPTS} times and the test passes at the first matching failure. Any other error
   * fails the test. So does every attempt passing, which is the prompt to remove the mark.
   */
  itFailsOnClusterUntil(ticket: `#${number}`, failure: RegExp, name: string, test: () => Promise<void>): void;
  /** Mints a namespace no other test or run shares. */
  newNamespace(): string;
  /** Every key under a namespace, from every server that holds keys. */
  keysUnder(namespace: string): Promise<string[]>;
  /** How many connections are subscribed to a channel, on every server: a cluster's PUBLISH counts only its own node's. */
  subscribersTo(channel: string): Promise<number>;
  /** Every key name and value under a namespace as one searchable text. */
  storedUnder(namespace: string): Promise<string>;
  /**
   * Runs `work` and returns, as argument lists, everything sent meanwhile by each connection that named a key under a namespace,
   * in the order the servers received them (by server clock, across a cluster's masters). Commands a script runs are not included.
   */
  commandsFromClientsOf(namespace: string, work: () => Promise<unknown>): Promise<string[][]>;
  /**
   * Empties the script cache of every server, as a restart or failover would: the one server-wide effect a suite may have.
   * No stored data is touched, and a client that runs Lua by SHA sends the source again when the server asks for it.
   * That extra EVAL breaks other suites' command counts, so it throws unless the suite is in `SCRIPT_CACHE_FLUSHING_SUITES`
   * in `vitest.integration.config.ts`.
   */
  flushScriptCache(): Promise<void>;
}

/**
 * Sets up a suite's {@link RedisFixture} on one topology. Afterwards it closes every connection it opened and deletes
 * the namespaces it minted. Stored data on a shared server is never flushed.
 */
function redisFixture(topology: Topology, config: RedisConfig): RedisFixture {
  let observer: Observer;
  const namespaces: string[] = [];
  const opened: Array<{ close(): Promise<void> }> = [];
  beforeAll(async () => { observer = await openObserver(config); });
  afterAll(async () => {
    await Promise.all(opened.splice(0).map(closable => closable.close()));
    // A topology that never became ready has nothing to clean up, and its error is already the suite's.
    if (!observer) return;
    // One key at a time: a cluster refuses a multi-key DEL across slots.
    for (const namespace of namespaces) await Promise.all((await keysUnder(observer, namespace)).map(key => observer.del(key)));
    await observer.quit();
  });
  return {
    topology,
    get observer() { return observer; },
    connectionConfig: () => config,
    namedConnectionConfig: connectionName => (config.mode === 'cluster' ? { ...config, redisOptions: { ...config.redisOptions, connectionName } } : { ...config, connectionName }),
    connectionsNamed: async connectionName => {
      const lists = await Promise.all(nodesOf(observer).map(async node => await node.client('LIST') as string));
      return lists.flatMap(list => list.split('\n')).filter(line => line.includes(` name=${connectionName} `));
    },
    connectClient(modules = {}, dependencies = {}) {
      const client = createRedisClient({ ...config, ...modules }, dependencies);
      opened.push(client);
      return client;
    },
    connectSessionManager(sessionConfig) {
      const { manager, redis } = createSessionManagerFromRedis(config, sessionConfig);
      opened.push(redis);
      return manager;
    },
    itFailsOnClusterUntil(ticket, failure, name, test) {
      if (topology !== 'cluster') { it(name, test); return; }
      it(`${name} (expected to fail on Cluster until ${ticket})`, async () => {
        for (let attempt = 0; attempt < CLUSTER_ATTEMPTS; attempt += 1) {
          try { await test(); }
          catch (error) { if (failure.test(messagesOf(error))) return; throw error; }
        }
        throw new Error(`Passed ${CLUSTER_ATTEMPTS} times on Cluster: if ${ticket} is fixed, remove its expected-failure mark.`);
      }, CLUSTER_ATTEMPTS_TIMEOUT_MS);
    },
    newNamespace() { const namespace = `test-${randomUUID()}`; namespaces.push(namespace); return namespace; },
    keysUnder: namespace => keysUnder(observer, namespace),
    subscribersTo: async channel => {
      let subscribers = 0;
      for (const node of nodesOf(observer)) subscribers += Number(((await node.pubsub('NUMSUB', channel)) as [string, number])[1]);
      return subscribers;
    },
    storedUnder: namespace => storedUnder(observer, namespace),
    commandsFromClientsOf: (namespace, work) => commandsFromClientsOf(observer, namespace, work),
    flushScriptCache: async () => {
      if (!inject('scriptCacheMayBeFlushed')) throw new Error('Only a suite in SCRIPT_CACHE_FLUSHING_SUITES (vitest.integration.config.ts) may flush the script cache.');
      await Promise.all(nodesOf(observer).map(node => node.script('FLUSH')));
    },
  };
}

/**
 * Declares a real-server suite once per topology, each run titled with the topology it is against.
 * A topology the environment does not configure is skipped.
 */
export function describeOnEachTopology(name: string, suite: (redis: RedisFixture) => void): void {
  for (const topology of ['standalone', 'cluster'] as const) {
    const config = configByTopology[topology];
    describe.skipIf(!config)(`${name} [${topology}]`, () => { if (config) suite(redisFixture(topology, config)); });
  }
}
