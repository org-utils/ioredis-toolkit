import { isCluster } from './cluster.js';
import { RedisConfigurationError } from './errors.js';
import type { RedisConnection } from './types.js';

/** How a health check is run. */
export interface RedisHealthOptions {
  /** How long a PING may wait for its reply, in milliseconds, before it counts as unhealthy. Defaults to 1000. */
  timeoutMs?: number;
  /** A round trip slower than this, in milliseconds, counts as degraded. Defaults to 100. */
  degradedMs?: number;
}

/** How usable Redis is: answering quickly, answering slowly, or not answering. */
export type RedisHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** The result of a health check. A Redis failure is reported here, never thrown. */
export interface RedisHealth {
  /** The worst status measured. */
  status: RedisHealthStatus;
  /** The slowest round trip measured, in milliseconds. */
  latencyMs: number;
  /** Why the check found Redis unhealthy. On Cluster, the first unhealthy master's address and reason. */
  error?: string;
  /** Cluster only: every master, each checked on its own. */
  nodes?: RedisNodeHealth[];
}

/** One Cluster master's part in a health check. */
export interface RedisNodeHealth {
  /** The master's `host:port`, as the cluster announces it. */
  address: string;
  /** How usable this master is. */
  status: RedisHealthStatus;
  /** This master's round trip, in milliseconds. */
  latencyMs: number;
  /** Why this master is unhealthy. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_DEGRADED_MS = 100;

/** When a health check gives up, and what counts as slow. */
interface Limits {
  /** The `performance.now()` by which every PING must have been answered. */
  deadline: number;
  /** The timeout the deadline was set from, as the caller gave it. */
  timeoutMs: number;
  /** A round trip slower than this counts as degraded. */
  degradedMs: number;
}

/**
 * Checks that Redis answers a PING on the given connection: on Cluster, that every master does, since a master that
 * cannot answer leaves its slots unserved. Every PING shares one deadline, `timeoutMs` from the start.
 * Throws {@link RedisConfigurationError} for options that are not usable numbers.
 */
export async function checkHealth(connection: RedisConnection, options: RedisHealthOptions = {}): Promise<RedisHealth> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, degradedMs = DEFAULT_DEGRADED_MS } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RedisConfigurationError(`Health-check timeoutMs must be a positive number, got ${timeoutMs}`);
  if (!Number.isFinite(degradedMs) || degradedMs < 0) throw new RedisConfigurationError(`Health-check degradedMs must be a number of at least 0, got ${degradedMs}`);
  const limits: Limits = { deadline: performance.now() + timeoutMs, timeoutMs, degradedMs };
  if (!isCluster(connection)) return probe(connection, limits);
  // A cluster that has not loaded its slot map yet knows no masters, so it is first pinged through the cluster itself.
  if (connection.nodes('master').length === 0) {
    const first = await probe(connection, limits);
    if (first.status === 'unhealthy') return { ...first, nodes: [] };
  }
  const nodes: RedisNodeHealth[] = await Promise.all(connection.nodes('master').map(async node => (
    { address: `${node.options.host}:${node.options.port}`, ...await probe(node, limits) }
  )));
  const unhealthy = nodes.find(node => node.status === 'unhealthy');
  return {
    status: unhealthy ? 'unhealthy' : nodes.some(node => node.status === 'degraded') ? 'degraded' : 'healthy',
    latencyMs: Math.max(0, ...nodes.map(node => node.latencyMs)),
    ...(unhealthy ? { error: `${unhealthy.address}: ${unhealthy.error}` } : {}),
    nodes,
  };
}

/**
 * Times one PING, giving up at the deadline rather than waiting out the client's retries. Local high-resolution
 * timing is correct here: latency is a duration inside this process, which ADR-0002 leaves to local clocks.
 */
async function probe(target: Pick<RedisConnection, 'ping'>, { deadline, timeoutMs, degradedMs }: Limits): Promise<RedisHealth> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ping = target.ping();
  // A PING still queued when the deadline passes settles later, with no one left to hear it.
  ping.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`No reply to PING within ${timeoutMs} ms`)), Math.max(0, deadline - started));
  });
  try {
    await Promise.race([ping, timeout]);
    const latencyMs = performance.now() - started;
    return { status: latencyMs > degradedMs ? 'degraded' : 'healthy', latencyMs };
  } catch (error) {
    return { status: 'unhealthy', latencyMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
