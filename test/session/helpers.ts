import { RedisClientWrapper } from '../../src/client.js';
import type { SessionKeyProvider } from '../../src/session/session-encryption.js';
import { RedisRevocationStore } from '../../src/session/revocation-store.js';
import { createSessionManager } from '../../src/session/session-manager.js';
import type { SessionManager } from '../../src/session/session-manager.js';
import type { SessionValidationResult } from '../../src/session/session-types.js';
import { asWrapper, fakeClient } from '../helpers/fake-redis.js';

/**
 * Creates an isolated ioredis-mock-backed client for a suite. Returns the
 * client (never null); suites run without a real Redis and need no teardown
 * (the mock holds no external resources).
 */
export async function connectSuite(namespacePrefix: string): Promise<RedisClientWrapper> {
  const client = asWrapper(fakeClient());

  await client.deletePattern(`${namespacePrefix}:*`);

  return client;
}

/** Creates a manager on a fresh namespace under the suite's prefix. */
export function freshManager(
  client: RedisClientWrapper,
  suitePrefix: string,
  overrides: Record<string, unknown> = {},
  options: { revocationStore?: boolean; keyProvider?: SessionKeyProvider } = {},
): SessionManager {
  const ns = `${suitePrefix}-${Math.random().toString(36).slice(2, 10)}`;

  const revocationStore = options.revocationStore
    ? new RedisRevocationStore({ client, keyPrefix: `${ns}:revoked:` })
    : undefined;

  return createSessionManager({
    client,
    config: { enabled: true, namespace: ns, ...overrides },
    ...(revocationStore !== undefined ? { revocationStore } : {}),
    ...(options.keyProvider !== undefined ? { encryptionKeyProvider: options.keyProvider } : {}),
  });
}

/** Asserts the suite can run (always true with ioredis-mock). */
export function suiteGuard(client: RedisClientWrapper | null): client is RedisClientWrapper {
  return client !== null;
}

/**
 * ioredis-mock executes Lua through an embedded interpreter, so operations
 * take milliseconds instead of microseconds. A few tests assert right at
 * 1-second expiry boundaries and can straddle a wall-clock second when the
 * machine is loaded; transient failures get a couple of extra attempts.
 */
export async function timingTolerant<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

/** Narrows a validation result: the invalid reason, or null when valid. */
export function invalidReason(result: SessionValidationResult): string | null {
  return result.valid ? null : result.reason;
}
