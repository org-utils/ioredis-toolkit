import { describe, expect, it } from 'vitest';
import { connectClient, redisFixture, redisUrl } from '../support/redis.js';

/** Asserts the commands ran Lua by its SHA and none of them carried Lua source: `eval` sends a script body with the call and `script` uploads one. */
function expectLuaBySha(commands: string[][]): void {
  const names = commands.map(([name]) => name!.toLowerCase());
  expect(names).toContain('evalsha');
  expect(names).not.toContain('eval');
  expect(names).not.toContain('script');
}

describe.skipIf(!redisUrl)('Lua by cached SHA against real Redis', () => {
  const redis = redisFixture();

  it('releases a lock without sending the script body once the server has it', async () => {
    const namespace = redis.newNamespace();
    const { lock } = connectClient({ lock: { enabled: true, namespace } });
    const first = await lock.acquire('a');
    await lock.release('a', first.token);

    const second = await lock.acquire('a');
    expectLuaBySha(await redis.commandsFromClientsOf(namespace, () => lock.release('a', second.token)));
    expect(await redis.keysUnder(namespace)).toEqual([]);
  });

  it('extends a lock without sending the script body once the server has it', async () => {
    const namespace = redis.newNamespace();
    const { lock } = connectClient({ lock: { enabled: true, namespace } });
    const { token } = await lock.acquire('a', 10);
    await lock.extend('a', token, 20);

    expectLuaBySha(await redis.commandsFromClientsOf(namespace, async () => { expect(await lock.extend('a', token, 60)).toBe(true); }));
    const [key] = await redis.keysUnder(namespace);
    expect(await redis.observer.ttl(key!)).toBeGreaterThan(20);
  });

  it('consumes from a rate-limit window without sending the script body once the server has it', async () => {
    const namespace = redis.newNamespace();
    const { rateLimiter } = connectClient({ rateLimit: { enabled: true, namespace, windowSeconds: 3600, maxRequests: 5 } });
    await rateLimiter.consume('a');

    expectLuaBySha(await redis.commandsFromClientsOf(namespace, async () => { expect(await rateLimiter.consume('a')).toMatchObject({ allowed: true, count: 2, remaining: 3 }); }));
  });

  it('creates and touches a session without sending a script body once the server has it', async () => {
    const namespace = redis.newNamespace();
    const { sessions } = connectClient({ sessions: { enabled: true, namespace, touchInterval: 0 } });
    const first = await sessions.create({ userId: 'integration-user' });
    await sessions.touch(first.token);

    expectLuaBySha(await redis.commandsFromClientsOf(namespace, async () => {
      const { token } = await sessions.create({ userId: 'integration-user' });
      await sessions.touch(token);
    }));
  });

  describe('when the server has evicted its scripts between calls', () => {
    it('still releases a lock only for its holder', async () => {
      const namespace = redis.newNamespace();
      const { lock } = connectClient({ lock: { enabled: true, namespace } });
      const first = await lock.acquire('a');
      await lock.release('a', first.token);

      const { token } = await lock.acquire('a');
      await redis.flushScriptCache();
      expect(await lock.release('a', 'not-the-holder')).toBe(false);
      expect(await redis.keysUnder(namespace)).toEqual([`${namespace}:a`]);
      await redis.flushScriptCache();
      expect(await lock.release('a', token)).toBe(true);
      expect(await redis.keysUnder(namespace)).toEqual([]);
    });

    it('still extends a lock', async () => {
      const namespace = redis.newNamespace();
      const { lock } = connectClient({ lock: { enabled: true, namespace } });
      const { token } = await lock.acquire('a', 10);
      await lock.extend('a', token, 20);

      await redis.flushScriptCache();
      expect(await lock.extend('a', token, 60)).toBe(true);
      const [key] = await redis.keysUnder(namespace);
      expect(await redis.observer.ttl(key!)).toBeGreaterThan(20);
    });

    it('still counts against the same rate-limit window, and goes back to sending only the SHA', async () => {
      const namespace = redis.newNamespace();
      const { rateLimiter } = connectClient({ rateLimit: { enabled: true, namespace, windowSeconds: 3600, maxRequests: 2 } });
      await rateLimiter.consume('a');

      await redis.flushScriptCache();
      expect(await rateLimiter.consume('a')).toMatchObject({ allowed: true, count: 2, remaining: 0 });
      expectLuaBySha(await redis.commandsFromClientsOf(namespace, async () => { expect(await rateLimiter.consume('a')).toMatchObject({ allowed: false, count: 3 }); }));
      expect(await redis.keysUnder(namespace)).toHaveLength(1);
    });

    it('still creates and touches a session', async () => {
      const { sessions } = connectClient({ sessions: { enabled: true, namespace: redis.newNamespace(), touchInterval: 0 } });
      await sessions.create({ userId: 'integration-user' });

      await redis.flushScriptCache();
      const { token } = await sessions.create({ userId: 'integration-user' });
      await redis.flushScriptCache();
      await sessions.touch(token);
      expect((await sessions.validate(token)).valid).toBe(true);
    });
  });
});
