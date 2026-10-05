import { describe, expect, it } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import type { AppConfig } from "../../config/app-config"
import { AccessTokenService } from "./access-token.service"

const config = {
  JWT_SECRET: "local-development-secret-that-is-at-least-32-chars",
  ACCESS_TOKEN_TTL_SECONDS: 900,
} as AppConfig
const session = {
  sub: "0190b2f0-0000-7000-8000-000000000001",
  org: "0190b2f0-0000-7000-8000-00000000000a",
  mem: "0190b2f0-0000-7000-8000-0000000000aa",
  role: "AGENT" as const,
}

describe("AccessTokenService", () => {
  it("round-trips the org-bound claims with iat and exp from the clock", async () => {
    const clock = new FixedClock(new Date("2026-10-05T12:00:00Z"))
    const service = new AccessTokenService(config, clock)
    const { token, claims } = await service.sign(session)
    expect(claims).toEqual({ ...session, iat: 1791201600, exp: 1791201600 + 900 })
    expect(await service.verify(token)).toEqual(claims)
  })

  it("rejects the token once the clock passes exp, without sleeping", async () => {
    const clock = new FixedClock(new Date("2026-10-05T12:00:00Z"))
    const service = new AccessTokenService(config, clock)
    const { token } = await service.sign(session)
    clock.advance(899_000)
    expect(await service.verify(token)).not.toBeNull()
    clock.advance(2_000)
    expect(await service.verify(token)).toBeNull()
  })

  it("rejects a token signed with another secret, or tampered with", async () => {
    const clock = new FixedClock(new Date("2026-10-05T12:00:00Z"))
    const ours = new AccessTokenService(config, clock)
    const theirs = new AccessTokenService({ ...config, JWT_SECRET: "a-different-secret-that-is-also-32-chars-long" } as AppConfig, clock)
    const { token } = await theirs.sign(session)
    expect(await ours.verify(token)).toBeNull()

    const [header, payload, signature] = (await ours.sign(session)).token.split(".")
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload ?? "", "base64url").toString()), role: "OWNER" })).toString("base64url")
    expect(await ours.verify(`${header}.${forged}.${signature}`)).toBeNull()
  })

  it("rejects garbage and the alg=none shape", async () => {
    const service = new AccessTokenService(config, new FixedClock(new Date()))
    expect(await service.verify("nope")).toBeNull()
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`
    expect(await service.verify(none)).toBeNull()
  })
})
