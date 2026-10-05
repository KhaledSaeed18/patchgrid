/**
 * The Lua counter against a real Redis: fixed windows, atomic blocking, and
 * the fail-open answer when Redis is gone.
 */
import "../support/env"

import { Logger } from "@nestjs/common"
import Redis from "ioredis"
import { randomUUID } from "node:crypto"
import process from "node:process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { RedisService } from "../../src/redis/redis.service"
import { RedisThrottlerStorage } from "../../src/throttling/redis-throttler.storage"

let client: Redis
let storage: RedisThrottlerStorage
const key = `spec-${randomUUID().slice(0, 8)}`

beforeAll(async () => {
  Logger.overrideLogger(false)
  client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379")
  await client.ping()
  storage = new RedisThrottlerStorage({ client } as unknown as RedisService)
})

afterAll(async () => {
  const keys = await client.keys(`throttle:spec:${key}*`)
  if (keys.length > 0) await client.del(...keys)
  client.disconnect()
})

describe("RedisThrottlerStorage", () => {
  it("counts hits in a window and blocks for the rest of it once over the limit", async () => {
    const one = await storage.increment(key, 60_000, 2, 0, "spec")
    const two = await storage.increment(key, 60_000, 2, 0, "spec")
    expect([one.totalHits, two.totalHits]).toEqual([1, 2])
    expect(two.isBlocked).toBe(false)
    expect(two.timeToExpire).toBeGreaterThan(50)

    const three = await storage.increment(key, 60_000, 2, 0, "spec")
    expect(three.isBlocked).toBe(true)
    expect(three.timeToBlockExpire).toBeGreaterThan(50)
    expect(await client.exists(`throttle:spec:${key}:block`)).toBe(1)
  })

  it("forgets the window when its ttl passes", async () => {
    const short = `${key}-short`
    await storage.increment(short, 150, 1, 0, "spec")
    await new Promise((resolve) => setTimeout(resolve, 250))
    const fresh = await storage.increment(short, 150, 1, 0, "spec")
    expect(fresh.totalHits).toBe(1)
    expect(fresh.isBlocked).toBe(false)
  })

  it("lets the request through, and says so, when Redis cannot be reached", async () => {
    const down = new Redis({ host: "127.0.0.1", port: 1, lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false })
    const storageDown = new RedisThrottlerStorage({ client: down } as unknown as RedisService)
    const record = await storageDown.increment(key, 60_000, 1, 0, "spec")
    expect(record).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 })
    down.disconnect()
  })
})
