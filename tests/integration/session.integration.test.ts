import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSessionManagerFromRedis,
  SessionConflictError, SessionExpiredError, SessionNotFoundError, SessionReplayError, SessionRevokedError, SessionRotationError, SessionSerializationError,
} from '../../src/index.js';
import type { KeyManager, SessionConfig, SessionManager, SessionMetrics } from '../../src/index.js';
import { unknownCredential } from '../support/credential.js';
import { expectPackageError } from '../support/errors.js';
import { hashSlot } from '../support/hash-slot.js';
import { connectClient, connectionConfig, redisFixture, redisUrl } from '../support/redis.js';

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
    for (const key of await redis.keysUnder(namespace)) {
      if ((await redis.observer.type(key)) === 'string' && (await redis.observer.get(key))?.startsWith('{')) holding.push(key);
    }
    expect(holding).toHaveLength(1);
    return holding[0]!;
  }

  it('creates, validates, touches, rotates, revokes and destroys a session', async () => {
    const { manager } = createSessionManagerFromRedis(connectionConfig(), { enabled: true, namespace: redis.newNamespace(), rolling: true, touchInterval: 0, ttl: 600, idleTimeout: 300, absoluteTimeout: 600 });
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
    const sessions = sessionsIn(redis.newNamespace());
    const first = await sessions.create({ userId: 'integration-user' });
    const second = await sessions.create({ userId: 'integration-user' });
    expect(first.token).not.toBe(second.token);
    expect(first.session.id).not.toBe(second.session.id);
    expect(secretOf(first.token).length).toBeGreaterThanOrEqual(43);
  });

  it.each(['plain', 'encrypted'] as const)('never persists the raw credential in %s storage', async storage => {
    const namespace = redis.newNamespace();
    const sessions = storage === 'encrypted' ? sessionsIn(namespace, { encryption: { enabled: true } }, keyManager()) : sessionsIn(namespace);
    const created = await sessions.create({ userId: 'integration-user' });

    const stored = await redis.storedUnder(namespace);
    // The session id is a one-way digest of the credential, so finding it proves this is where the sessions live.
    expect(created.session.id).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).toContain(created.session.id);
    expect(stored).not.toContain(created.token);
    expect(stored).not.toContain(secretOf(created.token));
  });

  it('never persists the raw credential of a rotated session or of its successor', async () => {
    const namespace = redis.newNamespace();
    const sessions = sessionsIn(namespace);
    const created = await sessions.create({ userId: 'integration-user' });
    const rotated = await sessions.rotate(created.token);

    const stored = await redis.storedUnder(namespace);
    expect(stored).toContain(rotated.session.id);
    for (const token of [created.token, rotated.token]) {
      expect(stored).not.toContain(token);
      expect(stored).not.toContain(secretOf(token));
    }
  });

  it('scopes a session to its namespace', async () => {
    const namespace = redis.newNamespace();
    const elsewhere = redis.newNamespace();
    const created = await sessionsIn(namespace).create({ userId: 'integration-user' });
    expect(await sessionsIn(elsewhere).validate(created.token)).toEqual({ valid: false, reason: 'not_found' });
    expect(await redis.keysUnder(namespace)).not.toHaveLength(0);
    expect(await redis.keysUnder(elsewhere)).toHaveLength(0);
  });

  it('leaves no key behind for a session evicted by maxSessionsPerUser', async () => {
    const namespace = redis.newNamespace();
    const sessions = sessionsIn(namespace, { maxSessionsPerUser: 1 });
    const created = [await sessions.create({ userId: 'integration-user' }), await sessions.create({ userId: 'integration-user' })];

    // Two sessions made in the same server second tie for oldest, so either may be the one evicted.
    const valid = [];
    for (const { token } of created) valid.push((await sessions.validate(token)).valid);
    expect(valid.filter(Boolean)).toHaveLength(1);
    const evicted = created[valid.indexOf(false)]!;
    expect(await sessions.validate(evicted.token)).toEqual({ valid: false, reason: 'not_found' });
    // The session id names the evicted record and its locator, and is its member in the user's index.
    expect(await redis.storedUnder(namespace)).not.toContain(evicted.session.id);
  });

  it("keeps one user's keys in a single hash slot chosen by the user", async () => {
    /** A namespace's keys split by whether they carry a hash tag; a key found by credential alone carries none. */
    async function keysByTag(namespace: string): Promise<{ tagged: string[]; untagged: string[] }> {
      const keys = await redis.keysUnder(namespace);
      // A user id cannot choose its own hash tag.
      expect(keys.join('\n')).not.toContain('evil');
      const hashTag = /\{[a-f0-9]{64}\}/;
      return { tagged: keys.filter(key => hashTag.test(key)), untagged: keys.filter(key => !hashTag.test(key)) };
    }

    const namespace = redis.newNamespace();
    const sessions = sessionsIn(namespace);
    await sessions.create({ userId: 'user:{evil}' });
    await sessions.create({ userId: 'user:{evil}' });
    await sessions.setSecurityVersion('user:{evil}', 1);
    const user = await keysByTag(namespace);
    // One locator per credential may land anywhere; everything else the user owns must share a slot.
    expect(user.untagged).toHaveLength(2);
    expect(user.tagged.length).toBeGreaterThan(1);
    expect(new Set(user.tagged.map(hashSlot)).size).toBe(1);

    // These two user ids are known to hash to different slots, so sharing one would mean the tag ignores the user.
    const elsewhere = redis.newNamespace();
    await sessionsIn(elsewhere).create({ userId: 'someone-else' });
    const other = await keysByTag(elsewhere);
    expect(other.tagged.length).toBeGreaterThan(1);
    expect(hashSlot(other.tagged[0]!)).not.toBe(hashSlot(user.tagged[0]!));
  });

  describe('stored envelope', () => {
    it('reads back a version 1 envelope it did not write', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace);
      const created = await sessions.create({ userId: 'integration-user' });
      const record = { ...created.session, metadata: { writtenBy: 'another writer' } };
      await redis.observer.set(await envelopeKey(namespace), JSON.stringify({ v: 1, data: JSON.stringify(record) }), 'KEEPTTL');
      expect(await sessions.get(created.token)).toEqual(record);
    });

    it('rejects an envelope version it does not know', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace);
      const created = await sessions.create({ userId: 'integration-user' });
      await redis.observer.set(await envelopeKey(namespace), JSON.stringify({ v: 2, data: JSON.stringify(created.session) }), 'KEEPTTL');
      await expectPackageError(() => sessions.validate(created.token), SessionSerializationError, 'SESSION_SERIALIZATION');
    });

    it('round-trips an encrypted record and keeps it unreadable in Redis', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace, { encryption: { enabled: true } }, keyManager());
      const created = await sessions.create({ userId: 'integration-user', metadata: { plan: 'pro' } });
      expect(await sessions.get(created.token)).toEqual(created.session);
      expect(await redis.observer.get(await envelopeKey(namespace))).not.toContain('integration-user');
    });

    it('rejects an encrypted record that was tampered with', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace, { encryption: { enabled: true } }, keyManager());
      const created = await sessions.create({ userId: 'integration-user' });
      const key = await envelopeKey(namespace);
      const envelope = JSON.parse((await redis.observer.get(key))!) as { data: string };
      const tampered = (envelope.data.startsWith('A') ? 'B' : 'A') + envelope.data.slice(1);
      await redis.observer.set(key, JSON.stringify({ ...envelope, data: tampered }), 'KEEPTTL');
      await expectPackageError(() => sessions.validate(created.token), SessionSerializationError, 'SESSION_SERIALIZATION');
    });
  });

  describe('error codes', () => {
    it('reports SESSION_NOT_FOUND for a credential that names no session', async () => {
      const sessions = sessionsIn(redis.newNamespace());
      await expectPackageError(() => sessions.get(unknownCredential), SessionNotFoundError, 'SESSION_NOT_FOUND');
    });

    it('reports SESSION_EXPIRED for a session past its expiry', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace);
      const created = await sessions.create({ userId: 'integration-user' });
      const lapsed = { ...created.session, expiresAt: created.session.createdAt - 1 };
      await redis.observer.set(await envelopeKey(namespace), JSON.stringify({ v: 1, data: JSON.stringify(lapsed) }), 'KEEPTTL');
      await expectPackageError(() => sessions.get(created.token), SessionExpiredError, 'SESSION_EXPIRED');
    });

    it('reports SESSION_REVOKED for a revoked session', async () => {
      const sessions = sessionsIn(redis.newNamespace());
      const created = await sessions.create({ userId: 'integration-user' });
      await sessions.revoke(created.token);
      await expectPackageError(() => sessions.get(created.token), SessionRevokedError, 'SESSION_REVOKED');
    });

    it('reports SESSION_REPLAY for a credential presented again after rotation', async () => {
      const sessions = sessionsIn(redis.newNamespace());
      const created = await sessions.create({ userId: 'integration-user' });
      await sessions.rotate(created.token);
      await expectPackageError(() => sessions.get(created.token), SessionReplayError, 'SESSION_REPLAY');
    });

    it('reports SESSION_CONFLICT for an update against a stale version', async () => {
      const sessions = sessionsIn(redis.newNamespace());
      const created = await sessions.create({ userId: 'integration-user' });
      await expectPackageError(() => sessions.update(created.token, { metadata: { plan: 'pro' } }, created.session.version + 1), SessionConflictError, 'SESSION_CONFLICT');
    });

    it('reports SESSION_ROTATION for a session that vanishes between validation and consumption', async () => {
      const namespace = redis.newNamespace();
      let onValidated = (): void => undefined;
      // rotate() reports the validation metric after it accepts the credential and before it consumes it.
      const metrics: SessionMetrics = { increment: name => { if (name === 'session.validate') onValidated(); }, observe: () => undefined, gauge: () => undefined };
      const { sessions } = connectClient({ sessions: { enabled: true, namespace } }, { metrics });
      const created = await sessions.create({ userId: 'integration-user' });
      const key = await envelopeKey(namespace);
      onValidated = () => { void redis.observer.del(key); };
      await expectPackageError(() => sessions.rotate(created.token), SessionRotationError, 'SESSION_ROTATION');
    });
  });
});
