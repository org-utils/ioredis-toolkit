import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import type { RedisClient, RedisClientConfig } from '../../src/index.js';
import { replyDroppingProxy, type ReplyDroppingProxy } from '../support/reply-dropping-proxy.js';
import { describeOnEachTopology } from '../support/redis.js';

type ModuleSections = Pick<RedisClientConfig, 'lock' | 'rateLimit' | 'sessions'>;

/**
 * What a caller sees when Redis runs a command but its reply is lost, and ioredis sends the command again on the next
 * connection (`autoResendUnfulfilledCommands`, on by default). The proxy fronts a single server, so this runs on
 * standalone only: on Cluster ioredis follows the slot map to each node's own address, past the proxy.
 */
describeOnEachTopology('commands resent after a lost reply', redis => {
  describe.runIf(redis.topology === 'standalone')('through a proxy that loses one reply', () => {
    let proxy: ReplyDroppingProxy;
    const clients: RedisClient[] = [];
    beforeEach(async () => {
      const config = redis.connectionConfig();
      if (config.mode !== 'standalone') throw new Error('The reply-dropping proxy fronts a standalone server only');
      proxy = await replyDroppingProxy(config.host ?? '127.0.0.1', config.port ?? 6379);
    });
    afterEach(async () => {
      await Promise.all(clients.splice(0).map(client => client.close()));
      await proxy.close();
    });

    /** The client facade, connected through the proxy. */
    function clientThroughProxy(modules: ModuleSections): RedisClient {
      const { mode: _mode, ...connection } = redis.connectionConfig();
      void _mode;
      const client = createRedisClient({ ...connection, mode: 'standalone', host: '127.0.0.1', port: proxy.port, ...modules });
      clients.push(client);
      return client;
    }

    it('acquires a lock whose acquisition ran twice', async () => {
      const namespace = redis.newNamespace();
      const { lock } = clientThroughProxy({ lock: { enabled: true, namespace } });
      // Loads any script the acquisition runs, so the command whose reply is lost is the one that takes the lock.
      await lock.acquire('warm-up');

      proxy.dropReplyTo('contended');
      const { acquired, token } = await lock.acquire('contended');

      expect(proxy.repliesDropped).toBe(1);
      expect(acquired).toBe(true);
      expect(await redis.observer.get(lock.key('contended'))).toBe(token);
    });

    // The script that stores a session is the one command of a creation to name the user's session set, and the write
    // of its token locator the one to name a token locator.
    it.each([
      { step: 'the script that stores it', marker: 'user-sessions' },
      { step: 'the write of its token locator', marker: 'token-index' },
    ])('creates a session when $step ran twice', async ({ marker }) => {
      const { sessions } = clientThroughProxy({ sessions: { enabled: true, namespace: redis.newNamespace() } });
      // Loads the script a creation runs, so the command whose reply is lost is the one that stores the session.
      await sessions.create({ userId: 'warm-up' });

      proxy.dropReplyTo(marker);
      const { token } = await sessions.create({ userId: 'user' });

      expect(proxy.repliesDropped).toBe(1);
      expect((await sessions.validate(token)).valid).toBe(true);
      expect(await sessions.list('user')).toHaveLength(1);
    });

    // A known limitation, documented in docs/DEPLOYMENT.md: nothing tells a second run of a consumption from a second request.
    it('charges a subject twice for a consumption that ran twice', async () => {
      const { rateLimiter } = clientThroughProxy({ rateLimit: { enabled: true, namespace: redis.newNamespace(), windowSeconds: 3600, maxRequests: 5 } });
      // Loads the script a consumption runs, so the command whose reply is lost is the one that charges the subject.
      await rateLimiter.consume('warm-up');

      proxy.dropReplyTo('charged-subject');
      const { count } = await rateLimiter.consume('charged-subject');

      expect(proxy.repliesDropped).toBe(1);
      expect(count).toBe(2);
    });

    it('rotates a session when consuming its predecessor ran twice', async () => {
      const { sessions } = clientThroughProxy({ sessions: { enabled: true, namespace: redis.newNamespace() } });
      // Loads every script a rotation runs, so the command whose reply is lost is the one that consumes the predecessor.
      await sessions.rotate((await sessions.create({ userId: 'warm-up' })).token);
      const { token: predecessor } = await sessions.create({ userId: 'user' });

      // Only the write that consumes a session carries the time it was consumed.
      proxy.dropReplyTo('consumedAt');
      const rotated = await sessions.rotate(predecessor);

      expect(proxy.repliesDropped).toBe(1);
      expect((await sessions.validate(rotated.token)).valid).toBe(true);
      expect(await sessions.validate(predecessor)).toEqual({ valid: false, reason: 'consumed' });
    });
  });
});
