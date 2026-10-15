import { Injectable } from "@nestjs/common"
import { jwtVerify, SignJWT } from "jose"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { InjectConfig, type AppConfig } from "../../config/app-config"

const ISSUER = "patchgrid"
/** Its own audience: neither an access token nor the platform's challenge can stand in for it. */
const AUDIENCE = "patchgrid-mfa-challenge"
/** The password step's proof, good for the second factor that must follow it (ADR-0045). */
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60

const schema = z.object({ sub: z.uuid(), slug: z.string().optional(), iat: z.int(), exp: z.int() })

export type MfaChallenge = { userId: string; slug: string | undefined }

/**
 * The member's half-signed-in state (ADR-0029: "an `mfa_pending` token good
 * for nothing but completing MFA"). It names the person and the workspace the
 * login asked for; it opens nothing and is never read by the guard.
 */
@Injectable()
export class MfaChallengeService {
  private readonly key: Uint8Array

  constructor(
    @InjectConfig() config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(config.JWT_SECRET)
  }

  issue(userId: string, slug: string | undefined): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000)
    return new SignJWT(slug === undefined ? {} : { slug })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(iat + MFA_CHALLENGE_TTL_SECONDS)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(this.key)
  }

  async verify(token: string): Promise<MfaChallenge | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE, currentDate: this.clock.now() })
      const parsed = schema.safeParse(payload)
      return parsed.success ? { userId: parsed.data.sub, slug: parsed.data.slug } : null
    } catch {
      return null
    }
  }
}
