# Testing Matrix

The project separates deterministic unit/security tests from real Redis tests.

## Required CI layers

1. TypeScript strict typecheck.
2. ESLint.
3. Unit tests for token generation, hashing, key hashing, serializer, configuration, cookie serialization, error codes, and Pub/Sub message/error handling (connection error resilience, malformed-message dropping, subscribe/unsubscribe deduplication).
4. Security tests ensuring no raw-token persistence is part of the repository contract and invalid credentials fail closed.
5. Concurrency tests against real Redis for simultaneous touch, update, rotate, revoke, and max-session operations.
6. Standalone integration tests.
7. Sentinel integration tests with master/replica/Sentinel failover.
8. Cluster integration tests with multiple primaries/replicas, MOVED/ASK handling, resharding, and node failure.
9. Load/performance tests using bounded concurrency.

## The exports map

`tests/consumer/` holds one consumer per importable path: `root.ts` for the root, and a file named for each subpath. Each imports from that path alone, by the package's own name. `tests/unit/subpaths.test.ts` compiles them, so they resolve through the `exports` map in `package.json` to the source each target is built from. A subpath that stops resolving, or a name a consumer uses that its path stops exporting, fails that suite with the compiler's own message. A name no consumer uses is not guarded, and the consumers compile against the source, not against the declarations a build emits. Adding a subpath means adding its consumer.

## Shared Redis safety

Tests must use a unique namespace per run. Never use `FLUSHALL` or `FLUSHDB` against a shared Redis deployment.

`SCRIPT FLUSH` is the one server-wide command the suites send: it is the only way to make a real server answer `NOSCRIPT`, which the cached-SHA tests need. It removes no stored data, and any client that runs Lua by SHA recovers by sending the source again. Two runs sharing one server can still disturb each other's cached-SHA assertions, so give each concurrent run its own Redis.

## Failure injection

Production verification should include:

- connection loss during reads;
- connection loss after a server-side write;
- primary failure and promotion;
- cluster slot migration;
- command-level pipeline errors;
- malformed session payloads;
- malformed cache/Pub-Sub payloads (non-JSON values written or published by a non-conforming client);
- stale token indexes;
- stale user-index members;
- Redis memory pressure;
- old backup restore scenarios.

The current archive includes the standalone real-Redis integration harness. Sentinel and Cluster environments are supplied as disposable Docker definitions; their failover/resharding tests should be exercised in CI where Docker networking and Redis administration are available.
