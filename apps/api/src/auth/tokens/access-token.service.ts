import { Injectable } from "@nestjs/common"
import { jwtVerify, SignJWT } from "jose"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import { type AccessTokenClaims, accessTokenClaimsSchema } from "./access-token"

export type SessionClaims = Pick<AccessTokenClaims, "sub" | "org" | "mem" | "role">

const ISSUER = "patchgrid"
const AUDIENCE = "patchgrid-api"

/**
 * The 15-minute, org-bound access token (ADR-0004, ADR-0024). HS256 with one
 * server-side secret: the API is the only party that ever verifies it, so an
 * asymmetric key would buy nothing. Time comes from `Clock`, so expiry is
 * tested by moving the clock, not by sleeping.
 */
@Injectable()
export class AccessTokenService {
  private readonly key: Uint8Array
  private readonly ttlSeconds: number

  constructor(
    @InjectConfig() config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(config.JWT_SECRET)
    this.ttlSeconds = config.ACCESS_TOKEN_TTL_SECONDS
  }

  async sign(session: SessionClaims): Promise<{ token: string; claims: AccessTokenClaims }> {
    const iat = Math.floor(this.clock.now().getTime() / 1000)
    const claims: AccessTokenClaims = { ...session, iat, exp: iat + this.ttlSeconds }
    const token = await new SignJWT({ org: claims.org, mem: claims.mem, role: claims.role })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.sub)
      .setIssuedAt(claims.iat)
      .setExpirationTime(claims.exp)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(this.key)
    return { token, claims }
  }

  /**
   * The one place a signature is checked (pipeline step 7). `null` for every
   * kind of failure — bad signature, expired, wrong issuer, claims that do not
   * parse — because the caller's answer is the same 401 for all of them.
   */
  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
      })
      const parsed = accessTokenClaimsSchema.safeParse(payload)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
}
