-- rotate.lua (version 1) - plain (v1) envelopes
-- Atomic, single-use session rotation.
--
-- The old session is consumed (status=consumed, consumedAt, rotatedTo,
-- rotationNonceHash) and the successor is created, all in one same-slot
-- script. No preliminary GET can make this safe; the script is the only
-- authority. Timestamps are stamped from Redis server time.
--
-- Retry-safe idempotency: when the caller retries a rotation that already
-- succeeded (response lost), the consumed record retains rotationNonceHash
-- and rotatedTo. If both match the retry, the script returns {2, jti} and
-- the caller returns the existing successor instead of a replay error.
--
-- Token-family reuse detection: every session carries a stable familyId
-- (the first generation's own jti), unchanged across rotations. A
-- {userId}-scoped "family-head" pointer key tracks the jti of the family's
-- current active generation, updated atomically on every successful
-- rotation. When a CONSUMED predecessor is replayed for real (not a
-- same-nonce retry), that is a strong signal the old token was stolen: if
-- ARGV[9] enables it, the script atomically revokes whatever the family
-- head currently points to (the live session an attacker could otherwise
-- keep using) and clears the head pointer, so the entire lineage dies
-- rather than just rejecting the one replayed request. The head pointer is
-- purely a defensive correlation key: per I7 it is never consulted by
-- validate() and can never itself grant authentication.
--
-- KEYS[1] = old session record key
-- KEYS[2] = successor session record key
-- KEYS[3] = user session index key
--
-- ARGV[1] = successor serialized envelope (app-built static fields)
-- ARGV[2] = successor jti
-- ARGV[3] = expected version of the old session ('' = no check)
-- ARGV[4] = rotation nonce hash ('' = none)
-- ARGV[5] = retain consumed tombstone (1/0)
-- ARGV[6] = old jti
-- ARGV[7] = session key prefix for this user (same hash tag => same slot)
-- ARGV[8] = family-head key prefix for this user (same hash tag)
-- ARGV[9] = revoke the family head on genuine replay (1/0)
--
-- Returns:
--   {1, successorJti}       success
--   {2, successorJti}       idempotent replay of a rotation with the same nonce
--   0                       old session not found
--   -1                      already consumed / revoked (replay; family not
--                           touched - either ARGV[9] is off, or the status
--                           was already 'revoked' rather than 'consumed')
--   {-6, familyId, headJti} genuine replay of a consumed predecessor: the
--                           family head (headJti, or "" if none was set)
--                           was revoked and the family head pointer cleared
--   -2                      old session expired (record removed)
--   -3                      version conflict
--   -4                      successor jti collision
--   5                       envelope is encrypted (use the encrypted path)
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)

if env.v ~= 1 then
  return 5
end

local s = env.s
local t = redis.call('TIME')
local now = tonumber(t[1])

-- Immutable identity field: unchanged across every rotation of this
-- lineage. Legacy pre-migration records lacking it adopt their own jti as
-- the familyId from this point forward (self-healing).
local familyId = s.familyId
if familyId == nil or familyId == cjson.null then
  familyId = s.jti
end
local familyHeadKey = ARGV[8] .. familyId

-- Retry-safe replay detection BEFORE rejecting consumed records.
-- The rotation nonce uniquely identifies the rotation: when the consumed
-- record carries the same nonce hash, this is a retry of an already-applied
-- rotation. The stored rotatedTo jti is returned (the retry's own freshly
-- generated successor jti is discarded - it can never match).
if s.status == 'consumed' then
  if ARGV[4] ~= '' and s.rotationNonceHash == ARGV[4] then
    return { 2, s.rotatedTo }
  end

  -- Genuine reuse of an already-rotated-away token.
  if ARGV[9] == '1' then
    local headJti = redis.call('GET', familyHeadKey)
    if headJti then
      redis.call('DEL', ARGV[7] .. headJti)
      redis.call('ZREM', KEYS[3], headJti)
    end
    redis.call('DEL', familyHeadKey)
    return { -6, familyId, headJti or '' }
  end

  return -1
end

if s.status ~= 'active' then
  return -1
end

if tonumber(s.absoluteExpiresAt) <= now then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], ARGV[6])
  return -2
end

if ARGV[3] ~= '' and tostring(s.version) ~= ARGV[3] then
  return -3
end

-- Successor collision: cryptographically improbable, but never overwrite.
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -4
end

-- Build the successor record; server time is authoritative for ordering.
local nextEnv = cjson.decode(ARGV[1])
local ns = nextEnv.s

ns.createdAt = now
ns.lastAccessedAt = now
ns.rotatedFrom = s.jti
ns.familyId = familyId
ns.version = 1

if ns.idleExpiresAt and ns.idleExpiresAt ~= cjson.null then
  ns.idleExpiresAt = math.min(tonumber(ns.idleExpiresAt), tonumber(ns.absoluteExpiresAt))
end

local nextTtl = math.max(1, tonumber(ns.absoluteExpiresAt) - now)

-- Consume the old session.
s.status = 'consumed'
s.consumedAt = now
s.rotatedTo = ARGV[2]

if ARGV[4] ~= '' then
  s.rotationNonceHash = ARGV[4]
else
  s.rotationNonceHash = cjson.null
end

local oldTtl = math.max(1, tonumber(s.absoluteExpiresAt) - now)

if ARGV[5] == '1' then
  -- Short-lived consumed tombstone for replay detection (bounded TTL).
  redis.call('SET', KEYS[1], cjson.encode(env), 'EX', oldTtl)
else
  redis.call('DEL', KEYS[1])
end

redis.call('SET', KEYS[2], cjson.encode(nextEnv), 'EX', nextTtl)
redis.call('ZREM', KEYS[3], ARGV[6])
-- Microsecond-resolution ordering score - see create.lua for why
-- second-granularity scores break oldest-first eviction ordering.
redis.call('ZADD', KEYS[3], tonumber(t[1]) + (tonumber(t[2]) / 1000000), ARGV[2])
-- Advance the family head to the new generation.
redis.call('SET', familyHeadKey, ARGV[2], 'EX', nextTtl)

return { 1, ARGV[2] }
