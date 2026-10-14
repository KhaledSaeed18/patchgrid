import { Injectable } from "@nestjs/common"
import { PLATFORM_SESSION_TTL_SECONDS } from "@patchgrid/contracts"
import { jwtVerify, SignJWT } from "jose"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { InjectConfig, type AppConfig } from "../../config/app-config"

const ISSUER = "patchgrid"
/** Audiences no tenant token carries, so neither kind can stand in for the other (ADR-0040). */
const SESSION_AUDIENCE = "patchgrid-platform"
const CHALLENGE_AUDIENCE = "patchgrid-platform-challenge"
/** The password step's proof, good for the second factor that must follow it. */
export const CHALLENGE_TTL_SECONDS = 5 * 60

const sessionSchema = z.object({ sub: z.uuid(), adm: z.uuid(), iat: z.int(), exp: z.int() })
const challengeSchema = z.object({ sub: z.uuid(), adm: z.uuid(), next: z.enum(["verify", "enrol"]), iat: z.int(), exp: z.int() })

export type PlatformSession = { userId: string; platformAdminId: string; iat: number; exp: number }
export type PlatformChallenge = { userId: string; platformAdminId: string; next: "verify" | "enrol" }

/**
 * The platform credential's two tokens (ADR-0040): the challenge between the
 * password and the factor, and the one-hour session after both. HS256 under
 * the API's secret, distinct audiences from every tenant token.
 */
@Injectable()
export class PlatformTokenService {
  private readonly key: Uint8Array

  constructor(
    @InjectConfig() config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(config.JWT_SECRET)
  }

  async session(userId: string, platformAdminId: string): Promise<{ token: string; expiresAt: number }> {
    const iat = Math.floor(this.clock.now().getTime() / 1000)
    const exp = iat + PLATFORM_SESSION_TTL_SECONDS
    const token = await this.signed({ adm: platformAdminId }, userId, iat, exp, SESSION_AUDIENCE)
    return { token, expiresAt: exp }
  }

  async challenge(userId: string, platformAdminId: string, next: "verify" | "enrol"): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000)
    return this.signed({ adm: platformAdminId, next }, userId, iat, iat + CHALLENGE_TTL_SECONDS, CHALLENGE_AUDIENCE)
  }

  async verifySession(token: string): Promise<PlatformSession | null> {
    const payload = await this.verified(token, SESSION_AUDIENCE)
    const parsed = sessionSchema.safeParse(payload)
    return parsed.success ? { userId: parsed.data.sub, platformAdminId: parsed.data.adm, iat: parsed.data.iat, exp: parsed.data.exp } : null
  }

  async verifyChallenge(token: string): Promise<PlatformChallenge | null> {
    const payload = await this.verified(token, CHALLENGE_AUDIENCE)
    const parsed = challengeSchema.safeParse(payload)
    return parsed.success ? { userId: parsed.data.sub, platformAdminId: parsed.data.adm, next: parsed.data.next } : null
  }

  private signed(claims: Record<string, string>, subject: string, iat: number, exp: number, audience: string): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(subject)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setIssuer(ISSUER)
      .setAudience(audience)
      .sign(this.key)
  }

  private async verified(token: string, audience: string): Promise<unknown> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"], issuer: ISSUER, audience, currentDate: this.clock.now() })
      return payload
    } catch {
      return null
    }
  }
}
