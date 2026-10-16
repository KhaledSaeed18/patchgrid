import { describe, expect, it } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import type { AppConfig } from "../../config/app-config"
import { AccessTokenService } from "../tokens/access-token.service"
import { MFA_CHALLENGE_TTL_SECONDS, MfaChallengeService } from "./mfa-challenge.service"

const config = { JWT_SECRET: "local-development-secret-that-is-at-least-32-chars", ACCESS_TOKEN_TTL_SECONDS: 900 } as AppConfig
const NOW = new Date("2026-10-16T09:00:00Z")
const USER = "0190b2f0-0000-7000-8000-000000000001"

describe("MfaChallengeService", () => {
  it("names the person and the workspace asked for, for five minutes", async () => {
    const clock = new FixedClock(NOW)
    const service = new MfaChallengeService(config, clock)
    const token = await service.issue(USER, "acme")
    expect(await service.verify(token)).toMatchObject({ userId: USER, slug: "acme", jti: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(await service.verify(await service.issue(USER, undefined))).toMatchObject({ userId: USER, slug: undefined })
    // Each challenge is its own: two issues, two ids, so one can be spent without the other.
    expect((await service.verify(await service.issue(USER, "acme")))?.jti).not.toBe((await service.verify(token))?.jti)
    clock.set(new Date(NOW.getTime() + (MFA_CHALLENGE_TTL_SECONDS + 1) * 1000))
    expect(await service.verify(token)).toBeNull()
  })

  it("is not an access token, and an access token is not a challenge", async () => {
    const clock = new FixedClock(NOW)
    const challenges = new MfaChallengeService(config, clock)
    const access = new AccessTokenService(config, clock)
    const { token } = await access.sign({ sub: USER, org: "0190b2f0-0000-7000-8000-00000000000a", mem: "0190b2f0-0000-7000-8000-00000000000b", role: "OWNER" })
    expect(await challenges.verify(token)).toBeNull()
    expect(await access.verify(await challenges.issue(USER, "acme"))).toBeNull()
  })
})
