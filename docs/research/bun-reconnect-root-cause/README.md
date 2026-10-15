# Why ioredis waits forever after `connect` under Bun

Findings for the wayfinder ticket "Why does ioredis wait forever after connect under Bun?" (org-utils/ioredis-toolkit#103).

## Cause

A bug in Bun's `node:net` before 1.4, independent of ioredis, Sentinel, Docker and the platform. When a socket writes more than once inside its `'connect'` handler and the peer closes the connection on accept, Bun 1.3.10 emits `'end'` but never flushes or fails the later writes. Those bytes stay in `writableLength`. With `allowHalfOpen: false`, a socket finishes, and so closes, only once its writable side has flushed, so `'finish'` and `'close'` never come and the socket is left with `destroyed: false` and `readyState: 'closed'`. Node fails the writes with `EPIPE`/`ECONNRESET` and closes. Bun 1.4.3 does the same as Node.

ioredis is not at fault. It drives reconnection from the stream's `'close'` and `'error'`, which Node's contract guarantees. Its connect handler writes two `CLIENT SETINFO` commands straight away, which is the trigger. With `disableClientInfo: true` there is one write and the hang goes away. Docker Desktop's port proxy is one such peer: it accepts a connection to a port with nothing behind it, then closes it. That is why the hang showed up after a Sentinel failover, when ioredis reconnected to the dead master's published port.

## Evidence

The raw reproduction (`raw.mjs`, two writes in `'connect'`, against `dropper.mjs`, a server that closes on accept), 3 runs each:

| Runtime | Platform | Result |
| --- | --- | --- |
| Bun 1.3.10 | macOS | hangs: `connect`, `end`, then nothing; `writableLength=6` |
| Bun 1.3.10 | Linux (`oven/bun:1.3.10`) | hangs |
| Bun 1.4.3 | Linux (`oven/bun:1.4.3`) | `error(EPIPE)`, `close` |
| Node 24 | macOS, Linux | `error(EPIPE` or `ECONNRESET)`, `close` |
| Bun 1.3.10 + `socket.destroy()` on `'end'` | macOS | `end`, `close` |

ioredis 5.11.1 (`loop.mjs`) under Bun 1.3.10, against a Docker-published port with nothing behind it:
- hangs 5/5 with defaults;
- recovers with `disableClientInfo: true`;
- still hangs with `enableReadyCheck: false`, `noDelay: false` or `keepAlive` unset.

## Running it

```sh
node dropper.mjs 6521 &                  # a peer that closes on accept
bun raw.mjs 6521 sync 2                  # RED on Bun 1.3.x: exits 1 and prints writableLength
node raw.mjs 6521 sync 2                 # GREEN
docker run --rm -v "$PWD":/w oven/bun:1.3.10 sh /w/linux-probe.sh bun   # the same on Linux
```
