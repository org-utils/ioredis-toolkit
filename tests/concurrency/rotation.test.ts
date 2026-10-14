import { expect } from 'vitest';
import { createSessionManagerFromRedis, SessionReplayError } from '../../src/index.js';
import type { SessionManager } from '../../src/index.js';
import { keyManager } from '../support/key-manager.js';
import { describeOnEachTopology } from '../support/redis.js';

describeOnEachTopology('concurrent rotation', redis => {
  function sessionsIn(storage: 'plain' | 'encrypted'): SessionManager {
    const namespace = redis.newNamespace();
    return storage === 'encrypted'
      ? redis.connectClient({ sessions: { enabled: true, namespace, encryption: { enabled: true } } }, { encryptionKeyManager: keyManager() }).sessions
      : createSessionManagerFromRedis(redis.connectionConfig(), { enabled: true, namespace }).manager;
  }

  // On Cluster a losing rotation can read the record before the winner consumes it and its index entry after, and is refused as invalid.
  for (const storage of ['plain', 'encrypted'] as const) redis.itFailsOnClusterUntil('#60', /Session invalid .*to be an instance of SessionReplayError/, `lets exactly one of several simultaneous rotations of a credential succeed in ${storage} storage`, async () => {
    const manager = sessionsIn(storage);
    const created = await manager.create({ userId: 'integration-user' });

    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => manager.rotate(created.token)));
    const successors = outcomes.flatMap(outcome => (outcome.status === 'fulfilled' ? [outcome.value] : []));
    const refusals = outcomes.flatMap(outcome => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []));

    expect(successors).toHaveLength(1);
    for (const refusal of refusals) expect(refusal).toBeInstanceOf(SessionReplayError);
    expect((await manager.validate(successors[0]!.token)).valid).toBe(true);
    expect(await manager.validate(created.token)).toEqual({ valid: false, reason: 'consumed' });
  });
});
