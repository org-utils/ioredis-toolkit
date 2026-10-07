import { describe, expect, it } from 'vitest';
import { createSessionManagerFromRedis, SessionError } from '../../src/index.js';
import { connectionConfig, redisFixture, redisUrl } from '../support/redis.js';

describe.skipIf(!redisUrl)('concurrent rotation', () => {
  const redis = redisFixture();

  it('lets exactly one of several simultaneous rotations of a credential succeed', async () => {
    const { manager } = createSessionManagerFromRedis(connectionConfig(), { enabled: true, namespace: redis.namespace() });
    const created = await manager.create({ userId: 'integration-user' });

    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => manager.rotate(created.token)));
    const successors = outcomes.flatMap(outcome => (outcome.status === 'fulfilled' ? [outcome.value] : []));
    const refusals = outcomes.flatMap(outcome => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []));

    expect(successors).toHaveLength(1);
    for (const refusal of refusals) expect(refusal).toBeInstanceOf(SessionError);
    expect((await manager.validate(successors[0]!.token)).valid).toBe(true);
    expect(await manager.validate(created.token)).toEqual({ valid: false, reason: 'consumed' });
  });
});
