import { Injectable, Logger } from "@nestjs/common"
import { PASSKEY_CHALLENGE_TTL_SECONDS } from "@patchgrid/contracts"
import { randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"

import { ServiceUnavailableProblem } from "../../common/problems/problem.exception"
import { RedisService } from "../../redis/redis.service"

/**
 * What a ceremony's challenge was issued for (ADR-0053). One issued for one
 * purpose is refused for another: a login challenge cannot prove a removal.
 */
export type CeremonyPurpose = "register" | "login" | "proof"

export type IssuedChallenge = { id: string; challenge: string }

/** `userId` is `null` only for a passwordless login, which names no one until the credential does. */
export type SpentChallenge = { challenge: string; userId: string | null }

const stored = z.object({ purpose: z.enum(["register", "login", "proof"]), userId: z.uuid().nullable(), challenge: z.string() })

const key = (id: string) => `passkey:challenge:${id}`

/**
 * Ceremony challenges, kept in Redis for five minutes under a random id the
 * options response returns, and spent with `GETDEL`: a challenge verifies at
 * most once, whoever races for it. With Redis down a ceremony answers `503`,
 * as the lockout and the login challenge already do — never "unchecked".
 */
@Injectable()
export class PasskeyChallengeStore {
  private readonly logger = new Logger(PasskeyChallengeStore.name)

  constructor(private readonly redis: RedisService) {}

  async issue(purpose: CeremonyPurpose, userId: string | null): Promise<IssuedChallenge> {
    const id = randomUUID()
    const challenge = randomBytes(32).toString("base64url")
    await this.guard(() => this.redis.client.set(key(id), JSON.stringify({ purpose, userId, challenge }), "EX", PASSKEY_CHALLENGE_TTL_SECONDS))
    return { id, challenge }
  }

  /** The challenge, once, if it exists, is unexpired and was issued for this purpose; `null` otherwise. */
  async spend(id: string, purpose: CeremonyPurpose): Promise<SpentChallenge | null> {
    const raw = await this.guard(() => this.redis.client.getdel(key(id)))
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    const result = stored.safeParse(parsed)
    if (!result.success || result.data.purpose !== purpose) return null
    return { challenge: result.data.challenge, userId: result.data.userId }
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      this.logger.error({ msg: "passkey challenge store unavailable", error: String(error) })
      throw new ServiceUnavailableProblem("Passkeys cannot be checked right now; retry shortly")
    }
  }
}
