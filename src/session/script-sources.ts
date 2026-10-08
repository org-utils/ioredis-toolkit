export const SCRIPT_SOURCES = {
  'create_session': `-- KEYS[1] session key
-- KEYS[2] user index
-- ARGV[1] serialized record
-- ARGV[2] ttl seconds
-- ARGV[3] createdAt score
-- ARGV[4] tokenHash
-- ARGV[5] max sessions (0 = unlimited)
-- ARGV[6] this user's session key, less the token hash
-- ARGV[7] token index key, less the token hash
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not created then return {-1} end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
if tonumber(ARGV[5]) > 0 then
  local count = redis.call('ZCARD', KEYS[2])
  if count > tonumber(ARGV[5]) then
    local excess = count - tonumber(ARGV[5])
    local old = redis.call('ZRANGE', KEYS[2], 0, excess - 1)
    for _, evictedHash in ipairs(old) do
      redis.call('ZREM', KEYS[2], evictedHash)
      redis.call('DEL', ARGV[6] .. evictedHash)
      redis.call('DEL', ARGV[7] .. evictedHash)
    end
    return {1, excess}
  end
end
return {1}
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
