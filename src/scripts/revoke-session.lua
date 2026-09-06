-- KEYS[1] session key
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
