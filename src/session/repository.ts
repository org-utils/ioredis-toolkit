import { createHash } from 'node:crypto';
import type { RedisClientWrapper } from '../redis/index.js';
import { SessionConflictError, SessionReplayError, SessionRotationError, SessionStorageError } from './errors.js';
import type { SessionConfig } from './config.js';
import type { SessionKeyStrategy } from './keys.js';
import type { SessionRecord } from './types.js';
import { SessionScriptRegistry } from './scripts.js';
import { SessionSerializer } from './serializer.js';

/** Dependencies required by the session repository. */
export interface SessionRepositoryOptions { redis: RedisClientWrapper; keys: SessionKeyStrategy; serializer: SessionSerializer; scripts: SessionScriptRegistry; config: SessionConfig; }

/** What is stored under a session key: the record, nothing, or a value that cannot be decoded as a record. */
type Stored = SessionRecord | 'missing' | 'unreadable';

/**
 * A session as one read of its user's slot found it, with what validating it takes: whether the user's session set holds
 * it, the user's stored security version, and Redis server time, all at the same instant. `raw` is the value the record
 * was decoded from, so a write worked out from this read can be made conditional on the record being unchanged since.
 */
export interface SessionRead { record: SessionRecord; raw: string; inSessionSet: boolean; securityVersion: string | null; serverSeconds: number; }

/** What is stored under a session key, along with the raw value it was decoded from. */
type Loaded = { raw: string | null; stored: Stored };

/** What a change does about the stored record: leaves it, or replaces it with a record that lives for `ttl` seconds. */
type Change<T> = { result: T } | { result: T; replacement: SessionRecord; ttl: number };

/** How many times a change is worked out again after another writer got there first. */
const MAX_CHANGE_ATTEMPTS = 32;

/** Persistence boundary for authoritative session state and derived indexes. */
export class SessionRepository {
  /** Creates the repository using shared Redis infrastructure and versioned serializers/scripts. */
  constructor(private readonly o: SessionRepositoryOptions) {}

