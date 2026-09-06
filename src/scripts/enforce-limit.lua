-- Bounded helper. The application must pass session keys to delete as KEYS.
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
