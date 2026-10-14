import { expect, it } from 'vitest';
import { SessionReplayError, SessionRotationError } from '../../src/index.js';
import type { SessionManager } from '../../src/index.js';
import { keyManager } from '../support/key-manager.js';
import { describeOnEachTopology } from '../support/redis.js';

describeOnEachTopology('concurrent rotation', redis => {
  function sessionsIn(storage: 'plain' | 'encrypted'): SessionManager {
    const namespace = redis.newNamespace();
    return storage === 'encrypted'
      ? redis.connectClient({ sessions: { enabled: true, namespace, encryption: { enabled: true } } }, { encryptionKeyManager: keyManager() }).sessions
      : redis.connectSessionManager({ enabled: true, namespace });
  }

  it.each(['plain', 'encrypted'] as const)('lets exactly one of several simultaneous rotations of a credential succeed in %s storage', async storage => {
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

  it.each(['plain', 'encrypted'] as const)('leaves no session of a rotation chain active when its consumed credential is revoked while its end rotates, in %s storage', async storage => {
    const namespace = redis.newNamespace();
    const connect = (): SessionManager => storage === 'encrypted'
      ? redis.connectClient({ sessions: { enabled: true, namespace, encryption: { enabled: true } } }, { encryptionKeyManager: keyManager() }).sessions
      : redis.connectSessionManager({ enabled: true, namespace });
    // Separate connections, so the revocation and the rotation interleave at Redis rather than queue on one socket.
    const [revoking, rotating] = [connect(), connect()];

    // Enough rounds that rotation consumes the session between the revocation's read and its write in some of them.
    for (let round = 0; round < 200; round += 1) {
      const first = await revoking.create({ userId: 'integration-user' });
      const second = await revoking.rotate(first.token);
      const [revocation, rotation] = await Promise.allSettled([revoking.revoke(first.token), rotating.rotate(second.token)]);

      expect(revocation.status).toBe('fulfilled');
      expect(await revoking.validate(first.token)).toEqual({ valid: false, reason: 'consumed' });
      if (rotation.status === 'fulfilled') {
        expect(await revoking.validate(second.token)).toEqual({ valid: false, reason: 'consumed' });
        expect(await revoking.validate(rotation.value.token)).toEqual({ valid: false, reason: 'revoked' });
      } else {
        const { reason } = await revoking.validate(second.token) as { reason: string };
        // Either the revocation got there first, or the rotation consumed its session and then found the revocation in its
        // successor's place; only the second leaves the session consumed, and only as a failed rotation.
        expect(['revoked', 'consumed']).toContain(reason);
        if (reason === 'consumed') expect(rotation.reason).toBeInstanceOf(SessionRotationError);
      }
    }
  }, 60_000);
});
