-- KEYS[1] session key
return redis.call('DEL', KEYS[1])
