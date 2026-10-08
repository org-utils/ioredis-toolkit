import { createHash } from 'node:crypto';
import type { RedisClientWrapper } from '../redis/index.js';
import { SessionReplayError, SessionRotationError, SessionStorageError } from './errors.js';
import type { SessionConfig } from './config.js';
import type { SessionKeyStrategy } from './keys.js';
import type { SessionRecord } from './types.js';
import { SessionScriptRegistry } from './scripts.js';
import { SessionSerializer } from './serializer.js';

/** Dependencies required by the session repository. */
export interface SessionRepositoryOptions { redis: RedisClientWrapper; keys: SessionKeyStrategy; serializer: SessionSerializer; scripts: SessionScriptRegistry; config: SessionConfig; }

/** What is stored under a session key: the record, nothing, or a value that cannot be decoded as a record. */
type Stored = SessionRecord | 'missing' | 'unreadable';

/** What a change does about the stored record: leaves it, or replaces it with a record that lives for `ttl` seconds. */
type Change<T> = { result: T } | { result: T; replacement: SessionRecord; ttl: number };

/** How many times a change is worked out again after another writer got there first. */
const MAX_CHANGE_ATTEMPTS = 32;

/** Persistence boundary for authoritative session state and derived indexes. */
export class SessionRepository {
  /** Creates the repository using shared Redis infrastructure and versioned serializers/scripts. */
  constructor(private readonly o: SessionRepositoryOptions) {}

