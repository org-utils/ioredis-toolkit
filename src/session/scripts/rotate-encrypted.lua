-- rotate-encrypted.lua (version 1) - encrypted (v2) envelopes
-- Atomic, single-use session rotation for encrypted sessions.
--
-- The ciphertext cannot be decoded inside Lua, so the app decrypts the
-- old record, builds the consumed + successor payloads (re-encrypted with
-- the current key) and passes them as ARGV. The script is the only
-- authority for the state transition, decided from the plaintext header
-- mirrors (st/ver/exp/rn/rj/fam) and Redis server time; the header mirrors
-- of the written payloads are overwritten from the checked values so a
-- stale app payload can never misrepresent state.
--
-- Token-family reuse detection: mirrors rotate.lua (see that file for the
-- full rationale). The plaintext `fam` header mirror lets this script make
-- the same family-head decision the plain path makes, even though it can
-- never see or alter the ciphertext itself: the app is responsible for
-- baking the correct familyId into both the ciphertext and the `fam`
-- mirror before calling this script (see SessionRepository.rotate), and
-- this script cross-checks/forces the mirror the same way it already
-- forces st/ver/la/idle/exp/rn/rj - if the app ever got it wrong, the next
-- read's assertHeaderMatches() catches the ciphertext/header disagreement
-- and fails closed rather than silently establishing the wrong lineage.
--
-- KEYS[1] = old session record key
-- KEYS[2] = successor session record key
-- KEYS[3] = user session index key
--
-- ARGV[1]  = consumed serialized envelope (app-built, re-encrypted)
-- ARGV[2]  = successor serialized envelope (app-built, re-encrypted)
-- ARGV[3]  = successor jti
-- ARGV[4]  = expected version of the old session ('' = no check)
-- ARGV[5]  = rotation nonce hash ('' = none)
-- ARGV[6]  = retain consumed tombstone (1/0)
-- ARGV[7]  = old jti
-- ARGV[8]  = successor TTL (clamped >= 1)
-- ARGV[9]  = consumed tombstone TTL (clamped >= 1)
-- ARGV[10] = session key prefix for this user (same hash tag => same slot)
-- ARGV[11] = family-head key prefix for this user (same hash tag)
-- ARGV[12] = revoke the family head on genuine replay (1/0)
--
-- Returns: same codes as rotate.lua (1/2/0/-1/-2/-3/-4/5/{-6,familyId,headJti}),
-- plus 6 when the envelope is plain (caller must use the plain path).
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)

if env.v ~= 2 then
  return 6
end

local t = redis.call('TIME')
local now = tonumber(t[1])

-- Immutable identity field: unchanged across every rotation of this
-- lineage. Legacy pre-migration records lacking it adopt their own jti as
-- the familyId from this point forward (self-healing) - see rotate.lua.
local familyId = env.fam
if familyId == nil or familyId == cjson.null then
  familyId = ARGV[7]
end
local familyHeadKey = ARGV[11] .. familyId

-- Retry-safe replay detection BEFORE rejecting consumed records.
-- The rotation nonce uniquely identifies the rotation: when the consumed
-- record carries the same nonce hash, this is a retry of an already-applied
-- rotation. The stored rotatedTo jti is returned (the retry's own freshly
-- generated successor jti is discarded - it can never match).
if env.st == 'consumed' then
  if ARGV[5] ~= '' and env.rn == ARGV[5] then
    return { 2, env.rj }
  end

  -- Genuine reuse of an already-rotated-away token.
  if ARGV[12] == '1' then
    local headJti = redis.call('GET', familyHeadKey)
    if headJti then
      redis.call('DEL', ARGV[10] .. headJti)
      redis.call('ZREM', KEYS[3], headJti)
    end
    redis.call('DEL', familyHeadKey)
    return { -6, familyId, headJti or '' }
  end

  return -1
end

if env.st ~= 'active' then
  return -1
end

if tonumber(env.exp) <= now then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], ARGV[7])
  return -2
end

if ARGV[4] ~= '' and tostring(env.ver) ~= ARGV[4] then
  return -3
end

if redis.call('EXISTS', KEYS[2]) == 1 then
  return -4
end

local consumedEnv = cjson.decode(ARGV[1])
consumedEnv.st = 'consumed'
consumedEnv.ver = env.ver
consumedEnv.la = env.la
consumedEnv.idle = env.idle
consumedEnv.exp = env.exp
consumedEnv.rn = cjson.null
consumedEnv.rj = ARGV[3]
consumedEnv.fam = familyId

if ARGV[5] ~= '' then
  consumedEnv.rn = ARGV[5]
end

local nextEnv = cjson.decode(ARGV[2])
nextEnv.st = 'active'
nextEnv.ver = 1
nextEnv.la = now
if nextEnv.idle ~= cjson.null then
  nextEnv.idle = math.min(tonumber(nextEnv.idle), tonumber(nextEnv.exp))
end
nextEnv.rn = cjson.null
nextEnv.rj = cjson.null
nextEnv.fam = familyId

local nextTtl = math.max(1, tonumber(ARGV[8]))

if ARGV[6] == '1' then
  redis.call('SET', KEYS[1], cjson.encode(consumedEnv), 'EX', math.max(1, tonumber(ARGV[9])))
else
  redis.call('DEL', KEYS[1])
end

redis.call('SET', KEYS[2], cjson.encode(nextEnv), 'EX', nextTtl)
redis.call('ZREM', KEYS[3], ARGV[7])
-- Microsecond-resolution ordering score - see create.lua for why
-- second-granularity scores break oldest-first eviction ordering.
redis.call('ZADD', KEYS[3], tonumber(t[1]) + (tonumber(t[2]) / 1000000), ARGV[3])
-- Advance the family head to the new generation.
redis.call('SET', familyHeadKey, ARGV[3], 'EX', nextTtl)

return { 1, ARGV[3] }