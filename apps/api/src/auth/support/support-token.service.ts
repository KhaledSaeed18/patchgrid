import { Injectable } from "@nestjs/common"
import { jwtVerify, SignJWT } from "jose"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { InjectConfig, type AppConfig } from "../../config/app-config"

const ISSUER = "patchgrid"
/** Its own audience: neither a member's token nor the platform session can stand in for it (ADR-0041). */
const AUDIENCE = "patchgrid-support"

const claimsSchema = z.object({ sub: z.uuid(), adm: z.uuid(), sid: z.uuid(), org: z.uuid(), iat: z.int(), exp: z.int() })

export type SupportClaims = { userId: string; platformAdminId: string; sessionId: string; orgId: string; iat: number; exp: number }

/**
 * The support token (ADR-0041): one operator, one session, one workspace,
 * until the session or the platform session ends — whichever is first. It
 * carries `org` like an access token, so tenant resolution routes it the same
 * way; everything else is decided again on every request.
 */
@Injectable()
export class SupportTokenService {
  private readonly key: Uint8Array

  constructor(
    @InjectConfig() config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(config.JWT_SECRET)
  }

  async sign(claims: { userId: string; platformAdminId: string; sessionId: string; orgId: string; expiresAt: number }): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000)
    return new SignJWT({ adm: claims.platformAdminId, sid: claims.sessionId, org: claims.orgId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.userId)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(claims.expiresAt)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(this.key)
  }

  async verify(token: string): Promise<SupportClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
      })
      const parsed = claimsSchema.safeParse(payload)
      if (!parsed.success) return null
      const { sub, adm, sid, org, iat, exp } = parsed.data
      return { userId: sub, platformAdminId: adm, sessionId: sid, orgId: org, iat, exp }
    } catch {
      return null
    }
  }
}

/** The epoch key a session's tokens are revoked under — never a membership's or an operator's. */
export function supportEpochKey(sessionId: string): string {
  return `support:${sessionId}`
}
