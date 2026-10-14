# Testing Matrix

The project separates deterministic unit/security tests from real Redis tests.

## What CI runs

1. TypeScript strict typecheck (`bun run typecheck`).
2. ESLint (`bun run lint`).
3. Unit tests (`tests/unit/`), with no Redis: configuration parsing and validation (`config`), cookie serialization (`cookie`), the error class and code of each failure decided before a command is sent (`errors`), client close and the `onError` hook (`lifecycle`), module configuration, enablement gating and namespace collisions (`modules`), a Pub/Sub subscribe on a lost connection failing without an unhandled error (`pubsub`), and the exports map, public surface and packed tarball described below.
4. One security suite (`tests/security/malformed-credential.test.ts`): a malformed credential validates as `invalid`, and `get()` of one throws `SessionInvalidError`. That the raw credential is never stored is checked against real Redis in `tests/integration/session.integration.test.ts`.
5. Concurrency tests (`tests/concurrency/`) against real Redis, in plain and encrypted storage: simultaneous updates at one version, touches, revoke under concurrent touches, and simultaneous rotation, including revoke of a consumed credential while its chain's end rotates.
6. Integration tests (`tests/integration/`) against standalone Redis and a 3-master Cluster: sessions (including `maxSessionsPerUser`), Pub/Sub (malformed-message dropping, one delivery per handler, concurrent subscribes), Streams, rate limiting, the convenience wrappers, Lua by cached SHA, authoritative time and client lifecycle.

`bun run test` runs layers 3-5 and `bun run test:integration` runs layer 6. `bun run test:watch` reruns the first set on change, and `bun run test:coverage` runs it with V8 coverage (text and HTML reports).

Not yet written: Sentinel failover tests (a Sentinel environment is supplied as a disposable Docker definition, `docker/sentinel.compose.yml`), Cluster tests with replicas, MOVED/ASK handling, resharding or node failure, load/performance tests, and concurrent `maxSessionsPerUser` tests.

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

## Test helpers

Besides the Redis fixture, `tests/support/` holds small helpers the suites share. `errors.ts` has `expectPackageError`, which asserts that an operation throws or rejects with a package error of a given class and code. `closed-port.ts` finds a loopback port with nothing listening, for clients whose Redis cannot be reached. `credential.ts` holds a credential of the right shape that names no session. `key-manager.ts` builds a key manager for encrypted storage. `hash-slot.ts` computes a key's Cluster hash slot from the specification, since a standalone server refuses `CLUSTER KEYSLOT`. `exports-map.ts` reads the manifest and its exports map, and builds TypeScript programs that resolve through them, for the subpath, public-surface and tarball suites and the configuration declarations check.

## The exports map

`tests/consumer/` holds one consumer per importable path: `root.ts` for the root, and a file named for each subpath. Each imports from that path alone, by the package's own name. `tests/unit/subpaths.test.ts` compiles them, so they resolve through the `exports` map in `package.json` to the source each target is built from. A subpath that stops resolving, or a name a consumer uses that its path stops exporting, fails that suite with the compiler's own message. The consumers compile against the source, not against the declarations a build emits. Adding a subpath means adding its consumer.

## The public surface

`tests/unit/public-surface.test.ts` lists, by hand, every name the root and each subpath export: the values that exist at runtime, and the names that exist only as types. It compares that list with what the root barrel and each entry point actually export, in both directions. The paths come from the exports map, so a subpath added there fails the suite until its surface is written. Exporting a new name fails the suite until the name is added to the list, so widening the public surface is a deliberate act, and a name [ADR-0003](https://github.com/org-utils/ioredis-toolkit/blob/main/docs/adr/0003-facade-only-public-surface.md) places internal has no line to go on. Removing or renaming a listed name fails it too, which is the prompt to write the changeset.

## The packed tarball

`tests/unit/packed-tarball.test.ts` packs the package the way a release does and compares the tarball with `package.json`. It copies the working tree to a temporary directory without `dist/` or `node_modules/`, runs the manifest's own `build` script there, and lists what `npm pack` would put in the tarball. Every entry of `files` must put at least one file in it, so an entry naming a directory that no longer exists fails. An entry starting with `!` excludes rather than publishes, so it is left out of that check. What the repository keeps under `docs/` for its own maintainers (`docs/agents/` and `docs/adr/`) must exist in the copy and be absent from the tarball. The suite lists those paths itself rather than reading the `!` entries, so dropping an exclusion from the manifest fails it. Every packed file must be the manifest itself or fall under an entry of `files`, so a file npm packs unasked, such as a licence, has to be listed. And every file the manifest points a consumer at (`main`, `types`, each target in the exports map) must be among them. The build runs in the copy, so the suite neither reads nor writes the `dist/` of the working tree, and it needs `npm` and `bun` on the path.

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
- stale token locators;
- stale members of the user's session set;
- Redis memory pressure;
- old backup restore scenarios.

Primary failure and promotion and cluster slot migration wait on the Sentinel and Cluster tests listed as not yet written under [What CI runs](#what-ci-runs).
