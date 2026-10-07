import { describe, expect, it, vi } from 'vitest';
import { createRedisClient } from '../../src/index.js';
import { closedPort } from '../support/closed-port.js';

describe('Pub/Sub', () => {
  it('fails a subscribe on a lost subscriber connection without an unhandled error event', async () => {
    // ioredis reports an 'error' event nobody listens for on console.error.
    const unhandled = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { pubsub } = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: await closedPort(), lazyConnect: true, retryStrategy: () => null, pubsub: { enabled: true } });
      await expect(pubsub.subscribe('orders', () => undefined)).rejects.toThrow();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      unhandled.mockRestore();
    }
  });
});
