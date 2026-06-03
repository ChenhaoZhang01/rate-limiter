/**
 * Redis-backed strategies that mirror src/strategies.js but are correct under
 * concurrency by doing the read-modify-write atomically in a single Lua script
 * (Redis executes a script atomically). Requires an ioredis-compatible client.
 *
 *   import Redis from "ioredis";
 *   const limiter = new RedisTokenBucket(new Redis(), { burst: 20, refillPerSec: 5 });
 *   const { allowed } = await limiter.check("user:42");
 */

// Token bucket as a Lua script: KEYS[1]=bucket key,
// ARGV = capacity, refillPerSec, nowMs, cost
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2]) / 1000
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last')
local tokens = tonumber(data[1])
local last = tonumber(data[2])
if tokens == nil then tokens = capacity; last = now end

tokens = math.min(capacity, tokens + (now - last) * refillPerMs)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / refillPerMs)
end

redis.call('HMSET', key, 'tokens', tokens, 'last', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refillPerMs) + 1000)
return {allowed, math.floor(tokens), retry}
`;

// Sliding window log via a sorted set: KEYS[1]=zset,
// ARGV = limit, windowMs, nowMs, member
const SLIDING_LOG_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return {1, limit - count - 1, 0}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = math.floor(tonumber(oldest[2]) + windowMs - now)
  return {0, 0, retry}
end
`;

function toResult([allowed, remaining, retry]) {
  return {
    allowed: allowed === 1,
    remaining: Number(remaining),
    retryAfterMs: Number(retry),
    resetMs: Number(retry),
  };
}

export class RedisTokenBucket {
  constructor(redis, { burst, refillPerSec }) {
    this.redis = redis;
    this.burst = burst;
    this.refillPerSec = refillPerSec;
  }
  async check(key, cost = 1) {
    const res = await this.redis.eval(
      TOKEN_BUCKET_LUA, 1, `rl:tb:${key}`,
      this.burst, this.refillPerSec, Date.now(), cost
    );
    return toResult(res);
  }
}

export class RedisSlidingWindowLog {
  constructor(redis, { limit, windowMs }) {
    this.redis = redis;
    this.limit = limit;
    this.windowMs = windowMs;
  }
  async check(key) {
    const member = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await this.redis.eval(
      SLIDING_LOG_LUA, 1, `rl:swl:${key}`,
      this.limit, this.windowMs, Date.now(), member
    );
    return toResult(res);
  }
}
