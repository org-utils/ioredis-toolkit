-- KEYS[1] session key
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
