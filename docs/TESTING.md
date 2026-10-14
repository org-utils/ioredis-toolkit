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

## Real-Redis suites and topologies

The integration suites (`tests/integration/`) and the concurrency suites (`tests/concurrency/`) run against real Redis, through the public surface, observed by the fixture in `tests/support/redis.ts`. Each one is declared with `describeOnEachTopology`, so it runs once per topology the environment names, and each run's suite title ends with the topology it ran against:

| Topology | Variable | Example |
| --- | --- | --- |
| standalone | `REDIS_URL` | `redis://127.0.0.1:6379` |
| cluster | `REDIS_CLUSTER_NODES` | `127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003` |

A topology whose variable is unset is skipped, so with neither set these suites skip entirely. On Cluster the fixture lists keys, captures commands, counts subscribers and flushes the script cache on every node.

### Starting both topologies locally

```bash
docker compose -p rsk-standalone -f docker/standalone.compose.yml up -d
docker compose -p rsk-cluster -f docker/cluster.compose.yml up -d --wait

export REDIS_URL=redis://127.0.0.1:6379
export REDIS_CLUSTER_NODES=127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003
bun run test               # unit, security and concurrency suites
bun run test:integration   # integration suites

docker compose -p rsk-standalone -f docker/standalone.compose.yml down
docker compose -p rsk-cluster -f docker/cluster.compose.yml down
```

The cluster is three masters, without replicas, in one container. Each node announces `127.0.0.1` and its own port, so the addresses Redis hands out in `CLUSTER SLOTS` and in `MOVED`/`ASK` redirects reach the published ports from the host. Ports 6379 and 7001-7003 must be free.

CI (`.github/workflows/checks.yml`) runs lint, typecheck and both vitest configurations on every pull request and before every release, with standalone Redis as a service container and the cluster from the same compose file.

### Known failures on Cluster

A test that fails on Cluster because of a known, ticketed bug is declared with `redis.itFailsOnClusterUntil('#<ticket>', /what the failure says/, name, test)` instead of `it`. On standalone it is an ordinary test. On Cluster its title says which ticket it waits on, and it passes as long as the bug still shows: such bugs often show only when keys land on different masters or a race goes one way, so the body runs up to 32 times and the test passes at the first failure whose message, or a cause's, matches the pattern. Any other failure fails the test, so the mark hides only the bug it names. Once every attempt passes, the test fails and says to remove the mark, which is part of fixing the ticket.

## The exports map

`tests/consumer/` holds one consumer per importable path: `root.ts` for the root, and a file named for each subpath. Each imports from that path alone, by the package's own name. `tests/unit/subpaths.test.ts` compiles them, so they resolve through the `exports` map in `package.json` to the source each target is built from. A subpath that stops resolving, or a name a consumer uses that its path stops exporting, fails that suite with the compiler's own message. The consumers compile against the source, not against the declarations a build emits. Adding a subpath means adding its consumer.

## The public surface

`tests/unit/public-surface.test.ts` lists, by hand, every name the root and each subpath export: the values that exist at runtime, and the names that exist only as types. It compares that list with what the root barrel and each entry point actually export, in both directions. The paths come from the exports map, so a subpath added there fails the suite until its surface is written. Exporting a new name fails the suite until the name is added to the list, so widening the public surface is a deliberate act, and a name ADR-0003 places internal has no line to go on. Removing or renaming a listed name fails it too, which is the prompt to write the changeset.

## The packed tarball

`tests/unit/packed-tarball.test.ts` packs the package the way a release does and compares the tarball with `package.json`. It copies the working tree to a temporary directory without `dist/` or `node_modules/`, runs the manifest's own `build` script there, and lists what `npm pack` would put in the tarball. Every entry of `files` must put at least one file in it, so an entry naming a directory that no longer exists fails. An entry starting with `!` excludes rather than publishes, so it is left out of that check. What the repository keeps under `docs/` for its own maintainers (`docs/agents/` and `docs/ACCEPTANCE-REPORT.md`) must exist in the copy and be absent from the tarball. The suite lists those paths itself rather than reading the `!` entries, so dropping an exclusion from the manifest fails it. Every packed file must be the manifest itself or fall under an entry of `files`, so a file npm packs unasked, such as a licence, has to be listed. And every file the manifest points a consumer at (`main`, `types`, each target in the exports map) must be among them. The build runs in the copy, so the suite neither reads nor writes the `dist/` of the working tree, and it needs `npm` and `bun` on the path.

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

The real-Redis suites run against standalone Redis and a 3-master Cluster. A Sentinel environment is supplied as a disposable Docker definition; Sentinel failover and Cluster failover/resharding tests are not yet written.
