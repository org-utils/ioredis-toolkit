import { createServer, type AddressInfo } from 'node:net';

/** A loopback port with nothing listening on it. */
export function closedPort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
