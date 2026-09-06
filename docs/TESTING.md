# Testing Matrix

The project separates deterministic unit/security tests from real Redis tests.

## Required CI layers

1. TypeScript strict typecheck.
2. ESLint.
3. Unit tests for token generation, hashing, key hashing, serializer, configuration, cookie serialization, and Pub/Sub message/error handling (connection error resilience, malformed-message dropping, subscribe/unsubscribe deduplication).
4. Security tests ensuring no raw-token persistence is part of the repository contract and invalid credentials fail closed.
5. Concurrency tests against real Redis for simultaneous touch, update, rotate, revoke, and max-session operations.
6. Standalone integration tests.
7. Sentinel integration tests with master/replica/Sentinel failover.
8. Cluster integration tests with multiple primaries/replicas, MOVED/ASK handling, resharding, and node failure.
9. Load/performance tests using bounded concurrency.

## Shared Redis safety

Tests must use a unique namespace per run. Never use `FLUSHALL` or `FLUSHDB` against a shared Redis deployment.

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