  /**
   * Persists a session and its derived indexes using the repository's authoritative write semantics. With security versions
   * enabled, a user with none stored yet gets the session's version, set if absent in the same step.
   */
  async create(record: SessionRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil(record.expiresAt - record.createdAt));
    const result = await this.o.scripts.eval(
      'create_session',
      [this.o.keys.session(record.userId, record.id), this.o.keys.sessionSet(record.userId), this.o.keys.securityVersion(record.userId)],
      [this.o.serializer.serialize(record), String(ttl), String(record.createdAt), record.id, String(this.o.config.maxSessionsPerUser),
        // The script deletes the record of each session it evicts, which shares the user's slot, by appending its token hash to this key.
        this.o.keys.sessionByTag(this.o.keys.userTag(record.userId), ''),
        // A user with no stored security version takes the one their session is created with; a stored one is never overwritten.
        this.o.config.securityVersionEnabled && record.securityVersion !== null ? String(record.securityVersion) : '']
    );
    const [code, ...evicted] = result as unknown[];
    if (Number(code) !== 1) throw new SessionStorageError('Session creation failed');
    // An evicted session is unusable once its record is gone; its locators live in other slots and are only cleanup.
    if (evicted.length) await this.safeDel(...evicted.map(tokenHash => this.o.keys.tokenLocator(String(tokenHash))));
    let located: string | null;
    try { located = await this.o.redis.set(this.o.keys.tokenLocator(record.id), this.o.keys.userTag(record.userId), 'EX', String(ttl), 'NX'); }
    catch (error) { throw new SessionStorageError('Session token locator write failed', error); }
    if (located !== 'OK') {
      await this.safeDel(this.o.keys.session(record.userId, record.id));
      try { await this.o.redis.zrem(this.o.keys.sessionSet(record.userId), record.id); } catch { /* best effort */ }
      throw new SessionStorageError('Session token locator already occupied');
    }
  }

  /**
   * Resolves a token hash through the secondary locator and then reads the authoritative session record. A record that
   * cannot be decoded throws `SessionSerializationError` and is left as stored: a key manager briefly missing a key
   * version, or encryption switched off by mistake, must be recoverable by putting the configuration back.
   */
  async resolve(tokenHash: string): Promise<SessionRecord | null> {
    const userTag = await this.locate(tokenHash);
    if (!userTag) return null;
    let raw: string | null;
    try { raw = await this.o.redis.get(this.o.keys.sessionByTag(userTag, tokenHash)); }
    catch (error) { throw new SessionStorageError('Session record unavailable', error); }
    if (!raw) { await this.safeDel(this.o.keys.tokenLocator(tokenHash)); return null; }
    return this.o.serializer.deserialize(raw);
  }

  /**
   * Resolves a token hash as {@link resolve} does, and reads everything validation needs in the same script as the record:
   * two round trips in all. A record and its membership in the user's session set are only ever seen together as they
   * stood at one instant, so a session consumed or revoked meanwhile is never seen as active but missing from its set.
   */
  async read(tokenHash: string): Promise<SessionRead | null> {
    const userTag = await this.locate(tokenHash);
    if (!userTag) return null;
    let result: unknown;
    try {
      result = await this.o.scripts.eval(
        'read_session',
        [this.o.keys.sessionByTag(userTag, tokenHash), this.o.keys.sessionSetByTag(userTag), this.o.keys.securityVersionByTag(userTag)],
        [tokenHash],
      );
    } catch (error) { throw new SessionStorageError('Session record unavailable', error); }
    const [raw, inSessionSet, securityVersion, serverSeconds] = result as [string | null, number, string | null, string];
    if (!raw) { await this.safeDel(this.o.keys.tokenLocator(tokenHash)); return null; }
    const record = this.o.serializer.deserialize(raw);
    // The set read is under the locator's tag and token hash, so it is this record's membership only if both are the record's own.
    const ownKeys = record.id === tokenHash && this.o.keys.userTag(record.userId) === userTag;
    return { record, raw, inSessionSet: inSessionSet === 1 && ownKeys, securityVersion, serverSeconds: Number(serverSeconds) };
  }

  /** Persists the current security version for a user, for the longer of their longest-lived session and one session ttl. */
  async setSecurityVersion(userId: string, version: number): Promise<void> {
    try { await this.o.scripts.eval('set_security_version', [this.o.keys.securityVersion(userId), this.o.keys.sessionSet(userId)], [String(version), String(this.o.config.ttl * 1000)]); }
    catch (error) { throw new SessionStorageError('Security version update failed', error); }
  }

  /**
   * Updates rolling idle expiration when the touch interval permits it, at the time of the read the session was validated
   * from. The write is worked out from that read and made only if the record is still the one it found.
   */
  async touch(read: SessionRead): Promise<'updated' | 'skipped' | 'invalid'> {
    const serverSeconds = read.serverSeconds;
    return this.change<'updated' | 'skipped' | 'invalid'>(read.record, (stored, attempt) => {
      if (!isRecord(stored) || stored.status !== 'active' || hasExpired(stored, serverSeconds)) return { result: 'invalid' };
      if (serverSeconds - stored.lastAccessedAt < this.o.config.touchInterval) return { result: 'skipped' };
      // A touch that lost the write to another touch at this same instant has nothing left to extend.
      if (attempt > 0 && stored.lastAccessedAt >= serverSeconds) return { result: 'skipped' };
      const idleDuration = stored.idleTimeoutSeconds ?? this.o.config.idleTimeout ?? this.o.config.ttl;
      const idleExpiresAt = stored.idleExpiresAt === null ? null : Math.min(stored.absoluteExpiresAt ?? Number.MAX_SAFE_INTEGER, serverSeconds + idleDuration);
      // A touch changes nothing the application can see, so it leaves the version alone.
      return { result: 'updated', replacement: { ...stored, lastAccessedAt: serverSeconds, idleExpiresAt }, ttl: stored.expiresAt - serverSeconds };
    }, { raw: read.raw, stored: read.record });
  }

  /**
   * Consumes a predecessor session for rotation, linking it forward to the successor it is consumed for; of any number of
   * concurrent callers, exactly one succeeds.
   */
  async consume(record: SessionRecord, successor: SessionRecord, serverSeconds: number, tombstoneTtl: number): Promise<void> {
    await this.change(record, stored => {
      if (isRecord(stored) && stored.status === 'consumed') throw new SessionReplayError();
      if (!isRecord(stored) || stored.status === 'revoked' || hasExpired(stored, serverSeconds)) throw new SessionRotationError('Session cannot be rotated');
      const consumed: SessionRecord = { ...stored, status: 'consumed', consumedAt: serverSeconds, successorId: successor.id, successorJti: successor.jti, version: stored.version + 1 };
      return { result: undefined, replacement: consumed, ttl: Math.max(1, tombstoneTtl) };
    });
    await this.leaveSessionSet(record.userId, record.id);
    await this.expireLocator(record.id, Math.max(1, tombstoneTtl));
  }

  /**
   * Applies `patch` to the record as stored and returns what was written. The patch is applied to the stored record, not to
   * the one the caller read, so a touch that landed in between is kept. With an `expectedVersion`, a record at any other
   * version is refused with {@link SessionConflictError}.
   */
  async update(record: SessionRecord, patch: (stored: SessionRecord) => SessionRecord, expectedVersion: number | undefined, serverSeconds: number): Promise<SessionRecord> {
    return this.change(record, stored => {
      if (!isRecord(stored) || stored.status !== 'active' || stored.expiresAt <= serverSeconds) throw new SessionStorageError('Session update failed');
      if (expectedVersion !== undefined && stored.version !== expectedVersion) throw new SessionConflictError();
      const replacement = patch(stored);
      return { result: replacement, replacement, ttl: stored.expiresAt - serverSeconds };
    });
  }

  /**
   * Marks a session revoked. The write is unconditional, so no amount of concurrent writing can hold a
   * revocation off; every other change is conditional on the value it read, so none can undo one.
   *
   * A consumed session stays consumed: its revocation ends the session at the end of its rotation chain instead (ADR-0004).
   * Rotation gives a successor the same expiry as its predecessor, so `tombstoneTtl` serves that session too. Rotation can
   * consume the session at the end between the read and the write, so a write that turns out to have replaced anything but
   * that active session walks on, and puts back what it replaced once the walk is over (ADR-0005): ending the successor comes
   * first, so a revocation cut short leaves the logout done rather than the replay signal kept. Where a link leads to a
   * successor not there yet, revoke writes a tombstone in its place, so that a rotation still creating it fails instead of
   * leaving it active.
   */
  async revoke(record: SessionRecord, serverSeconds: number, tombstoneTtl: number): Promise<void> {
    const replacedByMistake: { key: string; raw: string; pttl: number }[] = [];
    try { await this.revokeAlongChain(record, serverSeconds, tombstoneTtl, replacedByMistake); }
    finally { for (const { key, raw, pttl } of replacedByMistake) await this.putBack(key, raw, pttl); }
  }

  /** The walk `revoke` makes, noting each value its write replaced but must put back. */
  private async revokeAlongChain(record: SessionRecord, serverSeconds: number, tombstoneTtl: number, replacedByMistake: { key: string; raw: string; pttl: number }[]): Promise<void> {
    const passed = new Set<string>();
    let id = record.id;
    let predecessor: SessionRecord | null = null;
    for (;;) {
      const key = this.o.keys.session(record.userId, id);
      let { stored } = await this.load(key);
      if (isRecord(stored) && stored.status === 'active') {
        const replaced = await this.writeRevoked(key, stored, tombstoneTtl);
        if (replaced && isRecord(replaced.stored) && replaced.stored.status === 'active') {
          // Only the call that replaced the active record cuts the locator; a later one would let it outlive the tombstone.
          await this.leaveSessionSet(record.userId, id);
          await this.expireLocator(id, tombstoneTtl);
          return;
        }
        if (replaced) replacedByMistake.push({ key, raw: replaced.raw, pttl: replaced.pttl });
        stored = replaced ? replaced.stored : 'missing';
      }
      if (stored === 'unreadable') throw new SessionStorageError('Session revocation failed');
      if (stored === 'missing') {
        if (predecessor === null) return this.leaveSessionSet(record.userId, id);
        if (await this.takeSuccessorsPlace(key, predecessor, serverSeconds, tombstoneTtl)) return;
        // The successor was created meanwhile: revoke it.
        continue;
      }
      if (stored.status === 'revoked') return this.leaveSessionSet(record.userId, id);
      // A consumed session without a link was consumed by a release that kept none: nothing is left to end.
      if (stored.successorId === undefined) return;
      passed.add(id);
      if (passed.has(stored.successorId)) throw new SessionStorageError('Rotation chain links back on itself');
      predecessor = stored;
      id = stored.successorId;
    }
  }

  /** Writes `record` revoked under `key` unconditionally, answering with the value it replaced, or null when there was none. */
  private async writeRevoked(key: string, record: SessionRecord, ttl: number): Promise<{ raw: string; pttl: number; stored: Stored } | null> {
    const revoked = this.o.serializer.serialize({ ...record, status: 'revoked', version: record.version + 1 });
    const [written, raw, pttl] = await this.o.scripts.eval('revoke_session', [key], [revoked, String(ttl)]) as [number, string?, number?];
    if (Number(written) !== 1) return null;
    return { raw: raw!, pttl: Number(pttl), stored: this.decode(raw!) };
  }

  /**
   * Puts back a value that a revocation replaced although it was not the active session the revocation read: a consumed or
   * revoked record, which revocation must leave as it is, for as long as it had left. Only a revocation's write over it is
   * undone, and two revocations doing this at once agree on the oldest value, the one no revocation wrote.
   */
  private async putBack(key: string, raw: string, pttl: number): Promise<void> {
    const ttl = String(Math.max(1, Math.ceil(pttl / 1000)));
    for (let attempt = 0; attempt < MAX_CHANGE_ATTEMPTS; attempt += 1) {
      const current = await this.load(key);
      if (current.raw === null || current.raw === raw || !isRecord(current.stored) || current.stored.status !== 'revoked') return;
      if (await this.replace(key, current.raw, raw, ttl)) return;
    }
    throw new SessionStorageError('Session is being changed by too many writers at once');
  }

  /**
   * Writes a revoked tombstone where a consumed session's successor belongs, if nothing is there: a rotation still creating
   * that successor then fails to, rather than leave it active. Answers whether the tombstone was written.
   */
  private async takeSuccessorsPlace(key: string, predecessor: SessionRecord, serverSeconds: number, ttl: number): Promise<boolean> {
    const tombstone: SessionRecord = {
      ...predecessor, id: predecessor.successorId!, jti: predecessor.successorJti ?? predecessor.jti, createdAt: serverSeconds,
      lastAccessedAt: serverSeconds, status: 'revoked', version: 1, rotatedFrom: predecessor.jti
    };
    delete tombstone.consumedAt; delete tombstone.successorId; delete tombstone.successorJti;
    try { return (await this.o.redis.set(key, this.o.serializer.serialize(tombstone), 'EX', String(ttl), 'NX')) === 'OK'; }
    catch (error) { throw new SessionStorageError('Session revocation failed', error); }
  }

  private async leaveSessionSet(userId: string, id: string): Promise<void> {
    try { await this.o.redis.zrem(this.o.keys.sessionSet(userId), id); }
    catch (error) { throw new SessionStorageError('Session set cleanup failed', error); }
  }

  /** Removes the authoritative record and derived index entries. */
  async destroy(record: SessionRecord): Promise<void> {
    try {
      await this.o.redis.del(this.o.keys.session(record.userId, record.id));
      await this.o.redis.zrem(this.o.keys.sessionSet(record.userId), record.id);
      await this.o.redis.del(this.o.keys.tokenLocator(record.id));
    } catch (error) { throw new SessionStorageError('Session deletion failed', error); }
  }

  /**
   * Loads a bounded page of sessions and removes members whose record is gone from the user's session set. A record past
   * any of its expiries at `serverSeconds` is left out of the page. So is a record that cannot be decoded, which is kept in the set,
   * so a misconfigured key manager drops no session.
   */
  async list(userId: string, offset: number, limit: number, serverSeconds: number): Promise<SessionRecord[]> {
    const members = await this.o.redis.zrange(this.o.keys.sessionSet(userId), offset, offset + limit - 1);
    if (!members.length) return [];
    const keys = members.map(tokenHash => this.o.keys.sessionByTag(this.o.keys.userTag(userId), tokenHash));
    const raw = await this.o.redis.mgetClusterAware(keys, { concurrency: this.o.config.maxConcurrency });
    const records: SessionRecord[] = [];
    const stale: string[] = [];
    raw.forEach((value, i) => {
      if (!value) { stale.push(members[i]!); return; }
      let record: SessionRecord;
      try { record = this.o.serializer.deserialize(value); } catch { return; /* reported by resolve(), never deleted */ }
      if (!hasExpired(record, serverSeconds)) records.push(record);
    });
    if (stale.length) await this.o.redis.zrem(this.o.keys.sessionSet(userId), ...stale);
    return records;
  }

  /**
   * Revokes a bounded batch and returns the number of sessions left in the user's session set. The token locators live in other slots
   * and go first, through the cluster-aware delete; a credential without one already reads as not found. The records and
   * the user's session set share the user's slot, so they go after in one pipeline. A failure at either step throws, and
   * a retry finds the same batch still in the set.
   */
  async revokeAll(userId: string, limit: number): Promise<{ affected: number; remaining: number }> {
    const bounded = Math.min(Math.max(1, limit), this.o.config.maxBatchSize);
    const setKey = this.o.keys.sessionSet(userId);
    const members = await this.o.redis.zrange(setKey, 0, bounded - 1);
    if (!members.length) return { affected: 0, remaining: 0 };
    try { await this.o.redis.del(...members.map(tokenHash => this.o.keys.tokenLocator(tokenHash))); }
    catch (error) { throw new SessionStorageError('One or more revokeAll operations failed', error); }
    const userTag = this.o.keys.userTag(userId);
    const pipeline = this.o.redis.pipeline();
    pipeline.del(...members.map(tokenHash => this.o.keys.sessionByTag(userTag, tokenHash)));
    pipeline.zrem(setKey, ...members);
    pipeline.zcard(setKey);
    const results = await pipeline.exec();
    if (!results) throw new SessionStorageError('Redis pipeline unavailable');
    if (results.some(([error]) => error)) throw new SessionStorageError('One or more revokeAll operations failed');
    const [, , [, remaining]] = results as [unknown, unknown, [Error | null, number]];
    return { affected: members.length, remaining };
  }

  /**
   * Changes a stored record without Redis having to decode it, so an encrypted record stays encrypted.
   * `decide` is given what is stored and answers with its replacement, which is written only if the
   * stored value is still the one `decide` saw; when another writer got there first, it decides again. A caller that has
   * just read the record passes that read as `loaded`, and the first decision is made on it without reading again.
   */
  private async change<T>(record: SessionRecord, decide: (stored: Stored, attempt: number) => Change<T>, loaded?: Loaded): Promise<T> {
    const key = this.o.keys.session(record.userId, record.id);
    for (let attempt = 0; attempt < MAX_CHANGE_ATTEMPTS; attempt += 1) {
      const { raw, stored } = attempt === 0 && loaded ? loaded : await this.load(key);
      const change = decide(stored, attempt);
      if (raw === null || !('replacement' in change)) return change.result;
      if (await this.replace(key, raw, this.o.serializer.serialize(change.replacement), String(change.ttl))) return change.result;
    }
    throw new SessionStorageError('Session is being changed by too many writers at once');
  }

  /** Writes `replacement` under `key` for `ttl` seconds if what is stored is still `expected`, answering whether it was. */
  private async replace(key: string, expected: string, replacement: string, ttl: string): Promise<boolean> {
    const result = await this.o.scripts.eval('replace_session', [key], [createHash('sha1').update(expected).digest('hex'), replacement, ttl]);
    return Number((result as unknown[])[0]) === 1;
  }

  /** Reads what is stored under a session key, along with the raw value it was decoded from. */
  private async load(key: string): Promise<Loaded> {
    let raw: string | null;
    try { raw = await this.o.redis.get(key); }
    catch (error) { throw new SessionStorageError('Session record unavailable', error); }
    if (raw === null) return { raw, stored: 'missing' };
    return { raw, stored: this.decode(raw) };
  }

  /** Decodes a stored value as a record, or reports it unreadable. */
  private decode(raw: string): Stored {
    try { return this.o.serializer.deserialize(raw); }
    catch { return 'unreadable'; }
  }

  /** The user tag a token hash's locator names, or null when there is none. */
  private async locate(tokenHash: string): Promise<string | null> {
    try { return await this.o.redis.get(this.o.keys.tokenLocator(tokenHash)); }
    catch (error) { throw new SessionStorageError('Session token locator unavailable', error); }
  }

  /**
   * Cuts a spent session's token locator to the life of its tombstone, so the credential keeps resolving to the tombstone
   * while it lasts and leaves nothing behind once it is gone. Best effort: a locator left longer resolves to a missing
   * record, which reads as not found and is deleted then.
   */
  private async expireLocator(tokenHash: string, tombstoneTtl: number): Promise<void> {
    const key = this.o.keys.tokenLocator(tokenHash);
    try {
      if (tombstoneTtl < 1) await this.o.redis.del(key);
      else await this.o.redis.expire(key, tombstoneTtl);
    } catch { /* derived cleanup is best effort */ }
  }

  private async safeDel(...keys: string[]): Promise<void> { try { await this.o.redis.del(...keys); } catch { /* derived cleanup is best effort */ } }
}

function isRecord(stored: Stored): stored is SessionRecord { return typeof stored !== 'string'; }

/** Whether any of a record's expiries has passed at `serverSeconds`. */
function hasExpired(record: SessionRecord, serverSeconds: number): boolean {
  return record.expiresAt <= serverSeconds
    || (record.absoluteExpiresAt !== null && record.absoluteExpiresAt <= serverSeconds)
    || (record.idleExpiresAt !== null && record.idleExpiresAt <= serverSeconds);
}
