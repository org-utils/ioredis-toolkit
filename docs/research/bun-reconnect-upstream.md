# Is the Bun reconnect hang already known upstream?

Research for [Is the Bun reconnect hang already known upstream?](https://github.com/org-utils/ioredis-toolkit/issues/104), part of [Map: this package's position on Bun](https://github.com/org-utils/ioredis-toolkit/issues/102). The evidence being matched is in [Under Bun, an ioredis Sentinel client never recovers from a failover](https://github.com/org-utils/ioredis-toolkit/issues/101).

Versions seen there: Bun 1.3.10, ioredis 5.11.1, Node 24.14.0, macOS (Docker Desktop).
Researched 2026-10-15. This was reading only: no repro scripts or Docker runs.

## Answer

**Neither tracker has an exact match.** No issue in oven-sh/bun or redis/ioredis reports an ioredis client (Sentinel or otherwise) that reaches `connect` after a reconnect and then never emits `ready`, `close` or `error` under Bun.

**The underlying Bun `node:net` behaviour is known, and it was changed in Bun 1.4.0.** On Bun 1.3.x, the client-socket close handler in `node:net` drops the error the native layer passes with the close. It only pushes EOF (`'end'`, then `'close'`). It also does not fail a write still parked waiting for drain, and a parked write stops `'close'` from ever being emitted. Bun 1.4.0 (released 2026-08-20) turns a reset delivered with the close into `read ECONNRESET` when an `'error'` listener is attached, as Node does. It also fails the parked write. Related teardown differences are still open on Bun 1.4.3.

**Nothing upstream blames ioredis.** ioredis has no Bun-specific report. Its connection logic relies on the socket emitting `'close'`, and Node always emits it.

Bun 1.3.10 is seven releases behind the current Bun (1.4.3, 2026-10-10). The cheapest next step is to rerun the #101 repro on Bun ≥ 1.4.0. That is an experiment for another ticket.

## Matching and related upstream items

### A. ioredis under Bun (oven-sh/bun)

| Item | State | Relevance |
| --- | --- | --- |
| [Redis : Can't auto reconnect a restarted server](https://github.com/oven-sh/bun/issues/6011) (Bun 1.0.3, macOS) | closed 2024-11-13, "Looks like this was fixed at some point in the past" | The closest older report: ioredis `ping()` hangs after Redis restarts. It was closed with no fix identified and no version given. |
| [Some events from the Net module are not being triggered as expected.](https://github.com/oven-sh/bun/issues/6681) (Bun 1.0.7) | closed 2024-06-04 | ioredis `end` and raw `net` `connect`/`end` missing. Bun's events have been rewritten since, so this only matters as history. |
| [node-redis and ioredis events is not working.](https://github.com/oven-sh/bun/issues/6652) | closed 2023-10-22 by the reporter ("restarted WSL") | Not a Bun bug. |
| [net.createConnection with localhost doesn't use Happy Eyeballs, causing third-party libraries (postgres.js, ioredis) to hang on dual-stack systems](https://github.com/oven-sh/bun/issues/28596) (Bun 1.3.11) | closed 2026-03-26 | A different mechanism (`localhost` resolving to `::1`). #101 uses `127.0.0.1`, so it does not apply. |

Searches for `ioredis` together with reconnect, hang, sentinel, close, ready, ECONNRESET, pending and stuck found nothing else that involves ioredis's connection lifecycle. The other hits are about Bun's own `Bun.redis` client. That includes [RedisClient: support Redis Sentinel (master discovery + failover following)](https://github.com/oven-sh/bun/issues/38515) (open), which has nothing to do with ioredis.

### B. Bun `node:net`: a peer reset reported as `'end'`/`'close'` with no `ECONNRESET`

This is the socket-table row in #101 ("server accepts, then destroys the socket": Node `error(ECONNRESET)`, Bun `end`, `close`).

- **The Bun 1.3.10 source shows it directly.** In `src/js/node/net.ts` at `bun-v1.3.10`, the client handler `SocketHandlers2.close(socket, err)` never uses `err`. It sets `kended`, then `push(null); read(0)` ([net.ts L537–L548 @ bun-v1.3.10](https://github.com/oven-sh/bun/blob/bun-v1.3.10/src/js/node/net.ts#L537-L548), with the comment `// TODO: should we be doing something with err?`). So a reset reported with the close comes out as a clean EOF: `'end'`, then `'close'`. That handler is also the only teardown path, and it does not touch `kwriteCallback`.
- **It was fixed in Bun 1.4.0.** At `bun-v1.4.0` and `bun-v1.4.3`, the same handler destroys the socket with a Node-shaped `read ECONNRESET` when the close carries an error and the socket has an `'error'` listener ([net.ts L1563 @ bun-v1.4.3](https://github.com/oven-sh/bun/blob/bun-v1.4.3/src/js/node/net.ts#L1563)). ioredis attaches one with `stream.once("error", …)`. The handler also fails a parked write with `ERR_SOCKET_CLOSED`. I checked the release tags directly: the TODO is still present at `bun-v1.3.14`, and the new code is first present at `bun-v1.4.0`.
  - The change came with [net,tls: port Node.js net/tls compatibility tests and fix the gaps they surface …](https://github.com/oven-sh/bun/pull/31155) (merged 2026-06-17). Its "Close-time read errors" bullet reads: "a reset delivered with the close destroys the socket with Node's `read ECONNRESET` shape when an error listener is attached". The compare API puts its merge commit after `bun-v1.3.14` and in `bun-v1.4.0`.
  - The server-socket equivalent is listed in [List of breaking changes for 1.4](https://github.com/oven-sh/bun/issues/28792): "`net` / `tls` server sockets: a peer reset that arrives while data is still unread is reported as an `'error'` with `ECONNRESET`, like Node; previously the socket emitted `'end'` (#39600)".
- **Some differences are still open on 1.4.3.**
  - [node:net, node:tls: socket teardown events that still differ from Node (spurious 'end', ERR_SOCKET_CLOSED in place of the real error)](https://github.com/oven-sh/bun/issues/43381) (open, labels `bug,node:net`). On 1.4.3-canary, `destroy()` emits `'end'` before `'close'`. With a write in flight and no `'error'` listener, a reset surfaces as `ERR_SOCKET_CLOSED` instead of `ECONNRESET`. A reset on a socket that is not reading is reported via read and not via the write. Its fix PR, [node:net: keep 'end' off a destroyed socket and report the read error behind a write in flight](https://github.com/oven-sh/bun/pull/43392), is open and unmerged.
  - [net: report the real connect errno instead of fabricated ECONNRESET/ECONNREFUSED](https://github.com/oven-sh/bun/pull/37093) and [net: report the real connect errno](https://github.com/oven-sh/bun/pull/39579) are both open PRs. They cover the opposite direction: a peer that accepts and closes before the first loop turn is reported as a failed connect.
  - [usockets: keep connect()'s answer; a peer's early close is not a failed connect](https://github.com/oven-sh/bun/pull/44452) (open PR) covers the same thing for unix sockets.
- **There is a `Bun.connect` counterpart.** [Bun.connect: native write() returns -1 (not raw -errno) on a peer RST and close carries ECONNRESET](https://github.com/oven-sh/bun/pull/36422) shows a peer RST during a write burst being reported as `end` + `close(undefined)`. That PR was closed unmerged on 2026-09-13 in a stale-PR cleanup. It covers `Bun.connect`, not `node:net`.

### C. Bun `node:net`: `'close'` never emitted after the peer goes away

This is the shape of the #101 client trace: `connect`, and then nothing.

- **[The 'node::net' module correctly emitted events.](https://github.com/oven-sh/bun/issues/24808)** (Bun 1.3.2, title as filed): after the peer dies, the surviving socket never gets `'end'` or `'close'`. **Closed 2026-07-24, verified fixed on `1.4.0-debug`**: "The server-side socket now emits `close` (preceded by `error ECONNRESET` …)".
- **[net: emit 'close' when a backpressured socket's peer dies](https://github.com/oven-sh/bun/pull/31654)** gives the mechanism. `net.Socket` emits `'close'` only from `_destroy`, and autoDestroy waits for **both** halves to finish. The PR names two stuck halves:
  - a write parked toward a dead peer, so the writable side never finishes;
  - a paused readable whose EOF is never consumed.

  The PR was closed because the fix "has since landed on main through other work": #31155 (close path, and a write callback still waiting on drain "is failed instead of holding the writable side open") and [#32630](https://github.com/oven-sh/bun/pull/32630) (the `read(0)` kick after `push(null)`). The compare API shows both merge commits are in `bun-v1.4.0` and not in `bun-v1.3.14`.
- **[fix(net): destroy socket on native close to prevent server.close() hang](https://github.com/oven-sh/bun/pull/28350)** (open PR, filed against 1.3.x) describes the same zombie state: "`_handle=null`, `destroyed=false`" after the native close. It references [Bun does not exit if `net.Socket` end (FIN) from the other side](https://github.com/oven-sh/bun/issues/13184) (closed), [Bun hangs on a closed express server, Node.js works](https://github.com/oven-sh/bun/issues/19563) (closed) and [Bun process hangs when using `Supertest`with `Express` — does not exit after test completion](https://github.com/oven-sh/bun/issues/23648) (open).
- **There is a macOS-specific item.** [usockets: deliver peer teardown to kqueue sockets that lost their read filter](https://github.com/oven-sh/bun/pull/37153) is stacked on [usockets: stop spinning on a half-open socket whose peer resets behind pending writes (kqueue)](https://github.com/oven-sh/bun/pull/37077). It says that on kqueue, once a half-open socket has consumed the peer's FIN, a later RST "produces **no kevent at all** … and the socket strands forever". Merged 2026-08-07; in `bun-v1.4.0`.
- [fix(net): schedule close events independently of user timers](https://github.com/oven-sh/bun/pull/44366) (open PR) covers `'close'` stranding when `setImmediate` is replaced. #101 does not replace timers, so it does not apply.

### D. Bun `node:net`: socket state (`connecting`, `destroyed`, `pending`, `readyState`)

- On 1.3.x, `readyState` is derived only from `connecting`, `readable` and `writable` ([net.ts L1264–L1272 @ bun-v1.3.10](https://github.com/oven-sh/bun/blob/bun-v1.3.10/src/js/node/net.ts#L1264-L1272)). `connecting` is also cleared in the `drain` handler, not only on open.
- [node:net: don't flip socket.pending back to true on a live socket after a peer half-close](https://github.com/oven-sh/bun/pull/33259): a live socket's `pending` flips to `true` because the native close callback nulls `_handle` early. Closed unmerged (stale) on 2026-09-13.
- #28350 (above): `destroyed === false` with `_handle === null` after a native close.
- [net: fire socket.setTimeout() while the socket is still connecting](https://github.com/oven-sh/bun/pull/42399) (open PR): `setTimeout()` never fires while connecting if a write is queued. This matters for ioredis's `connectTimeout`, which uses `stream.setTimeout` while `stream.connecting`. It does not apply to #101, where the connect succeeds.
- [fix(net): preserve connecting=false set synchronously by connect({fd})](https://github.com/oven-sh/bun/pull/31445) (open PR) is Windows and fd-only, so it does not apply.

### E. ioredis (redis/ioredis)

The ioredis tracker has only two issues mentioning Bun: [Issue with authenciation](https://github.com/redis/ioredis/issues/1992) (a NOAUTH env-loading problem) and ["disconnect" does not emit "end" event](https://github.com/redis/ioredis/issues/1830). Neither concerns reconnection. Related reconnect hangs that are not tied to a runtime:

| Item | State | Relevance |
| --- | --- | --- |
| [Client waiting endlessly for info from unresponsive server](https://github.com/redis/ioredis/issues/634) | open (pinned) | By design, ioredis has no timer between `connect` and `ready`. If the socket stays silent and never closes, the ready check waits forever. This explains why a socket that never emits `'close'` turns into a permanent hang. |
| [Sometimes the connection is not reestablished when enableReadyCheck is false](https://github.com/redis/ioredis/issues/2099) | closed; fix [#2123](https://github.com/redis/ioredis/pull/2123) **released in ioredis 6.0.0**, not in 5.11.1 | Applies only with `enableReadyCheck: false`. #101 uses the default (`true`). |
| [Command promise never settles after reconnect when autoResendUnfulfilledCommands is false](https://github.com/redis/ioredis/issues/2193) | closed 2026-09-14 (6.x line) | A different trigger: a non-default option. |
| [socketTimeout timer survives reconnect and destroys the replacement stream](https://github.com/redis/ioredis/issues/2147) | closed, released | Shows that `socketTimeout` exists in 5.11.1 (see Implications). |
| [Sentinel failover not detected when connection hangs](https://github.com/redis/ioredis/issues/1314) | closed 2021 (added `+switch-master` failover detection) | Background on how ioredis Sentinel recovers. |

## Implications for #101 (unverified, from reading source)

- **ioredis only reacts to the stream's `'close'` and `'error'`.** In 5.11.1, `_connect` attaches `stream.once("error")` and `stream.once("close")` and nothing for `'end'` (`built/Redis.js` L211–L212). After `connect`, `connectHandler` writes `CLIENT SETINFO` ×2 and the `INFO` ready check, then waits. No timer runs unless `socketTimeout` is set. Reconnection is driven only from `closeHandler`.
- **A plausible path to the #101 trace on Bun 1.3.10.** One of those handshake writes is accepted by Bun's `_write` but not flushed (`$write` returns false), so its callback is parked in `kwriteCallback`. Then the peer drops. The 1.3.10 close handler pushes EOF but neither fails the parked write nor destroys the socket. The writable half never finishes, so autoDestroy never runs, `'close'` is never emitted, and ioredis waits forever. This is the "write backpressure toward a dead peer" shape that #31654 and #24808 describe, fixed in 1.4.0. It would also explain why the raw `net.connect` + `PING` test in #101 still saw `'close'`. **This hypothesis is unverified, and it belongs to the root-cause ticket.**
- **Which component is at fault: upstream evidence points at Bun's `node:net` and not at ioredis.** ioredis is relying on Node's contract that a socket always ends with `'close'`.
- **Cheap checks for the experiment tickets:**
  1. Rerun the #101 repro on Bun ≥ 1.4.0 (1.4.3 is current).
  2. On 1.3.10, log `stream.writableLength`, `stream.writableFinished`, `stream.destroyed` and `stream.readyState` after `'end'` to confirm the stuck writable half.
  3. Try ioredis `socketTimeout` as a mitigation. Its timer calls `stream.destroy(err)`, and Bun emits `'close'` for that.

## Method

- **Searches** (2026-10-15) used the GitHub issue search API (`gh api search/issues`), issues and PRs, open and closed.
  - **oven-sh/bun:** ioredis plus reconnect, hang, sentinel, close, ready, ECONNRESET, pending, stuck; bullmq; `node:net` ECONNRESET, end, close; socket close not emitted; the `connecting`, `destroyed` and `readyState` properties; reset by peer; `is:issue` variants.
  - **redis/ioredis:** bun, deno, sentinel failover hang/stuck, reconnect without ready, close not emitted, `stream.connecting`, docker sentinel.
  - **taskforcesh/bullmq:** bun reconnect/hang. Nothing relevant beyond Node-side Sentinel items.
- **Release inclusion** was checked with `gh api repos/oven-sh/bun/compare/<tag>...<merge sha>` and the equivalent for ioredis, not inferred from dates.
- **Source** was read from `src/js/node/net.ts` at tags `bun-v1.3.10`, `bun-v1.3.14`, `bun-v1.4.0` and `bun-v1.4.3`, and from ioredis 5.11.1 `built/` in this repo's `node_modules`.
