import { Logger } from "@nestjs/common"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import type { AppConfig } from "../../config/app-config"
import type { RedisService } from "../../redis/redis.service"
import { RevocationEpochService } from "./revocation-epoch.service"

const MEM = "0190b2f0-0000-7000-8000-0000000000aa"
const config = { REFRESH_TOKEN_TTL_DAYS: 7, ACCESS_TOKEN_TTL_SECONDS: 900 } as AppConfig

function harness() {
  const store = new Map<string, string>()
  let down = false
  const client = {
    get: vi.fn((k: string) => (down ? Promise.reject(new Error("down")) : Promise.resolve(store.get(k) ?? null))),
    set: vi.fn((k: string, v: string) => {
      if (down) return Promise.reject(new Error("down"))
      store.set(k, v)
      return Promise.resolve("OK")
    }),
  }
  const clock = new FixedClock(new Date("2026-10-05T12:00:00Z"))
  const service = new RevocationEpochService({ client } as unknown as RedisService, clock, config)
  return { service, clock, client, outage: (on: boolean) => (down = on) }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
})

describe("RevocationEpochService", () => {
  it("is not revoked when nothing was ever bumped", async () => {
    const { service } = harness()
    expect(await service.isRevoked(MEM, 1791201600)).toBe(false)
  })

  it("revokes tokens minted before the bump and keeps those minted at or after it", async () => {
    const { service, clock, client } = harness()
    const mintedBefore = Math.floor(clock.now().getTime() / 1000) - 60
    clock.advance(60_000)
    await service.bump(MEM)
    const bumpAt = Math.floor(clock.now().getTime() / 1000)

    expect(await service.isRevoked(MEM, mintedBefore)).toBe(true)
    expect(await service.isRevoked(MEM, bumpAt)).toBe(false)
    expect(await service.isRevoked(MEM, bumpAt + 1)).toBe(false)
    expect(client.set).toHaveBeenCalledWith(`rev:${MEM}`, String(bumpAt), "EX", 7 * 86_400 + 900)
  })

  it("answers null during an outage so the caller can fail closed or open by method", async () => {
    const { service, outage } = harness()
    outage(true)
    expect(await service.isRevoked(MEM, 1)).toBeNull()
  })

  it("refuses to pretend a bump happened when it could not be recorded", async () => {
    const { service, outage } = harness()
    outage(true)
    await expect(service.bump(MEM)).rejects.toThrow("down")
  })
})
