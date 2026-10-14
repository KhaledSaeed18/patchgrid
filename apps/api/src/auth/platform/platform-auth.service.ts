import { Injectable, Logger } from "@nestjs/common"
import type { MfaEnrolment, MfaVerifyRequest, PlatformLoginStep, PlatformMe } from "@patchgrid/contracts"
import { randomBytes } from "node:crypto"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { NotAuthenticatedProblem, NotFoundProblem, ValidationProblem } from "../../common/problems/problem.exception"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import { MfaRepository } from "../../platform/repositories/mfa.repository"
import { PlatformAdminRepository } from "../../platform/repositories/platform-admin.repository"
import { PlatformAuditRepository } from "../../platform/repositories/platform-audit.repository"
import { UserRepository } from "../../platform/repositories/user.repository"
import type { PlatformActor } from "../actor"
import { SecretBox } from "../mfa/secret-box"
import { acceptedStep, newTotpSecret, otpauthUri } from "../mfa/totp"
import { PasswordService } from "../passwords/password.service"
import { RevocationEpochService } from "../revocation/revocation-epoch.service"
import { type PlatformChallenge, PlatformTokenService } from "./platform-token.service"

/** An unconfirmed factor is good for this long (ADR-0029). */
const ENROLMENT_TTL_MS = 60 * 60_000
const RECOVERY_CODES = 10

/** The epoch key a platform admin's sessions are revoked under — never a membership's. */
export function platformEpochKey(platformAdminId: string): string {
  return `platform:${platformAdminId}`
}

export type SignedIn = { session: { token: string; expiresAt: number } }

/**
 * Signing an operator in (ADR-0040): the password, then a second factor —
 * enrolled first if there is none — then a one-hour session. Every refusal
 * before the factor is the same 401, so the endpoint says nothing about who
 * is an operator.
 */
