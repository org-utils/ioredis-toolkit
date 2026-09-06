import type { RedisClientWrapper } from '../redis/wrapper.js';
import { SessionReplayError, SessionRotationError, SessionStorageError } from './errors.js';
import type { SessionConfig } from './config.js';
import type { SessionKeyStrategy } from './keys.js';
import type { SessionRecord } from './types.js';
import { SessionScriptRegistry } from './scripts.js';
import { SessionSerializer } from './serializer.js';

/** Dependencies required by the session repository. */
export interface SessionRepositoryOptions { redis: RedisClientWrapper; keys: SessionKeyStrategy; serializer: SessionSerializer; scripts: SessionScriptRegistry; config: SessionConfig; }

/** Persistence boundary for authoritative session state and derived indexes. */
export class SessionRepository {
  /** Creates the repository using shared Redis infrastructure and versioned serializers/scripts. */
  constructor(private readonly o: SessionRepositoryOptions) {}

  /** Persists a session and its derived indexes using the repository's authoritative write semantics. */
  async create(record: SessionRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil(record.expiresAt - record.createdAt));
    const result = await this.o.scripts.eval(
      'create_session',
      [this.o.keys.session(record.userId, record.id), this.o.keys.userIndex(record.userId)],
      [this.o.serializer.serialize(record), String(ttl), String(record.createdAt), record.id, String(this.o.config.maxSessionsPerUser), this.o.keys.getNamespace(), this.o.keys.userTag(record.userId)]
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

  /** Atomically updates rolling idle expiration when the touch interval permits it. */
  async touch(record: SessionRecord, now: number): Promise<'updated' | 'skipped' | 'invalid'> {
    const idleDuration = record.idleTimeoutSeconds ?? this.o.config.idleTimeout ?? this.o.config.ttl;
    const idle = record.idleExpiresAt === null ? 0 : Math.min(record.absoluteExpiresAt ?? Number.MAX_SAFE_INTEGER, now + idleDuration);
    const absolute = record.absoluteExpiresAt ?? 0;
    const result = await this.o.scripts.eval('touch_session', [this.o.keys.session(record.userId, record.id)], [String(now), String(this.o.config.touchInterval), String(idle), String(absolute)]);
    const code = Number((result as unknown[])[0]);
    if (code === 1) return 'updated';
    if (code === 2) return 'skipped';
    return 'invalid';
  }

  /** Atomically consumes a predecessor session for rotation. */
  async consume(record: SessionRecord, now: number, tombstoneTtl: number): Promise<void> {
    const result = await this.o.scripts.eval('consume_session', [this.o.keys.session(record.userId, record.id)], [String(now), String(Math.max(1, tombstoneTtl))]);
    const code = Number((result as unknown[])[0]);
    if (code === -1) throw new SessionReplayError();
    if (code !== 1) throw new SessionRotationError('Session cannot be rotated');
    try { await this.o.redis.zrem(this.o.keys.userIndex(record.userId), record.id); }
    catch (error) { throw new SessionStorageError('Session index cleanup failed', error); }
  }

  /** Applies a version-checked replacement to an authoritative session record. */
  async update(record: SessionRecord, replacement: SessionRecord, expectedVersion: number, now: number): Promise<void> {
    const result = await this.o.scripts.eval('update_session', [this.o.keys.session(record.userId, record.id)], [String(expectedVersion), String(now), this.o.serializer.serialize(replacement)]);
    const code = Number((result as unknown[])[0]);
    if (code === -2) throw new SessionStorageError('Session version conflict');
    if (code !== 1) throw new SessionStorageError('Session update failed');
  }

  /** Atomically marks a session revoked. */
  async revoke(record: SessionRecord, now: number, tombstoneTtl: number): Promise<void> {
    const result = await this.o.scripts.eval('revoke_session', [this.o.keys.session(record.userId, record.id)], [String(now), String(Math.max(0, tombstoneTtl))]);
    const code = Number((result as unknown[])[0]);
    if (code !== 1 && code !== 2 && code !== 0) throw new SessionStorageError('Session revocation failed');
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

  private async safeDel(key: string): Promise<void> { try { await this.o.redis.del(key); } catch { /* derived cleanup is best effort */ } }
}
