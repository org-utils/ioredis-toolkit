import { connect, createServer, type AddressInfo, type Socket } from 'node:net';

/**
 * A TCP proxy in front of one Redis server that can lose a reply after Redis has run the command, as a dropped connection or
 * a failover after the write replicated would. ioredis then reconnects through the proxy and sends the command again.
 */
export interface ReplyDroppingProxy {
  /** The loopback port the proxy listens on. */
  readonly port: number;
  /** How many replies the proxy has lost so far. */
  readonly repliesDropped: number;
  /**
   * Lets the next command whose bytes contain `marker` reach Redis, then drops its connection once Redis answers, before the
   * answer reaches the client. Only that command is affected: the client's next connection passes everything through.
   */
  dropReplyTo(marker: string): void;
  /** Closes every connection through the proxy, and the proxy. */
  close(): Promise<void>;
}

/** Starts a {@link ReplyDroppingProxy} to `host:port` on an ephemeral loopback port. */
export async function replyDroppingProxy(host: string, port: number): Promise<ReplyDroppingProxy> {
  let marker: string | undefined;
  let repliesDropped = 0;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };

  const server = createServer(client => {
    const upstream = connect(port, host);
    track(client);
    track(upstream);
    let dropNextReply = false;
    client.on('data', chunk => {
      upstream.write(chunk);
      if (marker !== undefined && chunk.includes(marker)) { marker = undefined; dropNextReply = true; }
    });
    upstream.on('data', chunk => {
      if (!dropNextReply) { client.write(chunk); return; }
      // Redis has answered, so it has run the command: the answer is what goes missing.
      repliesDropped += 1;
      client.destroy();
      upstream.destroy();
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => {});
    upstream.on('error', () => {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    get repliesDropped() { return repliesDropped; },
    dropReplyTo(next) { marker = next; },
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
