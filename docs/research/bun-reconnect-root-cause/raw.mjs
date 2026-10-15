// RED if a raw socket never emits 'close' within 3 s. Usage: <node|bun> raw.mjs <port> <writeDelayMs|none> [writes]
import net from 'node:net';
const [port, delay, writes = '1'] = process.argv.slice(2);
const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const t0 = Date.now(); const seen = [];
const s = net.connect(Number(port), '127.0.0.1');
for (const e of ['connect', 'end', 'close']) s.on(e, () => seen.push(`${e}@${Date.now() - t0}`));
s.on('error', e => seen.push(`error(${e.code})@${Date.now() - t0}`));
s.on('connect', () => { if (delay === 'sync') { for (let i = 0; i < Number(writes); i++) s.write('PING\r\n'); seen.push(`write@${Date.now() - t0}`); return; } if (delay !== 'none') setTimeout(() => { for (let i = 0; i < Number(writes); i++) s.write('PING\r\n'); seen.push(`write@${Date.now() - t0}`); }, Number(delay)); });
setTimeout(() => {
  const red = !seen.some(e => e.startsWith('close'));
  console.log(`${red ? 'RED  ' : 'GREEN'} ${runtime.padEnd(12)} write=${delay === 'none' ? 'never' : delay === 'sync' ? 'in-connect' : '+' + delay + 'ms'} x${writes} ${seen.join(' ')} | writableFinished=${s.writableFinished} destroyed=${s.destroyed} writableLength=${s.writableLength} readyState=${s.readyState}`);
  process.exit(red ? 1 : 0);
}, 3000);
