import { expect, it } from 'vitest';
import { describeOnEachTopology } from '../support/redis.js';

const WINDOW_SECONDS = 3600;

describeOnEachTopology('rate-limit windows against real Redis', redis => {
  async function serverSeconds(): Promise<number> { return Number((await redis.observer.time())[0]); }

  /** The end of the fixed window containing a moment, in Redis server time. */
  function windowEndAt(seconds: number): number { return (Math.floor(seconds / WINDOW_SECONDS) + 1) * WINDOW_SECONDS; }

  /** The end of the window a call made between `before` and `after` landed in; a window boundary between them would make it ambiguous. */
  function windowEndBetween(before: number, after: number): number {
    expect(windowEndAt(before), 'a window boundary passed during the call').toBe(windowEndAt(after));
    return windowEndAt(before);
  }

  function limiterOn(namespace: string, maxRequests = 5) {
    return redis.connectClient({ rateLimit: { enabled: true, namespace, windowSeconds: WINDOW_SECONDS, maxRequests } }).rateLimiter;
  }

  it('expires a window at its end when the first request costs more than one', async () => {
    const namespace = redis.newNamespace();
    const before = await serverSeconds();
    await limiterOn(namespace).consume('subject', 3);
    const windowEnd = windowEndBetween(before, await serverSeconds());

    const [key] = await redis.keysUnder(namespace);
    expect(Number(await redis.observer.call('EXPIRETIME', key!))).toBe(windowEnd);
  });

  it('reports the window end as resetAt', async () => {
    const before = await serverSeconds();
    const { resetAt } = await limiterOn(redis.newNamespace()).consume('subject');
    expect(resetAt).toBe(windowEndBetween(before, await serverSeconds()));
  });

  it('tells a denied request to retry no later than its window ends', async () => {
    const limiter = limiterOn(redis.newNamespace(), 1);
    await limiter.consume('subject');
    const before = await serverSeconds();
    const denied = await limiter.consume('subject');
    const windowEnd = windowEndBetween(before, await serverSeconds());

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(windowEnd - before);
  });

  it('reports the same window end from check() as from consume()', async () => {
    const limiter = limiterOn(redis.newNamespace(), 1);
    const consumed = await limiter.consume('subject');
    const checked = await limiter.check('subject');
    expect(checked).toMatchObject({ allowed: false, count: 1, resetAt: consumed.resetAt });
  });

  it('consumes in one round trip', async () => {
    const namespace = redis.newNamespace();
    const limiter = limiterOn(namespace);
    await limiter.consume('subject');
    expect(await redis.commandsFromClientsOf(namespace, () => limiter.consume('subject'))).toHaveLength(1);
  });

  it('writes only the key it declares to the script', async () => {
    const namespace = redis.newNamespace();
    const limiter = limiterOn(namespace);
    await limiter.consume('subject');
    const [script] = await redis.commandsFromClientsOf(namespace, () => limiter.consume('subject'));
    const declared = script!.slice(3, 3 + Number(script![2]));
    expect(await redis.keysUnder(namespace)).toEqual(declared);
    expect(declared).toEqual([limiter.key('subject')]);
  });

  it('starts a new count, with a TTL ending at the new window, when the stored window is not the current one', async () => {
    const namespace = redis.newNamespace();
    const limiter = limiterOn(namespace);
    await limiter.consume('subject', 4);
    const key = limiter.key('subject');
    await redis.observer.hset(key, 'window', '1');
    await redis.observer.persist(key);

    const before = await serverSeconds();
    expect(await limiter.consume('subject')).toMatchObject({ allowed: true, count: 1 });
    expect(Number(await redis.observer.call('EXPIRETIME', key))).toBe(windowEndBetween(before, await serverSeconds()));
  });

  it('checks a stored window that is not the current one as empty', async () => {
    const namespace = redis.newNamespace();
    const limiter = limiterOn(namespace, 1);
    await limiter.consume('subject');
    await redis.observer.hset(limiter.key('subject'), 'window', '1');
    expect(await limiter.check('subject')).toMatchObject({ allowed: true, count: 0 });
  });

  it('resets the current window in one round trip', async () => {
    const namespace = redis.newNamespace();
    const limiter = limiterOn(namespace, 1);
    await limiter.consume('subject');
    let reset = false;
    expect(await redis.commandsFromClientsOf(namespace, async () => { reset = await limiter.reset('subject'); })).toHaveLength(1);
    expect(reset).toBe(true);
    expect(await limiter.consume('subject')).toMatchObject({ allowed: true, count: 1 });
  });
});
