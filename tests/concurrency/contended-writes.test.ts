import { describe, expect, it } from 'vitest';
import { SessionConflictError, SessionStorageError } from '../../src/index.js';
import type { SessionConfig, SessionManager } from '../../src/index.js';
import { keyManager } from '../support/key-manager.js';
import { connectClient, redisFixture, redisUrl } from '../support/redis.js';

describe.skipIf(!redisUrl)('contended session writes', () => {
  const redis = redisFixture();

  const encryptionKeyManager = keyManager();

  function sessionsIn(storage: 'plain' | 'encrypted', config: Partial<SessionConfig> = {}): SessionManager {
    const sessions = { enabled: true, namespace: redis.newNamespace(), ...config };
    return storage === 'encrypted'
      ? connectClient({ sessions: { ...sessions, encryption: { enabled: true } } }, { encryptionKeyManager }).sessions
      : connectClient({ sessions }).sessions;
  }

  it.each(['plain', 'encrypted'] as const)('lets exactly one of several simultaneous updates at one version succeed in %s storage', async storage => {
    const sessions = sessionsIn(storage);
    const created = await sessions.create({ userId: 'integration-user' });

    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, writer) => sessions.update(created.token, { metadata: { writer } }, created.session.version)));
    const written = outcomes.flatMap(outcome => (outcome.status === 'fulfilled' ? [outcome.value] : []));
    const refusals = outcomes.flatMap(outcome => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []));

    expect(written).toHaveLength(1);
    // A writer that read the record before the winner wrote is refused at the store; one that read it after, before that.
    for (const refusal of refusals) expect([SessionConflictError, SessionStorageError]).toContain((refusal as Error).constructor);
    expect(await sessions.get(created.token)).toEqual(written[0]);
  });

  it.each(['plain', 'encrypted'] as const)('revokes a session that other holders keep touching in %s storage', async storage => {
    const namespace = redis.newNamespace();
    const holders = Array.from({ length: 32 }, () => sessionsIn(storage, { namespace, touchInterval: 0, idleTimeout: 300 }));
    const sessions = holders[0]!;

    for (let round = 0; round < 15; round += 1) {
      const created = await sessions.create({ userId: 'integration-user' });
      let stopped = false;
      const touching = holders.map(async holder => { while (!stopped) await holder.touch(created.token).catch(() => undefined); });
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        await sessions.revoke(created.token);
        expect(await sessions.validate(created.token)).toEqual({ valid: false, reason: 'revoked' });
      } finally {
        stopped = true;
        await Promise.all(touching);
      }
    }
  });

  it.each(['plain', 'encrypted'] as const)('completes every one of many simultaneous touches in %s storage', async storage => {
    const sessions = sessionsIn(storage, { touchInterval: 0, idleTimeout: 300 });
    const created = await sessions.create({ userId: 'integration-user' });

    await Promise.all(Array.from({ length: 32 }, () => sessions.touch(created.token)));

    const touched = await sessions.get(created.token);
    expect(touched.version).toBeGreaterThan(created.session.version);
    expect(touched.idleExpiresAt).toBeGreaterThanOrEqual(created.session.idleExpiresAt!);
  });
});
