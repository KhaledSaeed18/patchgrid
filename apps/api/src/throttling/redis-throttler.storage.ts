import { Injectable, Logger } from "@nestjs/common"
import type { ThrottlerStorage } from "@nestjs/throttler"

import { RedisService } from "../redis/redis.service"

/**
 * Fixed-window counters in Redis, so a limit means the same thing across
 * every API process. One Lua script, so the increment, its expiry and the
 * block decision are one atomic step — two concurrent requests at the limit
 * cannot both slip through.
 *
 * Redis down → the request proceeds and a line is logged. Rate limiting is
 * defence in depth; taking the whole API down with Redis would be the worse
 * failure, and the revocation epoch already decides what must fail closed.
 */
/** The package does not export the record type from its root; this is it. */
type StorageRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name)

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    const hits = `throttle:${throttlerName}:${key}`
    const block = `${hits}:block`
    try {
      const result = (await this.redis.client.eval(
        INCREMENT,
        2,
        hits,
        block,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as [number, number, number]
      const [totalHits, ttlMs, blockMs] = result
      return {
        totalHits,
        timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
        isBlocked: blockMs > 0,
        timeToBlockExpire: Math.max(0, Math.ceil(blockMs / 1000)),
      }
    } catch (error) {
      this.logger.warn(
        `rate limiting unavailable, request allowed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }
    }
  }
}

/**
 * KEYS[1] hits, KEYS[2] block · ARGV[1] ttl ms, ARGV[2] limit, ARGV[3] block ms.
 * Returns { hits, hits ttl ms, block ttl ms (<= 0 when not blocked) }.
 */
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blockTtl = redis.call('PTTL', KEYS[2])
if hits > tonumber(ARGV[2]) and blockTtl <= 0 then
  local block = tonumber(ARGV[3])
  if block <= 0 then block = ttl end
  if block > 0 then
    redis.call('SET', KEYS[2], '1', 'PX', block)
    blockTtl = block
  end
end
return { hits, ttl, blockTtl }
`
