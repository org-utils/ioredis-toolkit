import { describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { RedisClientWrapper } from '../../src/redis/wrapper.js';
import { SessionKeyStrategy } from '../../src/session/keys.js';
import { SessionSerializer } from '../../src/session/serializer.js';
import { SessionScriptRegistry } from '../../src/session/scripts.js';
import { SessionRepository } from '../../src/session/repository.js';
import { SessionService } from '../../src/session/service.js';
import { SessionTokenManager } from '../../src/session/token.js';
import { parseSessionConfig } from '../../src/session/config.js';

const url = process.env.REDIS_URL;

describe.skipIf(!url)('real Redis integration', () => {
  it('creates, validates, touches, rotates, revokes and destroys a session', async () => {
    const client = new Redis(url!);
    const redis = new RedisClientWrapper(client);
    const config = parseSessionConfig({ enabled: true, namespace: `test-${Date.now()}`, rolling: true, idleTimeout: 300, absoluteTimeout: 600 });
    const keys = new SessionKeyStrategy(config.namespace);
    const serializer = new SessionSerializer();
    const repository = new SessionRepository({ redis, keys, serializer, scripts: new SessionScriptRegistry(redis), config });
    const service = new SessionService({ repository, tokens: new SessionTokenManager(config.tokenBytes), redis, config });
    const created = await service.create({ userId: 'integration-user' });
    expect((await service.validate(created.token)).valid).toBe(true);
    await service.touch(created.token);
    const rotated = await service.rotate(created.token);
    expect((await service.validate(created.token)).valid).toBe(false);
    expect((await service.validate(rotated.token)).valid).toBe(true);
    await service.revoke(rotated.token);
    expect((await service.validate(rotated.token)).valid).toBe(false);
    await service.destroy(rotated.token);
    await client.quit();
  });
});
