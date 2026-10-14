---
"ioredis-toolkit": patch
---

A user's stored security version now expires once none of their sessions can use it, instead of staying in Redis forever.

- It lives as long as the user's longest-lived session. `create()`, and rotation, extend its TTL to the user's session set's and never shorten it.
- `setSecurityVersion()` gives it a TTL of the longer of the user's longest-lived session and the configured session `ttl`. Before, it also removed any TTL the key had.
- Validation is unchanged: a missing version still fails closed, but it can now only go missing once the user has no session left to validate.
- **Behaviour change:** once the version has expired, the next `create()` stores the version it is given, as for a new user. After a bump, a user who has had no session for longer than the session `ttl` can therefore be given a session with the previous version. Pass the user's current version to `create()`.
- A version written by an earlier release, without a TTL, is given one at that user's next `create()` or `setSecurityVersion()`. Users who never return keep theirs until then.
