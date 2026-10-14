---
"ioredis-toolkit": patch
---

Enabling `securityVersionEnabled` no longer rejects every session until the application has written a security version for each user. When no version is stored for a user, `create()` stores the `securityVersion` it is given, set only if absent, in the same step that writes the session. `create()` never overwrites a stored version, so sessions from before a `setSecurityVersion()` bump stay invalid. Validation still fails closed whenever the stored version is missing. The sessions docs describe the behaviour.
