export const SCRIPT_SOURCES = {
  'create_session': `-- KEYS[1] session key
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
`,
  'touch_session': `-- KEYS[1] session key
-- ARGV[1] now epoch seconds
-- ARGV[2] touch interval
-- ARGV[3] new idle expiry epoch seconds (0 = no idle timeout)
-- ARGV[4] new absolute expiry epoch seconds (0 = no absolute timeout)
local raw = redis.call('GET', KEYS[1])
if not raw then return {0} end
local ok, s = pcall(cjson.decode, raw)
if not ok or not s.data then return {-4} end
local r = s.data
if r.status ~= 'active' then return {-1} end
local now = tonumber(ARGV[1])
if tonumber(r.expiresAt) <= now then return {-2} end
if r.absoluteExpiresAt and r.absoluteExpiresAt ~= cjson.null and tonumber(r.absoluteExpiresAt) > 0 and tonumber(r.absoluteExpiresAt) <= now then return {-2} end
if r.idleExpiresAt and tonumber(r.idleExpiresAt) > 0 and tonumber(r.idleExpiresAt) <= now then return {-3} end
if now - tonumber(r.lastAccessedAt) < tonumber(ARGV[2]) then return {2} end
local idle = tonumber(ARGV[3])
local absolute = tonumber(ARGV[4])
if absolute > 0 and idle > absolute then idle = absolute end
r.lastAccessedAt = now
r.idleExpiresAt = idle > 0 and idle or cjson.null
r.version = tonumber(r.version) + 1
local wrapper = {v=1, data=r}
local encoded = cjson.encode(wrapper)
local ttl = tonumber(r.expiresAt) - now
if ttl <= 0 then return {-2} end
redis.call('SET', KEYS[1], encoded, 'XX', 'EX', ttl)
return {1, r.version, idle}
`,
  'consume_session': `-- KEYS[1] session key
-- ARGV[1] now epoch seconds
-- ARGV[2] tombstone ttl seconds
local raw = redis.call('GET', KEYS[1])
if not raw then return {0} end
local ok, s = pcall(cjson.decode, raw)
if not ok or not s.data then return {-4} end
local r = s.data
if r.status == 'consumed' then return {-1} end
if r.status == 'revoked' then return {-3} end
local now = tonumber(ARGV[1])
if tonumber(r.expiresAt) <= now then return {-2} end
if r.absoluteExpiresAt and r.absoluteExpiresAt ~= cjson.null and tonumber(r.absoluteExpiresAt) > 0 and tonumber(r.absoluteExpiresAt) <= now then return {-2} end
if r.idleExpiresAt and tonumber(r.idleExpiresAt) > 0 and tonumber(r.idleExpiresAt) <= now then return {-2} end
r.status = 'consumed'
r.consumedAt = now
r.version = tonumber(r.version) + 1
local ttl = tonumber(ARGV[2])
local encoded = cjson.encode({v=1, data=r})
redis.call('SET', KEYS[1], encoded, 'XX', 'EX', ttl)
return {1, r.userId, r.jti, r.version}
`,
  'revoke_session': `-- KEYS[1] session key
-- ARGV[1] now
-- ARGV[2] tombstone ttl
local raw = redis.call('GET', KEYS[1])
if not raw then return {0} end
local ok, s = pcall(cjson.decode, raw)
if not ok or not s.data then return {-4} end
local r=s.data
if r.status == 'revoked' then return {2} end
r.status='revoked'; r.version=tonumber(r.version)+1
local ttl=tonumber(ARGV[2])
if ttl < 1 then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], cjson.encode({v=1,data=r}), 'XX', 'EX', ttl) end
return {1}
`,
  'update_session': `-- KEYS[1] session key
-- ARGV[1] expected version
-- ARGV[2] now
-- ARGV[3] serialized replacement
local raw = redis.call('GET', KEYS[1])
if not raw then return {0} end
local ok, s = pcall(cjson.decode, raw)
if not ok or not s.data then return {-4} end
if s.data.status ~= 'active' then return {-3} end
if tonumber(s.data.version) ~= tonumber(ARGV[1]) then return {-2, s.data.version} end
local replacement = ARGV[3]
local ok2, parsed = pcall(cjson.decode, replacement)
if not ok2 or not parsed.data then return {-4} end
if parsed.data.userId ~= s.data.userId or parsed.data.jti ~= s.data.jti or parsed.data.id ~= s.data.id or parsed.data.createdAt ~= s.data.createdAt or parsed.data.absoluteExpiresAt ~= s.data.absoluteExpiresAt then return {-5} end
local ttl = tonumber(s.data.expiresAt) - tonumber(ARGV[2])
if ttl <= 0 then return {-1} end
redis.call('SET', KEYS[1], replacement, 'XX', 'EX', ttl)
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
