-- Reference copy only. The authoritative script actually executed at runtime is
-- SCRIPT_SOURCES.create_session in src/session/script-sources.ts — keep this file in sync with it.
-- KEYS[1] session key
-- KEYS[2] user index
-- ARGV[1] serialized record
-- ARGV[2] ttl seconds
-- ARGV[3] createdAt score
-- ARGV[4] tokenHash
-- ARGV[5] max sessions (0 = unlimited)
-- ARGV[6] namespace
-- ARGV[7] userTag
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
      redis.call('DEL', ARGV[6] .. ':session:{' .. ARGV[7] .. '}:' .. evictedHash)
      redis.call('DEL', ARGV[6] .. ':token-index:' .. evictedHash)
    end
    return {1, excess}
  end
end
return {1}
