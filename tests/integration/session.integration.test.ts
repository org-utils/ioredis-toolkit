import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SessionConflictError, SessionExpiredError, SessionInvalidError, SessionNotFoundError, SessionReplayError, SessionRevokedError, SessionRotationError, SessionSerializationError, SessionStorageError,
} from '../../src/index.js';
import type { KeyManager, SessionConfig, SessionManager, SessionMetrics } from '../../src/index.js';
import { unknownCredential } from '../support/credential.js';
import { expectPackageError } from '../support/errors.js';
import { hashSlot } from '../support/hash-slot.js';
import { describeOnEachTopology } from '../support/redis.js';
import { keyManager, keyManagerHolding } from '../support/key-manager.js';

/** The secret half of an opaque credential; the other half is the JTI, which is stored by design. */
function secretOf(token: string): string { return token.slice(token.indexOf('.') + 1); }

describeOnEachTopology('sessions against real Redis', redis => {
  function sessionsIn(namespace: string, config: Partial<SessionConfig> = {}, encryptionKeyManager?: KeyManager): SessionManager {
    return redis.connectClient({ sessions: { enabled: true, namespace, ...config } }, encryptionKeyManager ? { encryptionKeyManager } : {}).sessions;
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

  /** The one key under a namespace holding a user's session set, the sorted set of that user's sessions. */
  async function sessionSetKey(namespace: string): Promise<string> {
    const sets: string[] = [];
    for (const key of await redis.keysUnder(namespace)) if ((await redis.observer.type(key)) === 'zset') sets.push(key);
    expect(sets).toHaveLength(1);
    return sets[0]!;
  }

  it.each(['plain', 'encrypted'] as const)('creates, validates, touches, updates, rotates, revokes and destroys a session in %s storage', async storage => {
    const namespace = redis.newNamespace();
    const lifetime = { rolling: true, touchInterval: 0, ttl: 600, idleTimeout: 300, absoluteTimeout: 600 };
    const manager = storage === 'encrypted'
      ? sessionsIn(namespace, { ...lifetime, encryption: { enabled: true } }, keyManager())
      : redis.connectSessionManager({ enabled: true, namespace, ...lifetime });
    /** Whatever wrote a record last, encrypted storage must not leave its user readable in Redis. */
    async function expectStoredAsConfigured(): Promise<void> {
      const stored = await redis.storedUnder(namespace);
      if (storage === 'encrypted') expect(stored).not.toContain('integration-user');
      else expect(stored).toContain('integration-user');
    }

    const created = await manager.create({ userId: 'integration-user' });
    expect(await manager.validate(created.token)).toEqual({ valid: true, session: created.session });
    await expectStoredAsConfigured();

    // A touch extends the session but changes nothing the application can see, so the version stays.
    await manager.touch(created.token);
    expect((await manager.get(created.token)).version).toBe(created.session.version);
    await expectStoredAsConfigured();

    // Text outside ASCII is stored as several bytes, which the later writes must still recognise as unchanged.
    const updated = await manager.update(created.token, { metadata: { plan: 'pro', name: 'Zoë 🙂' } });
    expect(updated.version).toBe(created.session.version + 1);
    expect(await manager.get(created.token)).toEqual(updated);
    await expectStoredAsConfigured();

    const rotated = await manager.rotate(created.token);
    expect(rotated.session.metadata).toEqual({ plan: 'pro', name: 'Zoë 🙂' });
    expect(rotated.previousJti).toBe(created.session.jti);
    expect(await manager.validate(created.token)).toEqual({ valid: false, reason: 'consumed' });
    expect((await manager.validate(rotated.token)).valid).toBe(true);
    await expectStoredAsConfigured();

    await manager.revoke(rotated.token);
    expect(await manager.validate(rotated.token)).toEqual({ valid: false, reason: 'revoked' });
    await expectStoredAsConfigured();

    await manager.destroy(rotated.token);
    expect(await manager.validate(rotated.token)).toEqual({ valid: false, reason: 'not_found' });
  });

  it('leaves a session unwritten when touched inside the touch interval', async () => {
    const sessions = sessionsIn(redis.newNamespace(), { touchInterval: 60, idleTimeout: 300 });
    const created = await sessions.create({ userId: 'integration-user' });
    await sessions.touch(created.token);
    expect(await sessions.get(created.token)).toEqual(created.session);
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

  it.each(['plain', 'encrypted'] as const)('never persists the raw credential of a rotated session or of its successor in %s storage', async storage => {
    const namespace = redis.newNamespace();
    const sessions = storage === 'encrypted' ? sessionsIn(namespace, { encryption: { enabled: true } }, keyManager()) : sessionsIn(namespace);
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

  // On Cluster the creation script deletes the evicted token locator, which lives in another slot, so creation fails.
  redis.itFailsOnClusterUntil('#53', /non local key/, 'leaves no key behind for a session evicted by maxSessionsPerUser', async () => {
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

  describe('token locators', () => {
    /** The most a tombstone, and so a spent credential's locator, lives: the session's remaining lifetime, capped at 300 seconds. */
    const TOMBSTONE_TTL = 300;

    /** The locator of a session: the one key under the namespace that names the session id and carries no hash tag, since a credential alone must find it. */
    async function locatorOf(namespace: string, sessionId: string): Promise<string> {
      const locators = (await redis.keysUnder(namespace)).filter(key => key.includes(sessionId) && !key.includes('{'));
      expect(locators).toHaveLength(1);
      return locators[0]!;
    }

    it('expires the locator of a rotated session with its tombstone', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace);
      const created = await sessions.create({ userId: 'integration-user' });
      await sessions.rotate(created.token);

      const ttl = await redis.observer.ttl(await locatorOf(namespace, created.session.id));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(TOMBSTONE_TTL);
    });

    it('expires the locator of a revoked session with its tombstone', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace);
      const created = await sessions.create({ userId: 'integration-user' });
      await sessions.revoke(created.token);

      const ttl = await redis.observer.ttl(await locatorOf(namespace, created.session.id));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(TOMBSTONE_TTL);
    });

    it('keeps reporting a rotated credential as consumed, and a revoked one as revoked, while the tombstone lasts', async () => {
      const sessions = sessionsIn(redis.newNamespace());
      const rotated = await sessions.create({ userId: 'integration-user' });
      const revoked = await sessions.create({ userId: 'integration-user' });
      await sessions.rotate(rotated.token);
      await sessions.revoke(revoked.token);

      expect(await sessions.validate(rotated.token)).toEqual({ valid: false, reason: 'consumed' });
      await expectPackageError(() => sessions.rotate(rotated.token), SessionReplayError, 'SESSION_REPLAY');
      expect(await sessions.validate(revoked.token)).toEqual({ valid: false, reason: 'revoked' });
    });

    it('leaves at most one short-lived locator per rotation', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace);
      let current = await sessions.create({ userId: 'integration-user' });
      for (let rotation = 0; rotation < 10; rotation += 1) current = await sessions.rotate(current.token);

      const spent = (await redis.keysUnder(namespace)).filter(key => !key.includes('{') && !key.includes(current.session.id));
      expect(spent.length).toBeLessThanOrEqual(10);
      for (const locator of spent) expect(await redis.observer.ttl(locator)).toBeLessThanOrEqual(TOMBSTONE_TTL);
    });

    it('reports a spent credential as not found, and leaves none of its keys, once the tombstone is gone', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace, { ttl: 2 });
      const rotated = await sessions.create({ userId: 'integration-user' });
      const revoked = await sessions.create({ userId: 'integration-user' });
      await sessions.rotate(rotated.token);
      await sessions.revoke(revoked.token);

      // Every key here was written to live at most as long as the 2-second sessions.
      await new Promise(resolve => setTimeout(resolve, 2_100));
      expect(await sessions.validate(rotated.token)).toEqual({ valid: false, reason: 'not_found' });
      expect(await sessions.validate(revoked.token)).toEqual({ valid: false, reason: 'not_found' });
      const left = (await redis.keysUnder(namespace)).join('\n');
      expect(left).not.toContain(rotated.session.id);
      expect(left).not.toContain(revoked.session.id);
    });
  });

  describe('security versions', () => {
    /** The one key under a namespace holding a user's security version: a string that is not a session envelope. */
    async function securityVersionKey(namespace: string): Promise<string> {
      const keys: string[] = [];
      for (const key of await redis.keysUnder(namespace)) {
        if (key.includes('{') && (await redis.observer.type(key)) === 'string' && !(await redis.observer.get(key))!.startsWith('{')) keys.push(key);
      }
      expect(keys).toHaveLength(1);
      return keys[0]!;
    }

    it('stores the version the first session of a user is created with', async () => {
      const sessions = sessionsIn(redis.newNamespace(), { securityVersionEnabled: true });
      const created = await sessions.create({ userId: 'integration-user', securityVersion: 3 });
      expect(await sessions.validate(created.token)).toEqual({ valid: true, session: created.session });
    });

    it('never lets create() overwrite a stored version', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace, { securityVersionEnabled: true });
      await sessions.setSecurityVersion('integration-user', 4);
      const stale = await sessions.create({ userId: 'integration-user', securityVersion: 3 });

      expect(await redis.observer.get(await securityVersionKey(namespace))).toBe('4');
      expect(await sessions.validate(stale.token)).toEqual({ valid: false, reason: 'invalid' });
    });

    it('invalidates sessions created before a bump', async () => {
      const sessions = sessionsIn(redis.newNamespace(), { securityVersionEnabled: true });
      const before = await sessions.create({ userId: 'integration-user', securityVersion: 3 });
      await sessions.setSecurityVersion('integration-user', 4);
      expect(await sessions.validate(before.token)).toEqual({ valid: false, reason: 'invalid' });
    });

    it('fails closed while the stored version is missing, until the next create() stores one', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace, { securityVersionEnabled: true });
      const existing = await sessions.create({ userId: 'integration-user', securityVersion: 3 });
      await redis.observer.del(await securityVersionKey(namespace));

      expect(await sessions.validate(existing.token)).toEqual({ valid: false, reason: 'invalid' });
      await sessions.create({ userId: 'integration-user', securityVersion: 3 });
      expect((await sessions.validate(existing.token)).valid).toBe(true);
    });
  });

  describe('update()', () => {
    it('accepts the version read before a touch, and keeps what the touch extended', async () => {
      const sessions = sessionsIn(redis.newNamespace(), { touchInterval: 0, idleTimeout: 300 });
      const { token } = await sessions.create({ userId: 'integration-user' });
      const read = await sessions.get(token);
      // A touch in a later server second moves the idle expiry forward.
      await new Promise(resolve => setTimeout(resolve, 1_000));
      await sessions.touch(token);
      const touched = await sessions.get(token);
      expect(touched.idleExpiresAt).toBeGreaterThan(read.idleExpiresAt!);

      const updated = await sessions.update(token, { metadata: { plan: 'pro' } }, read.version);
      expect(updated).toMatchObject({ version: read.version + 1, idleExpiresAt: touched.idleExpiresAt, lastAccessedAt: touched.lastAccessedAt });
      expect(await sessions.get(token)).toEqual(updated);
    });

    it('stores no field whose store flag is off, as create() does', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace, { storeIpAddress: false, storeUserAgent: false, storeDeviceId: false });
      const { token } = await sessions.create({ userId: 'integration-user' });

      const updated = await sessions.update(token, { ipAddress: '1.2.3.4', userAgent: 'agent/1.0', deviceId: 'device-1' });
      expect(updated).not.toHaveProperty('ipAddress');
      const stored = await redis.storedUnder(namespace);
      for (const value of ['1.2.3.4', 'agent/1.0', 'device-1']) expect(stored).not.toContain(value);
    });

    it('refuses a user agent longer than create() accepts', async () => {
      const sessions = sessionsIn(redis.newNamespace(), { storeUserAgent: true });
      const { token } = await sessions.create({ userId: 'integration-user' });
      await expectPackageError(() => sessions.update(token, { userAgent: 'a'.repeat(1025) }), SessionInvalidError, 'SESSION_INVALID');
    });
  });

  it('lists only sessions that have not passed any of their expiries', async () => {
    const namespace = redis.newNamespace();
    const sessions = sessionsIn(namespace, { idleTimeout: 300 });
    const live = await sessions.create({ userId: 'integration-user' });
    const idle = await sessions.create({ userId: 'integration-user' });
    // The record is the one key that names the session and carries the user's hash tag.
    const [idleRecordKey] = (await redis.keysUnder(namespace)).filter(key => key.includes(idle.session.id) && key.includes('{'));
    const lapsed = { ...idle.session, idleExpiresAt: idle.session.createdAt - 1 };
    await redis.observer.set(idleRecordKey!, JSON.stringify({ v: 1, data: JSON.stringify(lapsed) }), 'KEEPTTL');

    expect(await sessions.list('integration-user')).toEqual([live.session]);
  });

  describe('records that cannot be decoded', () => {
    /** Keys by version, and managers for a deploy whose key manager briefly lacks the version older sessions were written under. */
    function keyVersions() {
      const keys = { v1: randomBytes(32), v2: randomBytes(32) };
      return { before: keyManagerHolding({ v1: keys.v1 }, 'v1'), missingV1: keyManagerHolding({ v2: keys.v2 }, 'v2'), restored: keyManagerHolding(keys, 'v2') };
    }

    function encryptedSessionsIn(namespace: string, encryptionKeyManager: KeyManager): SessionManager {
      return sessionsIn(namespace, { encryption: { enabled: true } }, encryptionKeyManager);
    }

    it('reports a record whose key version is missing, leaves it as stored, and validates it again once the key is back', async () => {
      const namespace = redis.newNamespace();
      const managers = keyVersions();
      const created = await encryptedSessionsIn(namespace, managers.before).create({ userId: 'integration-user' });
      const stored = await redis.storedUnder(namespace);

      await expectPackageError(() => encryptedSessionsIn(namespace, managers.missingV1).validate(created.token), SessionSerializationError, 'SESSION_SERIALIZATION');
      expect(await redis.storedUnder(namespace)).toBe(stored);
      expect(await encryptedSessionsIn(namespace, managers.restored).validate(created.token)).toEqual({ valid: true, session: created.session });
    });

    it('lists the sessions it can read and keeps the others in the user\'s session set', async () => {
      const namespace = redis.newNamespace();
      const managers = keyVersions();
      const unreadable = await encryptedSessionsIn(namespace, managers.before).create({ userId: 'integration-user' });
      const sessions = encryptedSessionsIn(namespace, managers.missingV1);
      const readable = await sessions.create({ userId: 'integration-user' });

      expect(await sessions.list('integration-user')).toEqual([readable.session]);
      expect(await redis.observer.zrange(await sessionSetKey(namespace), 0, -1)).toContain(unreadable.session.id);
    });
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
      const { sessions } = redis.connectClient({ sessions: { enabled: true, namespace } }, { metrics });
      const created = await sessions.create({ userId: 'integration-user' });
      const key = await envelopeKey(namespace);
      onValidated = () => { void redis.observer.del(key); };
      await expectPackageError(() => sessions.rotate(created.token), SessionRotationError, 'SESSION_ROTATION');
    });

    it('reports SESSION_STORAGE when Redis refuses what a session script does', async () => {
      const namespace = redis.newNamespace();
      const sessions = sessionsIn(namespace);
      await sessions.create({ userId: 'integration-user' });
      // The user's index is the one sorted set a session leaves; as a string, the script's write to it is refused.
      for (const key of await redis.keysUnder(namespace)) {
        if ((await redis.observer.type(key)) === 'zset') await redis.observer.multi().del(key).set(key, 'not an index').exec();
      }
      await expectPackageError(() => sessions.create({ userId: 'integration-user' }), SessionStorageError, 'SESSION_STORAGE');
    });
  });
});