@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger(PlatformAuthService.name)
  private readonly box: SecretBox

  constructor(
    private readonly users: UserRepository,
    private readonly admins: PlatformAdminRepository,
    private readonly mfa: MfaRepository,
    private readonly audit: PlatformAuditRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: PlatformTokenService,
    private readonly epochs: RevocationEpochService,
    @InjectConfig() config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {
    this.box = new SecretBox(config.MFA_ENCRYPTION_KEY)
  }

  async login(email: string, password: string): Promise<{ step: PlatformLoginStep; challenge: string }> {
    const account = await this.users.findByEmail(email)
    // One verification whether or not the account exists, as tenant login does (ADR-0031).
    const passwordOk = await this.passwords.verify(account?.passwordHash ?? null, password)
    const admin = account === null ? null : await this.admins.activeForUser(account.id)
    if (account === null || !passwordOk || admin === null || account.emailVerifiedAt === null || account.anonymisedAt !== null) {
      throw new NotAuthenticatedProblem("Invalid email or password")
    }
    const next = (await this.mfa.confirmed(account.id)) === null ? "enrol" : "verify"
    return { step: { next }, challenge: await this.tokens.challenge(account.id, admin.id, next) }
  }

  /** A new, unconfirmed factor — only for an operator who has none. */
  async enrol(challengeToken: string | undefined): Promise<MfaEnrolment> {
    const challenge = await this.challenge(challengeToken, "enrol")
    if ((await this.mfa.confirmed(challenge.userId)) !== null) throw new NotAuthenticatedProblem("A factor is already enrolled; sign in again")
    const admin = await this.activeAdmin(challenge)
    const secret = newTotpSecret()
    await this.mfa.startEnrolment(challenge.userId, this.box.seal(secret), "Authenticator app")
    return { secret, otpauthUri: otpauthUri(secret, admin.email) }
  }

  /** Proves the new factor, returns its recovery codes once, and signs in. */
  async confirm(challengeToken: string | undefined, code: string): Promise<SignedIn & { recoveryCodes: string[] }> {
    const challenge = await this.challenge(challengeToken, "enrol")
    const now = this.clock.now()
    const factor = await this.mfa.pending(challenge.userId, new Date(now.getTime() - ENROLMENT_TTL_MS))
    const secret = factor === null ? null : this.box.open(factor.secretEncrypted)
    const step = factor === null || secret === null ? null : acceptedStep(secret, code, now, null)
    if (factor === null || step === null) throw codeRefused()
    const recoveryCodes = Array.from({ length: RECOVERY_CODES }, recoveryCode)
    const hashes = await Promise.all(recoveryCodes.map((c) => this.passwords.hash(normalise(c))))
    if (!(await this.mfa.confirm(challenge.userId, factor.id, step, now, hashes))) throw codeRefused()
    await this.audit.record({ platformAdminId: challenge.platformAdminId, action: "PLATFORM_MFA_ENROLLED", targetUserId: challenge.userId })
    return { ...(await this.signIn(challenge, "totp")), recoveryCodes }
  }

  /** The second factor: a current code, or one unused recovery code. */
  async verify(challengeToken: string | undefined, request: MfaVerifyRequest): Promise<SignedIn> {
    const challenge = await this.challenge(challengeToken, "verify")
    const now = this.clock.now()
    if (request.code !== undefined) {
      const factor = await this.mfa.confirmed(challenge.userId)
      const secret = factor === null ? null : this.box.open(factor.secretEncrypted)
      const step = factor === null || secret === null ? null : acceptedStep(secret, request.code, now, factor.lastUsedStep)
      // Spent atomically: the same code twice, even at once, signs in once.
      if (factor === null || step === null || !(await this.mfa.spendStep(factor.id, step, now))) throw codeRefused()
      return this.signIn(challenge, "totp")
    }
    const presented = normalise(request.recoveryCode ?? "")
    for (const stored of await this.mfa.unusedRecoveryCodes(challenge.userId)) {
      if ((await this.passwords.verify(stored.codeHash, presented)) && (await this.mfa.spendRecoveryCode(stored.id, now))) {
        await this.audit.record({ platformAdminId: challenge.platformAdminId, action: "PLATFORM_RECOVERY_CODE_USED", targetUserId: challenge.userId })
        return this.signIn(challenge, "recovery")
      }
    }
    throw codeRefused()
  }

  /** Ends every session this operator holds, here and elsewhere. */
  async logout(actor: PlatformActor): Promise<void> {
    await this.epochs.bump(platformEpochKey(actor.platformAdminId))
    await this.audit.record({ platformAdminId: actor.platformAdminId, action: "PLATFORM_SIGNED_OUT" })
  }

  async me(actor: PlatformActor): Promise<PlatformMe> {
    const admin = await this.admins.active(actor.platformAdminId)
    if (admin === null) throw new NotFoundProblem()
    return {
      platformAdminId: admin.id,
      email: admin.email,
      name: admin.name,
      sessionExpiresAt: new Date(actor.sessionExpiresAt * 1000).toISOString(),
    }
  }

  private async signIn(challenge: PlatformChallenge, factor: "totp" | "recovery"): Promise<SignedIn> {
    await this.activeAdmin(challenge)
    const session = await this.tokens.session(challenge.userId, challenge.platformAdminId)
    await this.audit.record({ platformAdminId: challenge.platformAdminId, action: "PLATFORM_SIGNED_IN", targetUserId: challenge.userId, diff: { factor } })
    this.logger.log({ msg: "platform admin signed in", platformAdminId: challenge.platformAdminId, factor })
    return { session }
  }

  private async challenge(token: string | undefined, expected: "verify" | "enrol"): Promise<PlatformChallenge> {
    const challenge = token === undefined ? null : await this.tokens.verifyChallenge(token)
    if (challenge?.next !== expected) throw new NotAuthenticatedProblem("Sign in again")
    return challenge
  }

  /** Still an operator — a grant revoked mid-login ends the login. */
  private async activeAdmin(challenge: PlatformChallenge) {
    const admin = await this.admins.active(challenge.platformAdminId)
    if (admin?.userId !== challenge.userId) throw new NotAuthenticatedProblem("Sign in again")
    return admin
  }
}

/** `abcde-fghij`: ten base32 letters, easy to read off paper. */
function recoveryCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  const bytes = randomBytes(10)
  const letters = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
  return `${letters.slice(0, 5)}-${letters.slice(5)}`
}

function normalise(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]/g, "")
}

function codeRefused(): ValidationProblem {
  return new ValidationProblem([{ path: "code", message: "is not a valid code", code: "invalid_code" }])
}
