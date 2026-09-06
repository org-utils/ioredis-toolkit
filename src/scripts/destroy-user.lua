-- Reference copy only. Not present in SCRIPT_SOURCES and not executed by the
-- repository at runtime (SessionRepository.revokeAll implements the equivalent
-- operation in TypeScript via a pipeline). Bounded helper: the application must
-- pass session keys to delete as KEYS, matching enforce-limit.lua's pattern.
-- KEYS[1] user index; KEYS[2..N] session keys corresponding to the returned members.
-- ARGV[1] max batch
local n = tonumber(ARGV[1])
local members = redis.call('ZRANGE', KEYS[1], 0, n - 1)
for i, tokenHash in ipairs(members) do
  redis.call('ZREM', KEYS[1], tokenHash)
  redis.call('DEL', KEYS[i + 1])
end
return members
