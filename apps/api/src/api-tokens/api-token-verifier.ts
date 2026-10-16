import { Injectable } from "@nestjs/common"
import { createHash, timingSafeEqual } from "node:crypto"

import type { ServiceActor } from "../auth/actor"
import { PasswordService } from "../auth/passwords/password.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { scopesOf, statusOf } from "./domain"
import { ApiTokenRepository } from "./repositories/api-token.repository"

const CACHE_MS = 5 * 60_000
const CACHE_LIMIT = 1_000
/** Wrong secrets remembered per prefix, so a replayed guess costs a hash lookup, not Argon2id. */
const REJECTED_PER_PREFIX = 64
const LAST_USED_EVERY_MS = 60_000

/**
 * The bearer path's decision (ADR-0021, ADR-0042), inside the tenant the
 * token's prefix resolved to. The row is read on every request — revoked,
 * expired, its service account no longer active — which is what makes a
 * revocation hold on the next request. Argon2id is paid once per token per
 * process every five minutes; between, a matching SHA-256 stands in for it.
 * The remembered digest grants nothing on its own: the row still decides.
 */
@Injectable()
export class ApiTokenVerifier {
  private readonly verified = new Map<string, { digest: Buffer; until: number }>()
  private readonly rejected = new Map<string, Set<string>>()

  constructor(
    private readonly tokens: ApiTokenRepository,
    private readonly passwords: PasswordService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async verify(orgId: string, prefix: string, secret: string): Promise<ServiceActor | null> {
    const row = await this.tokens.credential(orgId, prefix)
    const now = this.clock.now()
    if (row === null || statusOf(row, now) !== "ACTIVE") return null
    if (row.membership.kind !== "SERVICE_ACCOUNT" || row.membership.status !== "ACTIVE") return null
    if (!(await this.secretMatches(prefix, row.tokenHash, secret, now.getTime()))) return null
    await this.tokens.markUsed(orgId, row.id, now, new Date(now.getTime() - LAST_USED_EVERY_MS))
    return {
      kind: "service",
      orgId,
      membershipId: row.membershipId,
      role: row.membership.role,
      scopes: scopesOf(row.scopes),
      tokenId: row.id,
    }
  }

  private async secretMatches(prefix: string, hash: string, secret: string, now: number): Promise<boolean> {
    const digest = createHash("sha256").update(secret).digest()
    const known = this.verified.get(prefix)
    if (known !== undefined && known.until > now && timingSafeEqual(known.digest, digest)) return true
    const seen = this.rejected.get(prefix)
    const hex = digest.toString("hex")
    if (seen?.has(hex) === true) return false
    if (!(await this.passwords.verify(hash, secret))) {
      this.rememberRejected(prefix, hex)
      return false
    }
    if (this.verified.size >= CACHE_LIMIT) {
      const oldest = this.verified.keys().next()
      if (oldest.done !== true) this.verified.delete(oldest.value)
    }
    this.verified.set(prefix, { digest, until: now + CACHE_MS })
    this.rejected.delete(prefix)
    return true
  }

  private rememberRejected(prefix: string, hex: string): void {
    if (this.rejected.size >= CACHE_LIMIT) {
      const oldest = this.rejected.keys().next()
      if (oldest.done !== true) this.rejected.delete(oldest.value)
    }
    const set = this.rejected.get(prefix) ?? new Set<string>()
    if (set.size >= REJECTED_PER_PREFIX) {
      const first = set.values().next()
      if (first.done !== true) set.delete(first.value)
    }
    set.add(hex)
    this.rejected.set(prefix, set)
  }
}
