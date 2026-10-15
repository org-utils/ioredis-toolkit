// Usage: <runtime> client.mjs <cluster|standalone> <port> [key]. Writes once, prints READY, waits while the host
// breaks the server, then reports whether a write completes within 30 s.
import { createRequire } from 'node:module';
const req = createRequire('/Users/macbookpro/work/web/packages/redis-session-kit/package.json');
const { Redis, Cluster } = req('ioredis');
const [topology, port, key = 'k'] = process.argv.slice(2);
const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const t0 = Date.now(); const log = [];
const client = topology === 'cluster' ? new Cluster([{ host: '127.0.0.1', port: Number(port) }]) : new Redis({ host: '127.0.0.1', port: Number(port) });
for (const e of ['close', 'reconnecting', 'connect', 'ready', 'end', '+node', '-node']) client.on(e, (...a) => log.push(`${e}${a[0]?.options ? '(' + a[0].options.port + ')' : ''}@${Date.now() - t0}`));
client.on('error', e => log.push(`error(${(e.code ?? e.message).slice(0, 30)})@${Date.now() - t0}`));
client.on('node error', (e, addr) => log.push(`node-error(${e.code ?? e.message.slice(0, 20)} ${addr})@${Date.now() - t0}`));
await client.set(key, 'before');
console.log(`READY ${runtime} ioredis ${req('ioredis/package.json').version}`);
log.length = 0;
await new Promise(r => setTimeout(r, Number(process.env.WAIT_MS ?? 2500)));
// Recovered = a write succeeds again. Each attempt gets 5 s; a rejected attempt is retried 500 ms later, until 30 s.
const sentAt = Date.now(); let attempts = 0, rejected = 0, pending = 0, result;
while (Date.now() - sentAt < 30_000) {
  attempts++;
  const outcome = await Promise.race([
    client.set(key, 'after').then(() => 'ok', () => 'rejected'),
    new Promise(r => setTimeout(() => r('pending'), 5_000)),
  ]);
  if (outcome === 'ok') { result = `RECOVERED: a write succeeded ${Date.now() - sentAt} ms after the first try (${attempts} attempts, ${rejected} rejected, ${pending} timed out)`; break; }
  if (outcome === 'rejected') rejected++; else pending++;
  await new Promise(r => setTimeout(r, 500));
}
result ??= `NOT RECOVERED within 30 s (${attempts} attempts, ${rejected} rejected, ${pending} timed out after 5 s each)`;
console.log(`RESULT ${runtime}: ${result}\nEVENTS ${log.slice(0, 16).join(' ')}${log.length > 16 ? ` …(${log.length - 16} more)` : ''}`);
process.exit(0);
