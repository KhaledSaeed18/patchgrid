import { Injectable, Logger } from "@nestjs/common"

import { RateLimitedProblem, ServiceUnavailableProblem } from "../../common/problems/problem.exception"
import { RedisService } from "../../redis/redis.service"

/** ADR-0029: five failed codes in fifteen minutes lock the factor for an hour. */
export const FACTOR_FAILURES = 5
export const FACTOR_WINDOW_SECONDS = 15 * 60
export const FACTOR_LOCK_SECONDS = 60 * 60

const failures = (userId: string) => `mfa:fail:${userId}`
const lock = (userId: string) => `mfa:lock:${userId}`

/**
 * Per person, not per address (ADR-0029): a password-holder spreading guesses
 * over a thousand IPs still gets five. Counted in Redis; with Redis down the
 * factor is refused rather than left unguarded — sign-in to the platform can
 * wait, a brute-forced operator cannot be undone.
 */
@Injectable()
export class FactorLockout {
  private readonly logger = new Logger(FactorLockout.name)

  constructor(private readonly redis: RedisService) {}

  async assertOpen(userId: string): Promise<void> {
    const ttl = await this.guard(() => this.redis.client.ttl(lock(userId)))
    if (ttl > 0) throw new RateLimitedProblem(ttl)
  }

  /** Counts a refused code; `true` when this one locked the factor. */
  async fail(userId: string): Promise<boolean> {
    const count = await this.guard(async () => {
      const [[, n]] = (await this.redis.client
        .multi()
        .incr(failures(userId))
        .expire(failures(userId), FACTOR_WINDOW_SECONDS, "NX")
        .exec()) as [[null, number]]
      return n
    })
    if (count < FACTOR_FAILURES) return false
    await this.guard(() => this.redis.client.multi().set(lock(userId), "1", "EX", FACTOR_LOCK_SECONDS).del(failures(userId)).exec())
    this.logger.warn({ msg: "second factor locked after repeated failures", userId })
    return true
  }

  async clear(userId: string): Promise<void> {
    await this.guard(() => this.redis.client.del(failures(userId)))
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      this.logger.error({ msg: "factor lockout unavailable", error: String(error) })
      throw new ServiceUnavailableProblem("The second factor cannot be checked right now; retry shortly")
    }
  }
}
