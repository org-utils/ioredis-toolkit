import { isCluster } from './cluster.js';
import type { RedisConnection } from './types.js';

/** Where a reported error came from: a source the reporting module names, and the logical channel where one applies. */
export interface ErrorContext<Source extends string = string> {
  /** The connection or component that produced the error. */
  source: Source;
  /** The logical channel, without the namespace, where the error concerns one. */
  channel?: string;
}

/** Receives errors the package cannot raise to a caller. It never throws. */
export type ErrorReporter<Source extends string = string> = (error: unknown, context: ErrorContext<Source>) => void;

/**
 * Wraps an application-supplied hook so that reporting can never fail: a hook that throws, or returns a promise
 * that rejects, is contained. Without a hook, errors are dropped.
 */
export function containedReporter<Source extends string>(hook?: (error: unknown, context: ErrorContext<Source>) => unknown): ErrorReporter<Source> {
  return (error, context) => {
    if (!hook) return;
    try {
      const result = hook(error, context);
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // A failing hook must not crash the process or the emitter that called it.
    }
  };
}

/**
 * Gives a connection an `'error'` listener that forwards to `report`, so an error no one else observes can never
 * crash the process. On Cluster, errors from the connection to each node are forwarded under the same source.
 */
export function reportConnectionErrors<Source extends string>(connection: RedisConnection, report: ErrorReporter<Source>, source: Source): void {
  connection.on('error', (error: Error) => report(error, { source }));
  if (isCluster(connection)) connection.on('node error', (error: Error) => report(error, { source }));
}

const closing = new WeakMap<RedisConnection, Promise<void>>();

/**
 * Closes a connection once, however often it is asked. A ready connection is quit, so commands already sent
 * complete; any other is disconnected, since a quit would wait for a connection that may never come up.
 */
export function closeConnection(connection: RedisConnection): Promise<void> {
  let closed = closing.get(connection);
  if (!closed) {
    closed = quitOrDisconnect(connection);
    closing.set(connection, closed);
  }
  return closed;
}

async function quitOrDisconnect(connection: RedisConnection): Promise<void> {
  if (connection.status === 'end') return;
  if (connection.status !== 'ready') { connection.disconnect(); return; }
  try { await connection.quit(); } catch { connection.disconnect(); }
}
