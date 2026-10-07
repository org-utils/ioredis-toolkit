import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectClient, eventually, redisFixture, redisUrl } from '../support/redis.js';

const DAY_MS = 86_400_000;

/** Skews this process's local clock as read through `Date.now()`, the way a host whose clock is wrong would see it. */
function skewLocalClock(byMs: number): void {
  const accurate = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => accurate() + byMs);
}

describe.skipIf(!redisUrl)('authoritative time against real Redis', () => {
  const redis = redisFixture();
  afterEach(() => { vi.restoreAllMocks(); });

  async function serverSeconds(): Promise<number> { return Number((await redis.observer.time())[0]); }

  describe('rate limiting', () => {
    /** A limiter as one application server would hold it; every call is a separate host on the same namespace. */
    function limiterOn(namespace: string) {
      return connectClient({ rateLimit: { enabled: true, namespace, windowSeconds: 3600, maxRequests: 2 } }).rateLimiter;
    }

    it('holds the limit across hosts whose local clocks disagree', async () => {
      const namespace = redis.newNamespace();
      const punctual = limiterOn(namespace);
      await punctual.consume('subject');
      await punctual.consume('subject');

      skewLocalClock(2 * DAY_MS);
      expect(await limiterOn(namespace).consume('subject')).toMatchObject({ allowed: false, count: 3, remaining: 0 });
      expect(await redis.keysUnder(namespace)).toHaveLength(1);
    });

    it('reports the window reset in server time', async () => {
      skewLocalClock(2 * DAY_MS);
      const before = await serverSeconds();
      const { resetAt } = await limiterOn(redis.newNamespace()).consume('subject');
      expect(resetAt).toBeGreaterThan(before);
      expect(resetAt).toBeLessThanOrEqual((await serverSeconds()) + 3600);
    });

    it('checks the window a host with a skewed clock shares with the others', async () => {
      const namespace = redis.newNamespace();
      await limiterOn(namespace).consume('subject');

      skewLocalClock(2 * DAY_MS);
      const before = await serverSeconds();
      const state = await limiterOn(namespace).check('subject');
      expect(state).toMatchObject({ allowed: true, count: 1, remaining: 1 });
      expect(state.resetAt).toBeGreaterThan(before);
      expect(state.resetAt).toBeLessThanOrEqual((await serverSeconds()) + 3600);
    });

    it('resets the window a host with a skewed clock shares with the others', async () => {
      const namespace = redis.newNamespace();
      await limiterOn(namespace).consume('subject');

      skewLocalClock(2 * DAY_MS);
      expect(await limiterOn(namespace).reset('subject')).toBe(true);
      expect(await redis.keysUnder(namespace)).toHaveLength(0);
    });
  });

  describe('sessions', () => {
    function sessionsWith(lifetime: { ttl: number; idleTimeout?: number; touchInterval?: number }) {
      return connectClient({ sessions: { enabled: true, namespace: redis.newNamespace(), ...lifetime } }).sessions;
    }

    it('stamps a session in server time on a host whose local clock is wrong', async () => {
      skewLocalClock(2 * DAY_MS);
      const before = await serverSeconds();
      const { session } = await sessionsWith({ ttl: 60 }).create({ userId: 'integration-user' });
      expect(session.createdAt).toBeGreaterThanOrEqual(before);
      expect(session.createdAt).toBeLessThanOrEqual(await serverSeconds());
      expect(session.expiresAt).toBe(session.createdAt + 60);
    });

    it('does not expire a session early when the local clock jumps past its expiry', async () => {
      const sessions = sessionsWith({ ttl: 60 });
      const { token } = await sessions.create({ userId: 'integration-user' });
      skewLocalClock(2 * DAY_MS);
      expect((await sessions.validate(token)).valid).toBe(true);
    });

    it('extends and rotates a session in server time on a host whose local clock is wrong', async () => {
      const sessions = sessionsWith({ ttl: 60, idleTimeout: 30, touchInterval: 0 });
      const { token } = await sessions.create({ userId: 'integration-user' });
      skewLocalClock(2 * DAY_MS);

      const before = await serverSeconds();
      await sessions.touch(token);
      const touched = await sessions.get(token);
      expect(touched.lastAccessedAt).toBeGreaterThanOrEqual(before);
      expect(touched.idleExpiresAt).toBeLessThanOrEqual((await serverSeconds()) + 30);

      const { session: successor } = await sessions.rotate(token);
      expect(successor.createdAt).toBeGreaterThanOrEqual(before);
      expect(successor.createdAt).toBeLessThanOrEqual(await serverSeconds());
    });

    it('does not keep an idle session alive when the local clock falls behind', async () => {
      const sessions = sessionsWith({ ttl: 60, idleTimeout: 1 });
      const { token } = await sessions.create({ userId: 'integration-user' });
      skewLocalClock(-2 * DAY_MS);
      await eventually(async () => expect(await sessions.validate(token)).toEqual({ valid: false, reason: 'idle_timeout' }));
    });
  });
});
