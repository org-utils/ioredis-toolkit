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
-- The security version lives as long as the set, so it outlives every session it is checked against, and is never
-- shortened. One written by an earlier version without an expiry is given the set's.
local versionTtl = redis.call('PTTL', KEYS[3])
if versionTtl ~= -2 then
  local setTtl = redis.call('PTTL', KEYS[2])
  if setTtl == -1 then redis.call('PERSIST', KEYS[3])
  elseif versionTtl == -1 or versionTtl < setTtl then redis.call('PEXPIRE', KEYS[3], setTtl) end
end
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
  'read_session': `-- KEYS[1] session key
-- KEYS[2] user's session set
-- KEYS[3] the user's security version
-- ARGV[1] tokenHash
-- Returns {record or nil, 1 if the user's session set holds the token hash else 0, security version or nil, server seconds}.
-- One read in the user's slot, so the record and its membership are seen at the same instant. TIME is Redis server time,
-- authoritative under ADR-0002; the script writes nothing, so reading it here is allowed on every Redis version.
local inSessionSet = 0
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then inSessionSet = 1 end
return {redis.call('GET', KEYS[1]), inSessionSet, redis.call('GET', KEYS[3]), redis.call('TIME')[1]}
`,
  'set_security_version': `-- KEYS[1] the user's security version
-- KEYS[2] user's session set
-- ARGV[1] security version
-- ARGV[2] the configured session ttl, in milliseconds
-- The version outlives every session in the set, and lasts at least one session ttl so that a create() already under
-- way with the previous version still meets this one. While the set has no expiry, neither has the version.
local ttl = tonumber(ARGV[2])
local setTtl = redis.call('PTTL', KEYS[2])
if setTtl == -1 then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
if setTtl > ttl then ttl = setTtl end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
return 1
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
`
} as const;
