# Does the Bun reconnect hang still happen on Bun 1.4.x?

Findings for the wayfinder ticket of that name (org-utils/ioredis-toolkit#108).

## Answer

No. On Bun 1.4.3 both paths that hang on Bun 1.3.10 recover the way they do on Node. ioredis is 5.11.1 throughout.

| Case | Bun 1.4.3 | Bun 1.3.10 (control) | Node 24.14.0 |
| --- | --- | --- | --- |
| Sentinel failover, client on the macOS host behind Docker Desktop's proxy (#101's reproduction, `repro.mjs`) | recovered in 2364, 2344, 2343 ms (3/3) | hangs: SET pending 20 s after the kill | recovered in 2355 ms |
| Standalone first connect to a dead published port (`loop.mjs` from the root-cause findings) | `EPIPE`, then `close` (3/3) | hangs after `connect` | (green in earlier runs) |

On Bun 1.4.3 the Sentinel trace matches Node's event for event: `close`, `reconnecting`, `connect`, `error(ECONNRESET)`, `close`, …, until `connect` and `ready` on the promoted replica `127.0.0.1:6381`. On 1.3.10 it stops at `connect`.

Only 1.4.3 was run. The upstream findings date the fix to 1.4.0, which wasn't run here.

## Running it

`run.sh <runtime binary>` brings up `docker/sentinel.compose.yml` (copied as `sentinel.compose.yml` next to it), runs `repro.mjs`, kills the master and tears the stack down.
