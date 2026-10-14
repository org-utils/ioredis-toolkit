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
export interface SessionRead { record: SessionRecord; raw: string; indexed: boolean; securityVersion: string | null; serverSeconds: number; }

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
      [this.o.keys.session(record.userId, record.id), this.o.keys.userIndex(record.userId), this.o.keys.securityVersion(record.userId)],
      [this.o.serializer.serialize(record), String(ttl), String(record.createdAt), record.id, String(this.o.config.maxSessionsPerUser),
        // The script deletes the record of each session it evicts, which shares the user's slot, by appending its token hash to this key.
        this.o.keys.sessionByTag(this.o.keys.userTag(record.userId), ''),
        // A user with no stored security version takes the one their session is created with; a stored one is never overwritten.
        this.o.config.securityVersionEnabled && record.securityVersion !== null ? String(record.securityVersion) : '']
    );
    const [code, ...evicted] = result as unknown[];
    if (Number(code) !== 1) throw new SessionStorageError('Session creation failed');
    // An evicted session is unusable once its record is gone; its locators live in other slots and are only cleanup.
    if (evicted.length) await this.safeDel(...evicted.map(tokenHash => this.o.keys.tokenIndex(String(tokenHash))));
    let indexed: string | null;
    try { indexed = await this.o.redis.set(this.o.keys.tokenIndex(record.id), this.o.keys.userTag(record.userId), 'EX', String(ttl), 'NX'); }
    catch (error) { throw new SessionStorageError('Session token index write failed', error); }
    if (indexed !== 'OK') {
      await this.safeDel(this.o.keys.session(record.userId, record.id));
      try { await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id); } catch { /* best effort */ }
      throw new SessionStorageError('Session token index already occupied');
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
    if (!raw) { await this.safeDel(this.o.keys.tokenIndex(tokenHash)); return null; }
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
        [this.o.keys.sessionByTag(userTag, tokenHash), this.o.keys.userIndexByTag(userTag), this.o.keys.securityVersionByTag(userTag)],
        [tokenHash],
      );
    } catch (error) { throw new SessionStorageError('Session record unavailable', error); }
    const [raw, indexed, securityVersion, serverSeconds] = result as [string | null, number, string | null, string];
    if (!raw) { await this.safeDel(this.o.keys.tokenIndex(tokenHash)); return null; }
    const record = this.o.serializer.deserialize(raw);
    // The set read is under the locator's tag and token hash, so it is this record's membership only if both are the record's own.
    const ownKeys = record.id === tokenHash && this.o.keys.userTag(record.userId) === userTag;
    return { record, raw, indexed: indexed === 1 && ownKeys, securityVersion, serverSeconds: Number(serverSeconds) };
  }

  /** Persists the current security version for a user, for the longer of their longest-lived session and one session ttl. */
  async setSecurityVersion(userId: string, version: number): Promise<void> {
    try { await this.o.scripts.eval('set_security_version', [this.o.keys.securityVersion(userId), this.o.keys.userIndex(userId)], [String(version), String(this.o.config.ttl * 1000)]); }
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

  /** Consumes a predecessor session for rotation; of any number of concurrent callers, exactly one succeeds. */
  async consume(record: SessionRecord, serverSeconds: number, tombstoneTtl: number): Promise<void> {
    await this.change(record, stored => {
      if (isRecord(stored) && stored.status === 'consumed') throw new SessionReplayError();
      if (!isRecord(stored) || stored.status === 'revoked' || hasExpired(stored, serverSeconds)) throw new SessionRotationError('Session cannot be rotated');
      return { result: undefined, replacement: { ...stored, status: 'consumed', consumedAt: serverSeconds, version: stored.version + 1 }, ttl: Math.max(1, tombstoneTtl) };
    });
    try { await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id); }
    catch (error) { throw new SessionStorageError('Session index cleanup failed', error); }
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
   */
  async revoke(record: SessionRecord, serverSeconds: number, tombstoneTtl: number): Promise<void> {
    const key = this.o.keys.session(record.userId, record.id);
    const { stored } = await this.load(key);
    if (stored === 'unreadable') throw new SessionStorageError('Session revocation failed');
    // Only the call that writes the tombstone cuts the locator; a later one would let it outlive the tombstone.
    const revokesNow = stored !== 'missing' && stored.status !== 'revoked';
    if (revokesNow) {
      const revoked = this.o.serializer.serialize({ ...stored, status: 'revoked', version: stored.version + 1 });
      try {
        if (tombstoneTtl < 1) await this.o.redis.del(key);
        else await this.o.redis.set(key, revoked, 'XX', 'EX', String(tombstoneTtl));
      } catch (error) { throw new SessionStorageError('Session revocation failed', error); }
    }
    try { await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id); }
    catch (error) { throw new SessionStorageError('Session index cleanup failed', error); }
    if (revokesNow) await this.expireLocator(record.id, tombstoneTtl);
  }

  /** Removes the authoritative record and derived index entries. */
  async destroy(record: SessionRecord): Promise<void> {
    try {
      await this.o.redis.del(this.o.keys.session(record.userId, record.id));
      await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id);
      await this.o.redis.del(this.o.keys.tokenIndex(record.id));
    } catch (error) { throw new SessionStorageError('Session deletion failed', error); }
  }

  /**
   * Loads a bounded page of sessions and removes members whose record is gone from the user's session set. A record past
   * any of its expiries at `serverSeconds` is left out of the page. So is a record that cannot be decoded, which is kept in the set,
   * so a misconfigured key manager drops no session.
   */
  async list(userId: string, offset: number, limit: number, serverSeconds: number): Promise<SessionRecord[]> {
    const members = await this.o.redis.zrange(this.o.keys.userIndex(userId), offset, offset + limit - 1);
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
    if (stale.length) await this.o.redis.zrem(this.o.keys.userIndex(userId), ...stale);
    return records;
  }

  /**
   * Revokes a bounded batch and returns the number of indexed sessions remaining. The token locators live in other slots
   * and go first, through the cluster-aware delete; a credential without one already reads as not found. The records and
   * the user's session set share the user's slot, so they go after in one pipeline. A failure at either step throws, and
   * a retry finds the same batch still in the set.
   */
  async revokeAll(userId: string, limit: number): Promise<{ affected: number; remaining: number }> {
    const bounded = Math.min(Math.max(1, limit), this.o.config.maxBatchSize);
    const setKey = this.o.keys.userIndex(userId);
    const members = await this.o.redis.zrange(setKey, 0, bounded - 1);
    if (!members.length) return { affected: 0, remaining: 0 };
    try { await this.o.redis.del(...members.map(tokenHash => this.o.keys.tokenIndex(tokenHash))); }
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
      const result = await this.o.scripts.eval('replace_session', [key], [createHash('sha1').update(raw).digest('hex'), this.o.serializer.serialize(change.replacement), String(change.ttl)]);
      if (Number((result as unknown[])[0]) === 1) return change.result;
    }
    throw new SessionStorageError('Session is being changed by too many writers at once');
  }

  /** Reads what is stored under a session key, along with the raw value it was decoded from. */
  private async load(key: string): Promise<Loaded> {
    let raw: string | null;
    try { raw = await this.o.redis.get(key); }
    catch (error) { throw new SessionStorageError('Session record unavailable', error); }
    if (raw === null) return { raw, stored: 'missing' };
    try { return { raw, stored: this.o.serializer.deserialize(raw) }; }
    catch { return { raw, stored: 'unreadable' }; }
  }

  /** The user tag a token hash's locator names, or null when there is none. */
  private async locate(tokenHash: string): Promise<string | null> {
    try { return await this.o.redis.get(this.o.keys.tokenIndex(tokenHash)); }
    catch (error) { throw new SessionStorageError('Session token index unavailable', error); }
  }

  /**
   * Cuts a spent session's token locator to the life of its tombstone, so the credential keeps resolving to the tombstone
   * while it lasts and leaves nothing behind once it is gone. Best effort: a locator left longer resolves to a missing
   * record, which reads as not found and is deleted then.
   */
  private async expireLocator(tokenHash: string, tombstoneTtl: number): Promise<void> {
    const key = this.o.keys.tokenIndex(tokenHash);
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
