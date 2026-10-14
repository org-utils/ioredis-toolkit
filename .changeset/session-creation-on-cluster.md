---
"ioredis-toolkit": patch
---

A user at `maxSessionsPerUser` can sign in on Redis Cluster again. The creation script used to delete the evicted session's token locator, which lives in another hash slot, so on Cluster every login over the limit failed, after already logging the user out of one other device. The script now deletes only the evicted session's record, which shares the user's slot, and the token locator is deleted afterwards as best-effort cleanup. An evicted credential validates as `not_found` even if that cleanup fails.

A `create()` never evicts the session it is creating. Before, with `maxSessionsPerUser: 1`, two logins in the same second could evict the new session and still report success.

Each user's session set now expires with the longest-lived session in it, instead of living forever. A shorter-lived session never shortens it. A set written by an earlier version without an expiry is given one, at the next `create()` for that user, that outlives every session it already holds. The comparison is made in Lua, so Redis 6 keeps working.
