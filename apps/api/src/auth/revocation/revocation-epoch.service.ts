import { Injectable, Logger } from "@nestjs/common"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import { RedisService } from "../../redis/redis.service"

/**
 * Immediate revocation for a stateless token (ADR-0024 §5).
 *
 * `rev:<membershipId>` holds unix seconds; an access token whose `iat` is
 * earlier was minted before the membership changed and is refused. Bumped on
 * disable, removal, role or team change, suspension, password change, "log out
 * everywhere", token revoke and support-session end. One Redis GET on a path
 * that already reaches Redis.
 *
 * On a Redis outage `isRevoked` answers `null`, and the CALLER decides: closed
 * for mutations, open for reads — stated in the ADR so nobody reverses it
 * quietly (threat model R-3).
 */
@Injectable()
export class RevocationEpochService {
  private readonly logger = new Logger(RevocationEpochService.name)
  /** Longer than any token that could predate the bump; tokens past this are expired anyway. */
  private readonly ttlSeconds: number

  constructor(
    private readonly redis: RedisService,
    @InjectClock() private readonly clock: Clock,
    @InjectConfig() config: AppConfig,
  ) {
    this.ttlSeconds = config.REFRESH_TOKEN_TTL_DAYS * 86_400 + config.ACCESS_TOKEN_TTL_SECONDS
  }

  /** Invalidate every token minted for this membership before now. */
  async bump(membershipId: string): Promise<void> {
    const now = Math.floor(this.clock.now().getTime() / 1000)
    try {
      await this.redis.client.set(key(membershipId), String(now), "EX", this.ttlSeconds)
    } catch (error) {
      // A bump that cannot be recorded is a revocation that did not happen.
      // Surface it: the caller's mutation should fail rather than pretend.
      this.logger.error(`could not record revocation epoch for membership ${membershipId}`)
      throw error
    }
  }

  /**
   * `true` revoked, `false` fine, `null` unknown because Redis is unreachable.
   * `iat` has second precision, so a token minted in the same second as the
   * bump is indistinguishable from one minted just before it. Ties go to the
   * revocation: the client refreshes and gets a fresh token, which is cheap; a
   * session surviving "log out everywhere" is not.
   */
  async isRevoked(membershipId: string, iat: number): Promise<boolean | null> {
    try {
      const epoch = await this.redis.client.get(key(membershipId))
      if (epoch === null) return false
      return iat <= Number(epoch)
    } catch (error) {
      this.logger.warn(
        `revocation epoch unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }
}

const key = (membershipId: string) => `rev:${membershipId}`
