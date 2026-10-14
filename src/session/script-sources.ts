export const SCRIPT_SOURCES = {
  'create_session': `-- KEYS[1] session key
-- KEYS[2] user's session set
-- KEYS[3] the user's security version
-- ARGV[1] serialized record
-- ARGV[2] ttl seconds
-- ARGV[3] createdAt score
-- ARGV[4] tokenHash
-- ARGV[5] max sessions (0 = unlimited)
-- ARGV[6] this user's session key, less the token hash
-- ARGV[7] security version to store if the user has none, or '' to leave it alone
-- Returns {1, evicted token hash...}, or {-1} when the session key is taken. Token locators live in other
-- slots, so deleting an evicted session's locator is left to the caller.
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not created then return {-1} end
if ARGV[7] ~= '' then redis.call('SET', KEYS[3], ARGV[7], 'NX') end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
-- The set lives as long as its longest-lived session. Compared here rather than with EXPIRE GT, which Redis 6 lacks.
local ttl = tonumber(ARGV[2]) * 1000
local current = redis.call('PTTL', KEYS[2])
if current == -1 then
  -- Written by an earlier version without an expiry: it must outlive every session it already holds.
  for _, member in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
    local remaining = redis.call('PTTL', ARGV[6] .. member)
    if remaining == -1 then ttl = -1 break end
    if remaining > ttl then ttl = remaining end
  end
end
if ttl ~= -1 and current < ttl then redis.call('PEXPIRE', KEYS[2], ttl) end
local result = {1}
local max = tonumber(ARGV[5])
if max > 0 then
  local excess = redis.call('ZCARD', KEYS[2]) - max
  if excess > 0 then
    -- One candidate more than needed, so the session just added is never the one evicted when createdAt ties.
    for _, evictedHash in ipairs(redis.call('ZRANGE', KEYS[2], 0, excess)) do
      if #result > excess then break end
      if evictedHash ~= ARGV[4] then
        redis.call('ZREM', KEYS[2], evictedHash)
        redis.call('DEL', ARGV[6] .. evictedHash)
        result[#result + 1] = evictedHash
      end
    end
  end
end
return result
`,
  'replace_session': `-- KEYS[1] session key
-- ARGV[1] SHA-1 of the stored value the replacement was worked out from
-- ARGV[2] replacement value
-- ARGV[3] ttl seconds
local raw = redis.call('GET', KEYS[1])
if not raw then return {0} end
if redis.sha1hex(raw) ~= ARGV[1] then return {-1} end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return {1}
`,
  'delete': `-- KEYS[1] session key
return redis.call('DEL', KEYS[1])
`,
  'enforce_limit': `-- Bounded helper. The application must pass session keys to delete as KEYS.
-- KEYS[1] user index; KEYS[2..N] session keys corresponding to the oldest members.
-- ARGV[1] max sessions; ARGV[2] number of candidate keys.
local max=tonumber(ARGV[1])
local candidateCount=tonumber(ARGV[2])
local count=redis.call('ZCARD', KEYS[1])
if max <= 0 or count <= max then return {0} end
local excess=math.min(count-max, candidateCount)
local removed=0
for i=1,excess do
  local tokenHash=redis.call('ZRANGE', KEYS[1], 0, 0)[1]
  if not tokenHash then break end
  redis.call('ZREM', KEYS[1], tokenHash)
  redis.call('DEL', KEYS[i+1])
  removed=removed+1
end
return {removed}
`,
  'cleanup_index': `-- KEYS[1] user index
-- ARGV[1..N] stale token hashes (user-index ZSET members, not JTIs)
for i=1,#ARGV do redis.call('ZREM', KEYS[1], ARGV[i]) end
return #ARGV
`
} as const;
