import net from 'node:net';
const mode = process.argv[3] ?? 'destroy';
net.createServer(s => { s.on('error', () => {}); mode === 'reset' ? s.resetAndDestroy() : s.destroy(); }).listen(Number(process.argv[2]), '127.0.0.1');
