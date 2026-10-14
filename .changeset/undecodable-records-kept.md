---
"ioredis-toolkit": patch
---

A session record that cannot be decoded is now reported and never deleted. Before, if the key manager briefly lacked an old key version, or encryption was switched off by mistake, every session that failed to decode was deleted the next time it was validated or listed. That amounted to a mass logout. Now validating such a session throws `SessionSerializationError` and leaves the record exactly as stored, so restoring the configuration makes the session valid again. `list()` leaves undecodable records out of the page without removing them from the user's session set. It still removes members whose record is missing.

`list()` also leaves out sessions past any of their expiries (hard, idle or absolute), measured in Redis server time, so it shows only sessions that can still authenticate. Before, idle-expired sessions were listed.
