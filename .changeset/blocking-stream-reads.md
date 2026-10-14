---
"ioredis-toolkit": patch
---

A blocking stream read no longer stalls the rest of the client. `streams.read()` used to block on the one shared connection, so every session check, cache read, lock and rate-limit call waited behind it for up to `blockMs`, and forever with `blockMs: 0`. Each read now leases a connection of its own from a pool of duplicates that the Streams module grows on demand, and returns it afterwards. Concurrent reads on different streams wait side by side instead of queueing. `blockMs: 0` still means "wait indefinitely", now without freezing anything else.

`RedisClient.close()` disconnects the reader connections, so a read still waiting rejects at once. Errors on reader connections reach the `onError` hook with source `stream-reader`.

`streams.add()` with no fields now throws `StreamsError` with code `STREAMS_INPUT` without contacting Redis, instead of failing with a Redis argument error.
