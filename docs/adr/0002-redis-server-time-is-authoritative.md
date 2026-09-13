# Redis server time is authoritative for shared state

Three clocks had accreted in the codebase: `session` used Redis server time via `redis.time()`, `rate-limit` used local `Date.now()` in four places including the window key, and `session/health.ts` used `performance.now()`. Nobody had decided this. We are standardising: anything that expires, buckets, or orders state shared across processes reads Redis server time, which is already exposed to every module by the kernel's command wrapper.

Local clocks remain correct for one job — measuring a duration within a single process — and `performance.now()` in health checks stays for exactly that reason. Timestamping shared state and measuring local latency are different jobs and the rule distinguishes them explicitly.

## Consequences

Each such operation costs a round-trip that `Date.now()` did not, which is the trade we are accepting. The defect this closes is not stylistic: with local time in a rate-limit window key, two app servers with skewed clocks place the same subject in different buckets, and the limit silently fails to hold.
