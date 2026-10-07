import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createRedisClient } from '../../src/index.js';

/** A loopback port with nothing listening on it. */
function closedPort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe('Pub/Sub', () => {
  it('rejects values exceeding maxMessageBytes', async () => {
    const { pubsub } = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true, pubsub: { enabled: true, maxMessageBytes: 4 } });
    await expect(pubsub.publish('orders', { id: 1 })).rejects.toThrow(RangeError);
  });

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
