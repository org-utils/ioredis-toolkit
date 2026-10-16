# Threat Model

| Threat | Asset | Mitigation | Residual risk / test target |
|---|---|---|---|
| Stolen session token | Authentication state | 256-bit secret; SHA-256 storage; TLS expected; revocation/rotation | Bearer token remains a bearer credential; test token theft/replay |
| Token brute force | Session lookup | 256-bit random secret | Computationally infeasible; test format rejection |
| Token enumeration | Authentication existence | Opaque token; safe invalid results | Timing differences should be monitored; public APIs should not expose internal reasons |
| Session fixation | Login/session identity | Fresh random token creation and rotation | Host auth flow must replace pre-auth session after authentication |
| Replay after rotation | Consumed session credential | Atomic predecessor consumption | Rotation is non-idempotent; test concurrent rotate |
| Replay after logout | Session state | revoke/destroy + session set checks | A request already authorized before logout may complete; authorization transaction boundaries remain application-specific |
| Concurrent attacker requests | Session state | Compare-and-set state transitions and version checks | Test simultaneous touch/update/rotate |
| Redis outage | Authentication state | Fail closed; storage errors distinct from invalid sessions | Application decides 401 vs 503; never fail open |
| Uncaught connection-error crash | Availability (whole process) | Default `'error'` listener attached to every Redis connection the package opens, including the Pub/Sub subscriber connection | The listener forwards to the application's `onError` hook, with the source named, and contains a hook that throws; without a hook, errors are dropped rather than crashing the process |
| Malformed cached/published payload | Availability | `RedisCache.get()` throws a typed `CacheError`; `RedisPubSub` silently drops an unparseable message | Neither crashes the process; a cache read failure still surfaces as an error to the caller rather than a silent miss |
| Redis data exposure | Session metadata | Optional AES-256-GCM; TLS/ACLs/private network | Compromised app with key can decrypt |
| Stale token locator or session set member | Authorization | Session record independently validated; the session set only denies | `create()` eviction, `revoke()`, and rotation's `consume()` now remove their affected session set member eagerly (not only via `list()`'s lazy self-heal), shrinking the window in which a stale entry can exist and be counted toward `maxSessionsPerUser` |
| Redis eviction | Session state | TTL + session set checks; operational memory policy required | Eviction can log users out; it must never authenticate them |
| Old backup restore | Revocation state | Document restore as security event | Requires deployment-level security-version invalidation strategy |
| Revocation or security-version bump lost in a failover | Revocation state | `min-replicas-to-write` with a small `min-replicas-max-lag`, or `WAIT` (on Cluster, sent to each master) after a write that must not be lost; where it matters, treat a failover like an old backup restore | No call fails for the lost write, and the sessions it ended or invalidated authenticate again. On Sentinel the window is the second or so between promotion and announcement, with the default `failoverDetector`; on Cluster a partitioned master acknowledges for up to `cluster-node-timeout`, and how much is lost is unmeasured. See [Sentinel failover](./DEPLOYMENT.md#sentinel-failover) and [Cluster failover](./DEPLOYMENT.md#cluster-failover) |
| CSRF | Cookie credential | Cookie flags + framework-level CSRF strategy | SameSite is not universal CSRF protection |
| XSS | Browser auth state | HttpOnly cookie option | XSS can still act as user in browser; application CSP/output encoding required |
| CORS misconfiguration | Credentialed browser requests | No framework CORS policy inside core | Host application must whitelist origins and never wildcard credentialed requests |
| Hot user slot | Availability | Per-user hash tag; bounded operations | A single extremely active user can concentrate load |
| Memory exhaustion | Redis availability | Metadata/pipeline/batch bounds | Deployment still needs capacity planning |
