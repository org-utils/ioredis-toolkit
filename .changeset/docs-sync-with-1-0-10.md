---
"ioredis-toolkit": patch
---

The published guides now match the code. The `'replace'` override examples pass `enabled: true`, since `'replace'` resets every option it is not given, `enabled` included. The session `create()` examples pass the `securityVersion` their setup requires, and the cache `get()` example compiles under `strict`. The session error table, the state diagram, `list()` and `rotate()` describe what the code does. The README states which session failures are wrapped as `SESSION_STORAGE`, which error each misconfiguration throws, and the namespace-overlap rule, and shows Sentinel and Cluster connections. The capacity guide counts the security-version key and the consumed and revoked records kept after use. TESTING.md lists the suites that exist and the ones still to be written.
