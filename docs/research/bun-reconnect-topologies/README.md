# Do Cluster failover and standalone restarts hang the same way under Bun?

Findings for the wayfinder ticket of that name (org-utils/ioredis-toolkit#106).

## Answer

No. Under Bun 1.3.10, ioredis 5.11.1 recovered in every Cluster and standalone case, including behind Docker Desktop's port proxy, the peer that makes the Sentinel client in #101 hang. Node behaves the same. Of the topologies tried, only Sentinel failover hangs.

"Recovered" means a write succeeds again. The client retries a `SET` every 500 ms, giving each attempt 5 s, for up to 30 s after the server is broken.

| Topology and trigger | Where the client runs | Bun 1.3.10 | Node 24 |
| --- | --- | --- | --- |
| Cluster: master 7101 killed, replica promoted in about 4 s | macOS host, behind Docker Desktop's proxy | recovered in 1.8 s, 2.0 s, 1.3 s (3 runs) | recovered in 1.9 s |
| Cluster: same | Linux container in the stack's namespace (dead port refuses) | recovered in 1.4 s | recovered in 1.1 s |
| Standalone: Redis shut down, back 3 s later, port still published | macOS host, behind Docker Desktop's proxy | recovered in 1.2 s, 1.1 s, 1.0 s (3 runs) | recovered in 1.1 s |
| Standalone: container stopped and started, port unbound meanwhile | macOS host | recovered in 3.8 s | recovered in 3.7 s |

## What the traces show

- **Standalone behind the proxy:** Bun reaches `connect` and then `close` on each retry against the dead port, with no error, and ioredis keeps reconnecting until Redis is back. The socket-level bug from #103 doesn't strand these reconnects.
- **Cluster:** ioredis drops and recreates its connection to the dead node about every 100 ms (`-node`/`+node`) and routes the write by slot to the promoted replica, so a connection to the dead master never blocks the write.

## Open

Why the Sentinel reconnect (#101) and a standalone *first* connect (#103's `loop.mjs`) reach the stuck write while these reconnects don't wasn't investigated. It matters only if Bun 1.4.x still hangs or a workaround is wanted.

## Running it

`run.sh <label> <compose> <host|ns> <bun|node> <kill-7101|shutdown|restart> <client args>`. It starts the stack, runs `client.mjs`, breaks the server when the client prints `READY`, and tears everything down. The host run uses a Bun 1.3.10 binary at a path specific to this machine; edit `run.sh` for yours.
