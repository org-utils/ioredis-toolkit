-- create.lua (version 1)
-- Atomically creates a session record, registers it in the user index
-- (ZSET, score = microsecond-resolution Redis server time, used purely
-- for eviction ordering - see below), optionally claims an idempotency
-- key, and enforces maxSessionsPerUser with bounded oldest-first eviction.
--
-- KEYS[1] = session record key
-- KEYS[2] = user session index key (ZSET)
-- KEYS[3] = idempotency claim key (only passed when idempotency is enabled)
--
-- ARGV[1] = serialized session envelope (plain v1 or encrypted v2)
-- ARGV[2] = jti
-- ARGV[3] = createdAt (Unix seconds)
-- ARGV[4] = session TTL (absoluteExpiresAt - now, clamped >= 1)
-- ARGV[5] = maxSessionsPerUser (0 disables)
-- ARGV[6] = session key prefix for this user (same hash tag => same slot)
-- ARGV[7] = max evictions per call (bounded Lua work)
-- ARGV[8] = idempotency claim TTL ('' when idempotency is disabled)
--
-- Returns:
--   {1, {evictedJtis...}}  success (evicted list may be empty)
--   {3, jti}               idempotent replay: a previous attempt created
--                          the session; jti identifies it
--   -5                     jti collision: a session with this id exists
--
-- All keys share the {userId} hash tag, so this script is atomic on a
-- single Cluster slot. No cross-slot keys are touched.
local key = KEYS[1]
local index = KEYS[2]

-- Idempotent replay wins over collision detection: a retry with the same
-- idempotencyKey must return the original session, even though the session
-- record already exists.
if ARGV[8] ~= '' then
  local claimKey = KEYS[3]
  local claimJti = redis.call('GET', claimKey)
  if claimJti then
    return { 3, claimJti }
  end
  redis.call('SET', claimKey, ARGV[2], 'EX', tonumber(ARGV[8]))
end

if redis.call('EXISTS', key) == 1 then
  return -5
end

redis.call('SET', key, ARGV[1], 'EX', tonumber(ARGV[4]))

-- The user index score is used purely for oldest-first eviction ordering
-- (never as the record's createdAt, which is app-stamped seconds inside the
-- envelope). Redis breaks equal ZSET scores by lexicographic member order,
-- not insertion order, so scoring by second-granularity createdAt would
-- make eviction pick an arbitrary (jti-lexicographic) session rather than
-- the actual oldest one whenever a user creates more than one session in
-- the same wall-clock second - a realistic case under normal traffic, not
-- just a burst edge case. Redis is single-threaded, so two scripts touching
-- the same user slot never observe the same TIME() reading in practice;
-- microsecond-resolution server time therefore gives a strictly monotonic,
-- clock-skew-free ordering key for this user's index.
local t = redis.call('TIME')
local orderScore = tonumber(t[1]) + (tonumber(t[2]) / 1000000)
redis.call('ZADD', index, orderScore, ARGV[2])

local evicted = {}
local limit = tonumber(ARGV[5])

if limit and limit > 0 then
  local card = redis.call('ZCARD', index)
  if card > limit then
    local excess = card - limit
    local n = math.min(excess, tonumber(ARGV[7]))
    local members = redis.call('ZRANGE', index, 0, n - 1)
    local prefix = ARGV[6]

    for _, member in ipairs(members) do
      redis.call('DEL', prefix .. member)
      redis.call('ZREM', index, member)
      table.insert(evicted, member)
    end
  end
end

return { 1, evicted }