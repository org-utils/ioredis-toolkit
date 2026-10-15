// RED if ioredis neither closes nor settles a command within 3 s of connecting to a peer that accepts then drops.
// Usage: <node|bun> loop.mjs <destroy|reset> [delayMs]
import net from 'node:net';
import { createRequire } from 'node:module';
const { Redis } = createRequire(new URL('../../../package.json', import.meta.url))('ioredis');
const [mode = 'destroy', delay = '0'] = process.argv.slice(2);
const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const server = net.createServer(s => setTimeout(() => (mode === 'reset' ? s.resetAndDestroy() : s.destroy()), Number(delay)));
const external = mode.startsWith('docker:') ? Number(mode.slice(7)) : 0;
server.listen(0, '127.0.0.1', async () => {
  const t0 = Date.now(); const events = [];
  const redis = new Redis({ port: external || server.address().port, host: '127.0.0.1', retryStrategy: () => null, maxRetriesPerRequest: 0, ...JSON.parse(process.env.OPTS ?? '{}') });
  for (const e of ['connect', 'ready', 'close', 'end']) redis.on(e, () => events.push(`${e}@${Date.now() - t0}`));
  redis.on('error', e => events.push(`error(${e.code ?? e.message.slice(0, 30)})@${Date.now() - t0}`));
  // [DEBUG-d103] the socket ioredis holds: its own events, and its state when the verdict is taken.
  redis.once('connect', () => { const st = redis.stream; for (const e of ['end', 'close', 'finish', 'drain']) st.on(e, () => events.push(`sock.${e}@${Date.now() - t0}`)); st.on('error', e => events.push(`sock.error(${e.code})@${Date.now() - t0}`)); });
  const sockState = () => { const st = redis.stream; return st ? `| sock destroyed=${st.destroyed} readyState=${st.readyState} writableLength=${st.writableLength} writableNeedDrain=${st.writableNeedDrain} readableFlowing=${st.readableFlowing} readableEnded=${st.readableEnded} allowHalfOpen=${st.allowHalfOpen} pending=${st.pending}` : ''; };
  const ping = redis.ping().then(() => 'resolved', e => `rejected`);
  const verdict = await Promise.race([ping, new Promise(r => setTimeout(() => r('PENDING'), 3000))]);
  const red = verdict === 'PENDING' && !events.some(e => e.startsWith('close'));
  console.log(`${red ? 'RED  ' : 'GREEN'} ${runtime.padEnd(12)} peer=${mode}${delay !== '0' ? '+' + delay + 'ms' : ''} ping=${verdict} events: ${events.join(' ')} ${sockState()}`);
  process.exit(red ? 1 : 0);
});
