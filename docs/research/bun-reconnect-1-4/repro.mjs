// The reproduction from "Under Bun, an ioredis Sentinel client never recovers from a failover" (#101): plain ioredis on
// the host, behind Docker Desktop's port proxy. Kill the master, then see whether a SET completes within 20 s.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const req = createRequire('/Users/macbookpro/work/web/packages/redis-session-kit/package.json');
const { Redis } = req('ioredis');
const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const compose = `docker compose -p rsk-t108 -f ${process.env.COMPOSE}`;
const t0 = Date.now(); const log = [];
const redis = new Redis({ name: 'mymaster', sentinels: [26379, 26380, 26381].map(port => ({ host: '127.0.0.1', port })) });
for (const e of ['close', 'reconnecting', 'connect', 'ready', 'end']) redis.on(e, () => log.push(`${e}@${Date.now() - t0}`));
redis.on('error', e => log.push(`error(${(e.code ?? e.message).slice(0, 34)})@${Date.now() - t0}`));
await redis.set('k', 'before');
log.length = 0;
execSync(`${compose} kill redis-master`, { stdio: 'ignore' });
const killedAt = Date.now();
const result = await Promise.race([
  redis.set('k', 'after').then(() => `RECOVERED: SET completed ${Date.now() - killedAt} ms after the kill`, e => `SET rejected: ${e.message}`),
  new Promise(r => setTimeout(() => r('HANG: SET still pending 20 s after the kill'), 20_000)),
]);
const master = execSync(`${compose} exec -T sentinel redis-cli -p 26379 sentinel get-master-addr-by-name mymaster`).toString().trim().replace('\n', ':');
console.log(`${runtime} | ioredis ${req('ioredis/package.json').version} | ${result} | sentinel master now ${master}`);
console.log(`  events: ${log.slice(0, 14).join(' ')}${log.length > 14 ? ` …(${log.length - 14} more)` : ''}`);
process.exit(0);
