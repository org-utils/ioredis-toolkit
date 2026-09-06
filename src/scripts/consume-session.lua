-- KEYS[1] session key
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
