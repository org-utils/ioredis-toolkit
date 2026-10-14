---
"ioredis-toolkit": patch
---

`revokeAll()` works on Redis Cluster. Before, it failed every time there, because it sent one pipeline mixing the user's session records with their token locators, which live in other hash slots. The records are now deleted in one step in the user's slot, and the token locators afterwards through the cluster-aware delete. The `{ affected, remaining }` result, the `maxBatchSize` bound and the user-ID validation are unchanged.
