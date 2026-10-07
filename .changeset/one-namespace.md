---
"ioredis-toolkit": patch
---

Every module now takes its namespace from one `namespace` field and builds its keys through one key strategy, so a namespace behaves the same in cache, lock, rate limiting, Pub/Sub, streams and sessions.

Breaking: two config fields are renamed, with no alias.

- `streams.keyPrefix` is now `streams.namespace`
- `pubsub.channelPrefix` is now `pubsub.namespace`

An old field name is ignored rather than rejected, so a config that still passes one falls back to the default namespace (`stream`, `events`) and reads and writes different keys and channels. Rename the field when upgrading.

Breaking: the namespace of `cache`, `lock`, `rateLimit`, `pubsub` and `streams` must now match `[A-Za-z0-9:_-]{1,128}`, the rule sessions already applied. A namespace carrying a hash tag or a glob character is rejected, because it would decide the Cluster hash slot of every key under it or widen `cache.clear()` into other namespaces.
