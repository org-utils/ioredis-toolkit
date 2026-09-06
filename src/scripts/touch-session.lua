-- KEYS[1] session key
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
