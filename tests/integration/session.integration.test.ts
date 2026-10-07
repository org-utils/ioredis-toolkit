import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSessionManagerFromRedis, SessionSerializationError } from '../../src/index.js';
import type { KeyManager, SessionConfig, SessionManager } from '../../src/index.js';
import { hashSlot } from '../support/hash-slot.js';
import { connectClient, connectionConfig, keysUnder, redisFixture, redisUrl, storedUnder } from '../support/redis.js';

function keyManager(): KeyManager {
  const key = randomBytes(32);
  return { current: () => ({ version: '1', key }), get: version => (version === '1' ? key : undefined) };
}

/** The secret half of an opaque credential; the other half is the JTI, which is stored by design. */
function secretOf(token: string): string { return token.slice(token.indexOf('.') + 1); }

describe.skipIf(!redisUrl)('sessions against real Redis', () => {
  const redis = redisFixture();

  function sessionsIn(namespace: string, config: Partial<SessionConfig> = {}, encryptionKeyManager?: KeyManager): SessionManager {
    return connectClient({ sessions: { enabled: true, namespace, ...config } }, encryptionKeyManager ? { encryptionKeyManager } : {}).sessions;
  }

  /** The one key under a namespace holding a session envelope. */
  async function envelopeKey(namespace: string): Promise<string> {
    const holding: string[] = [];
    for (const key of await keysUnder(redis.observer, namespace)) {
      if ((await redis.observer.type(key)) === 'string' && (await redis.observer.get(key))?.startsWith('{')) holding.push(key);
    }
    expect(holding).toHaveLength(1);
    return holding[0]!;
  }

  it('creates, validates, touches, rotates, revokes and destroys a session', async () => {
    const { manager } = createSessionManagerFromRedis(connectionConfig(), { enabled: true, namespace: redis.namespace(), rolling: true, touchInterval: 0, ttl: 600, idleTimeout: 300, absoluteTimeout: 600 });
    const created = await manager.create({ userId: 'integration-user' });
    expect(await manager.validate(created.token)).toEqual({ valid: true, session: created.session });

    await manager.touch(created.token);
    expect((await manager.get(created.token)).version).toBe(created.session.version + 1);

    const rotated = await manager.rotate(created.token);
    expect(rotated.previousJti).toBe(created.session.jti);
    expect(await manager.validate(created.token)).toEqual({ valid: false, reason: 'consumed' });
    expect((await manager.validate(rotated.token)).valid).toBe(true);

    await manager.revoke(rotated.token);
    expect(await manager.validate(rotated.token)).toEqual({ valid: false, reason: 'revoked' });

    await manager.destroy(rotated.token);
    expect(await manager.validate(rotated.token)).toEqual({ valid: false, reason: 'not_found' });
  });

  it('issues a distinct credential with at least 256 bits of secret for each session', async () => {
    const sessions = sessionsIn(redis.namespace());
    const first = await sessions.create({ userId: 'integration-user' });
    const second = await sessions.create({ userId: 'integration-user' });
    expect(first.token).not.toBe(second.token);
    expect(first.session.id).not.toBe(second.session.id);
    expect(secretOf(first.token).length).toBeGreaterThanOrEqual(43);
  });

  it.each(['plain', 'encrypted'] as const)('never persists the raw credential in %s storage', async storage => {
    const namespace = redis.namespace();
    const sessions = storage === 'encrypted' ? sessionsIn(namespace, { encryption: { enabled: true } }, keyManager()) : sessionsIn(namespace);
    const created = await sessions.create({ userId: 'integration-user' });

    const stored = await storedUnder(redis.observer, namespace);
    // The session id is derived from the credential, so finding it proves this is where the sessions live.
    expect(stored).toContain(created.session.id);
    expect(stored).not.toContain(created.token);
    expect(stored).not.toContain(secretOf(created.token));
  });

  it('never persists the raw credential of a rotated session or of its successor', async () => {
    const namespace = redis.namespace();
    const sessions = sessionsIn(namespace);
    const created = await sessions.create({ userId: 'integration-user' });
    const rotated = await sessions.rotate(created.token);

    const stored = await storedUnder(redis.observer, namespace);
    expect(stored).toContain(rotated.session.id);
    for (const token of [created.token, rotated.token]) {
      expect(stored).not.toContain(token);
      expect(stored).not.toContain(secretOf(token));
    }
  });

  it('scopes a session to its namespace', async () => {
    const namespace = redis.namespace();
    const elsewhere = redis.namespace();
    const created = await sessionsIn(namespace).create({ userId: 'integration-user' });
    expect(await sessionsIn(elsewhere).validate(created.token)).toEqual({ valid: false, reason: 'not_found' });
    expect(await keysUnder(redis.observer, namespace)).not.toHaveLength(0);
    expect(await keysUnder(redis.observer, elsewhere)).toHaveLength(0);
  });

  it("keeps one user's keys in a single hash slot, apart from another user's", async () => {
    const namespace = redis.namespace();
    const sessions = sessionsIn(namespace);
    await sessions.create({ userId: 'user:{evil}' });
    await sessions.create({ userId: 'user:{evil}' });
    await sessions.setSecurityVersion('user:{evil}', 1);
    await sessions.create({ userId: 'someone-else' });

    // Keys found by credential alone carry no hash tag and are free to land in any slot.
    const tagged = (await keysUnder(redis.observer, namespace)).filter(key => /\{.+\}/.test(key));
    const slots = new Map<number, string[]>();
    for (const key of tagged) slots.set(hashSlot(key), [...(slots.get(hashSlot(key)) ?? []), key]);
    // Two records, the index over them and the security version; then the other user's record and index.
    expect([...slots.values()].map(keys => keys.length).sort()).toEqual([2, 4]);
    // A user id cannot choose its own hash tag.
    expect(tagged.join('\n')).not.toContain('evil');
  });

  describe('stored envelope', () => {
    it('reads back a version 1 envelope written by an earlier release', async () => {
      const namespace = redis.namespace();
      const sessions = sessionsIn(namespace);
      const created = await sessions.create({ userId: 'integration-user' });
      const record = { ...created.session, metadata: { writtenBy: 'an earlier release' } };
      await redis.observer.set(await envelopeKey(namespace), JSON.stringify({ v: 1, data: JSON.stringify(record) }), 'KEEPTTL');
      expect(await sessions.get(created.token)).toEqual(record);
    });

    it('rejects an envelope version it does not know', async () => {
      const namespace = redis.namespace();
      const sessions = sessionsIn(namespace);
      const created = await sessions.create({ userId: 'integration-user' });
      await redis.observer.set(await envelopeKey(namespace), JSON.stringify({ v: 2, data: JSON.stringify(created.session) }), 'KEEPTTL');
      await expect(sessions.validate(created.token)).rejects.toThrow(SessionSerializationError);
    });

    it('round-trips an encrypted record and keeps it unreadable in Redis', async () => {
      const namespace = redis.namespace();
      const sessions = sessionsIn(namespace, { encryption: { enabled: true } }, keyManager());
      const created = await sessions.create({ userId: 'integration-user', metadata: { plan: 'pro' } });
      expect(await sessions.get(created.token)).toEqual(created.session);
      expect(await redis.observer.get(await envelopeKey(namespace))).not.toContain('integration-user');
    });

    it('rejects an encrypted record that was tampered with', async () => {
      const namespace = redis.namespace();
      const sessions = sessionsIn(namespace, { encryption: { enabled: true } }, keyManager());
      const created = await sessions.create({ userId: 'integration-user' });
      const key = await envelopeKey(namespace);
      const envelope = JSON.parse((await redis.observer.get(key))!) as { data: string };
      const tampered = (envelope.data.startsWith('A') ? 'B' : 'A') + envelope.data.slice(1);
      await redis.observer.set(key, JSON.stringify({ ...envelope, data: tampered }), 'KEEPTTL');
      await expect(sessions.validate(created.token)).rejects.toThrow(SessionSerializationError);
    });
  });
});
