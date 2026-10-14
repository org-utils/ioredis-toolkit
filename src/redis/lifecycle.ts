import { isCluster } from './cluster.js';
import type { RedisConnection } from './types.js';

/** Where a reported error came from: the connection or component the reporting module names, and any detail that module adds. */
export type ErrorContext<Source extends string = string, Detail extends object = object> = { source: Source } & Detail;

/** Receives errors the package cannot raise to a caller. It never throws. */
export type ErrorReporter<Source extends string = string, Detail extends object = object> = (error: unknown, context: ErrorContext<Source, Detail>) => void;

/**
 * Wraps an application-supplied hook so that reporting can never fail: a hook that throws, or returns a promise
 * that rejects, is contained. Without a hook, errors are dropped.
 */
export function containedReporter<Source extends string, Detail extends object = object>(hook?: (error: unknown, context: ErrorContext<Source, Detail>) => unknown): ErrorReporter<Source, Detail> {
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