  /** Persists a session and its derived indexes using the repository's authoritative write semantics. */
  async create(record: SessionRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil(record.expiresAt - record.createdAt));
    // create_session appends the token hash of each session it evicts to these two keys.
    const evictedSessionKey = this.o.keys.sessionByTag(this.o.keys.userTag(record.userId), '');
    const evictedTokenIndexKey = this.o.keys.tokenIndex('');
    const result = await this.o.scripts.eval(
      'create_session',
      [this.o.keys.session(record.userId, record.id), this.o.keys.userIndex(record.userId)],
      [this.o.serializer.serialize(record), String(ttl), String(record.createdAt), record.id, String(this.o.config.maxSessionsPerUser), evictedSessionKey, evictedTokenIndexKey]
    );
    const code = Number((result as unknown[])[0]);
    if (code !== 1) throw new SessionStorageError('Session creation failed');
    let indexed: string | null;
    try { indexed = await this.o.redis.set(this.o.keys.tokenIndex(record.id), this.o.keys.userTag(record.userId), 'EX', String(ttl), 'NX'); }
    catch (error) { throw new SessionStorageError('Session token index write failed', error); }
    if (indexed !== 'OK') {
      await this.safeDel(this.o.keys.session(record.userId, record.id));
      try { await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id); } catch { /* best effort */ }
      throw new SessionStorageError('Session token index already occupied');
    }
  }

  /** Resolves a token hash through the secondary locator and then reads the authoritative session record. */
  async resolve(tokenHash: string): Promise<SessionRecord | null> {
    let userTag: string | null;
    try { userTag = await this.o.redis.get(this.o.keys.tokenIndex(tokenHash)); }
    catch (error) { throw new SessionStorageError('Session token index unavailable', error); }
    if (!userTag) return null;
    let raw: string | null;
    try { raw = await this.o.redis.get(this.o.keys.sessionByTag(userTag, tokenHash)); }
    catch (error) { throw new SessionStorageError('Session record unavailable', error); }
    if (!raw) { await this.safeDel(this.o.keys.tokenIndex(tokenHash)); return null; }
    try { return this.o.serializer.deserialize(raw); }
    catch (error) { await this.safeDel(this.o.keys.sessionByTag(userTag, tokenHash)); throw error; }
  }

  /** Persists the current security version for a user. */
  async setSecurityVersion(userId: string, version: number): Promise<void> {
    try { await this.o.redis.set(this.o.keys.securityVersion(userId), String(version)); }
    catch (error) { throw new SessionStorageError('Security version update failed', error); }
  }

  /** Reads a user's security version. */
  async getSecurityVersion(userId: string): Promise<string | null> {
    try { return await this.o.redis.get(this.o.keys.securityVersion(userId)); }
    catch (error) { throw new SessionStorageError('Security version unavailable', error); }
  }

  /** Checks whether the session remains present in the user's derived index. */
  async isIndexed(record: SessionRecord): Promise<boolean> {
    try { return (await this.o.redis.zscore(this.o.keys.userIndex(record.userId), record.id)) !== null; }
    catch (error) { throw new SessionStorageError('Session index unavailable', error); }
  }

  /** Updates rolling idle expiration when the touch interval permits it. */
  async touch(record: SessionRecord, now: number): Promise<'updated' | 'skipped' | 'invalid'> {
    return this.change<'updated' | 'skipped' | 'invalid'>(record, (stored, attempt) => {
      if (!isRecord(stored) || stored.status !== 'active' || hasExpired(stored, now)) return { result: 'invalid' };
      if (now - stored.lastAccessedAt < this.o.config.touchInterval) return { result: 'skipped' };
      // A touch that lost the write to another touch at this same instant has nothing left to extend.
      if (attempt > 0 && stored.lastAccessedAt >= now) return { result: 'skipped' };
      const idleDuration = stored.idleTimeoutSeconds ?? this.o.config.idleTimeout ?? this.o.config.ttl;
      const idleExpiresAt = stored.idleExpiresAt === null ? null : Math.min(stored.absoluteExpiresAt ?? Number.MAX_SAFE_INTEGER, now + idleDuration);
      return { result: 'updated', replacement: { ...stored, lastAccessedAt: now, idleExpiresAt, version: stored.version + 1 }, ttl: stored.expiresAt - now };
    });
  }

  /** Consumes a predecessor session for rotation; of any number of concurrent callers, exactly one succeeds. */
  async consume(record: SessionRecord, now: number, tombstoneTtl: number): Promise<void> {
    await this.change(record, stored => {
      if (isRecord(stored) && stored.status === 'consumed') throw new SessionReplayError();
      if (!isRecord(stored) || stored.status === 'revoked' || hasExpired(stored, now)) throw new SessionRotationError('Session cannot be rotated');
      return { result: undefined, replacement: { ...stored, status: 'consumed', consumedAt: now, version: stored.version + 1 }, ttl: Math.max(1, tombstoneTtl) };
    });
    try { await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id); }
    catch (error) { throw new SessionStorageError('Session index cleanup failed', error); }
  }

  /** Applies a version-checked replacement to an authoritative session record. */
  async update(record: SessionRecord, replacement: SessionRecord, expectedVersion: number, now: number): Promise<void> {
    await this.change(record, stored => {
      if (!isRecord(stored) || stored.status !== 'active') throw new SessionStorageError('Session update failed');
      if (stored.version !== expectedVersion) throw new SessionStorageError('Session version conflict');
      const sameSession = replacement.userId === stored.userId && replacement.jti === stored.jti && replacement.id === stored.id
        && replacement.createdAt === stored.createdAt && replacement.absoluteExpiresAt === stored.absoluteExpiresAt;
      if (!sameSession || stored.expiresAt <= now) throw new SessionStorageError('Session update failed');
      return { result: undefined, replacement, ttl: stored.expiresAt - now };
    });
  }

  /**
   * Marks a session revoked. The write is unconditional, so no amount of concurrent writing can hold a
   * revocation off; every other change is conditional on the value it read, so none can undo one.
   */
  async revoke(record: SessionRecord, now: number, tombstoneTtl: number): Promise<void> {
    const key = this.o.keys.session(record.userId, record.id);
    const { stored } = await this.load(key);
    if (stored === 'unreadable') throw new SessionStorageError('Session revocation failed');
    if (stored !== 'missing' && stored.status !== 'revoked') {
      const revoked = this.o.serializer.serialize({ ...stored, status: 'revoked', version: stored.version + 1 });
      try {
        if (tombstoneTtl < 1) await this.o.redis.del(key);
        else await this.o.redis.set(key, revoked, 'XX', 'EX', String(tombstoneTtl));
      } catch (error) { throw new SessionStorageError('Session revocation failed', error); }
    }
    try { await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id); }
    catch (error) { throw new SessionStorageError('Session index cleanup failed', error); }
  }

  /** Removes the authoritative record and derived index entries. */
  async destroy(record: SessionRecord): Promise<void> {
    try {
      await this.o.redis.del(this.o.keys.session(record.userId, record.id));
      await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id);
      await this.o.redis.del(this.o.keys.tokenIndex(record.id));
    } catch (error) { throw new SessionStorageError('Session deletion failed', error); }
  }

  /** Loads a bounded page of sessions and cleans stale derived-index members. */
  async list(userId: string, offset: number, limit: number): Promise<SessionRecord[]> {
    const members = await this.o.redis.zrange(this.o.keys.userIndex(userId), offset, offset + limit - 1);
    if (!members.length) return [];
    const keys = members.map(tokenHash => this.o.keys.sessionByTag(this.o.keys.userTag(userId), tokenHash));
    const raw = await this.o.redis.mgetClusterAware(keys, { concurrency: this.o.config.maxConcurrency });
    const records: SessionRecord[] = [];
    const stale: string[] = [];
    raw.forEach((value, i) => {
      if (!value) { stale.push(members[i]!); return; }
      try { records.push(this.o.serializer.deserialize(value)); } catch { stale.push(members[i]!); }
    });
    if (stale.length) await this.o.redis.zrem(this.o.keys.userIndex(userId), ...stale);
    return records;
  }

  /** Revokes a bounded batch and returns the number of indexed sessions remaining. */
  async revokeAll(userId: string, limit: number): Promise<{ affected: number; remaining: number }> {
    const bounded = Math.min(Math.max(1, limit), this.o.config.maxBatchSize);
    const members = await this.o.redis.zrange(this.o.keys.userIndex(userId), 0, bounded - 1);
    if (!members.length) return { affected: 0, remaining: 0 };
    const userTag = this.o.keys.userTag(userId);
    const pipeline = this.o.redis.pipeline();
    for (const tokenHash of members) {
      pipeline.del(this.o.keys.sessionByTag(userTag, tokenHash));
      pipeline.del(this.o.keys.tokenIndex(tokenHash));
    }
    const results = await pipeline.exec();
    if (!results) throw new SessionStorageError('Redis pipeline unavailable');
    if (results.some(([error]) => error)) throw new SessionStorageError('One or more revokeAll operations failed');
    await this.o.redis.zrem(this.o.keys.userIndex(userId), ...members);
    const remaining = await this.o.redis.zcard(this.o.keys.userIndex(userId));
    return { affected: members.length, remaining };
  }

  /**
   * Changes a stored record without Redis having to decode it, so an encrypted record stays encrypted.
   * `decide` is given what is stored and answers with its replacement, which is written only if the
   * stored value is still the one `decide` saw; when another writer got there first, it decides again.
   */
  private async change<T>(record: SessionRecord, decide: (stored: Stored, attempt: number) => Change<T>): Promise<T> {
    const key = this.o.keys.session(record.userId, record.id);
    for (let attempt = 0; attempt < MAX_CHANGE_ATTEMPTS; attempt += 1) {
      const { raw, stored } = await this.load(key);
      const change = decide(stored, attempt);
      if (raw === null || !('replacement' in change)) return change.result;
      const result = await this.o.scripts.eval('replace_session', [key], [createHash('sha1').update(raw).digest('hex'), this.o.serializer.serialize(change.replacement), String(change.ttl)]);
      if (Number((result as unknown[])[0]) === 1) return change.result;
    }
    throw new SessionStorageError('Session is being changed by too many writers at once');
  }

  /** Reads what is stored under a session key, along with the raw value it was decoded from. */
  private async load(key: string): Promise<{ raw: string | null; stored: Stored }> {
    let raw: string | null;
    try { raw = await this.o.redis.get(key); }
    catch (error) { throw new SessionStorageError('Session record unavailable', error); }
    if (raw === null) return { raw, stored: 'missing' };
    try { return { raw, stored: this.o.serializer.deserialize(raw) }; }
    catch { return { raw, stored: 'unreadable' }; }
  }

  private async safeDel(key: string): Promise<void> { try { await this.o.redis.del(key); } catch { /* derived cleanup is best effort */ } }
}

function isRecord(stored: Stored): stored is SessionRecord { return typeof stored !== 'string'; }

/** Whether any of a record's expiries has passed at `now`. */
function hasExpired(record: SessionRecord, now: number): boolean {
  return record.expiresAt <= now
    || (record.absoluteExpiresAt !== null && record.absoluteExpiresAt <= now)
    || (record.idleExpiresAt !== null && record.idleExpiresAt <= now);
}
