import { Injectable } from "@nestjs/common"
import { v7 as uuidv7 } from "uuid"

import { RedisService } from "../../redis/redis.service"

/**
 * At most `cap` deliveries in flight per tenant (ADR-0050): a sorted set of
 * leases scored by expiry, taken in one Lua script so two workers cannot both
 * see room for one. A lease expires on its own, so a worker that dies
 * mid-request frees its slot within the lease's life rather than never.
 */
const ACQUIRE = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
redis.call("PEXPIRE", KEYS[1], ARGV[5])
return 1
`

export type Lease = { release(): Promise<void> }

@Injectable()
export class TenantLease {
  constructor(private readonly redis: RedisService) {}

  async acquire(orgId: string, cap: number, ttlMs: number, now = Date.now()): Promise<Lease | null> {
    const key = `webhooks:inflight:${orgId}`
    const id = uuidv7()
    const taken = await this.redis.client.eval(ACQUIRE, 1, key, String(now), String(cap), String(now + ttlMs), id, String(ttlMs))
    if (taken !== 1) return null
    return {
      release: async () => {
        await this.redis.client.zrem(key, id)
      },
    }
  }
}
