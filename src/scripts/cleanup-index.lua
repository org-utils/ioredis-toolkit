-- KEYS[1] user index
-- ARGV[1..N] stale token hashes (user-index ZSET members, not JTIs)
for i=1,#ARGV do redis.call('ZREM', KEYS[1], ARGV[i]) end
return #ARGV
