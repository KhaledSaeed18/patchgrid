import { Injectable, Logger } from "@nestjs/common"
import type { LoginResponse, MfaEnrolment, MfaStatus, MfaVerifyRequest, RecoveryCodes } from "@patchgrid/contracts"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { ConflictProblem, NotAuthenticatedProblem, ValidationProblem } from "../../common/problems/problem.exception"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import { MailService } from "../../mail/mail.service"
import type { AccountSecurityEvent } from "../../mail/templates/account-security"
import { MfaRepository } from "../../platform/repositories/mfa.repository"
import { UserRepository } from "../../platform/repositories/user.repository"
import type { CookieName, CookieSpec } from "../cookies"
import { CookieService } from "../cookies"
import { PasswordService } from "../passwords/password.service"
import { type ClientInfo, SessionService } from "../sessions/session.service"
import { FactorLockout } from "./factor-lockout"
import { MfaChallengeService } from "./mfa-challenge.service"
import { newRecoveryCodes, normaliseRecoveryCode } from "./recovery-codes"
import { SecretBox } from "./secret-box"
import { acceptedStep, newTotpSecret, otpauthUri } from "./totp"

/** An unconfirmed factor is good for this long (ADR-0029). */
const ENROLMENT_TTL_MS = 60 * 60_000

/** How a factor was proved — a recovery code is a proof that also ends every other session. */
export type ProvedBy = "totp" | "recovery"

/**
 * A member's second factor (ADR-0029, ADR-0045): the second step of login,
 * and the self-service around it — enrol, confirm, replace the recovery codes,
 * turn it off. Everything here is about the person, not a workspace: the
 * identity holder reaches it from the picker, and a workspace only ever asks
 * "is there a confirmed factor?" through `SessionService`.
 *
 * The verification rules are the platform's (ADR-0040): one lockout per
 * person, a code spent atomically so it never works twice, and a recovery
 * code that signs out everywhere and tells the person by mail.
 */
@Injectable()
export class MemberMfaService {
  private readonly logger = new Logger(MemberMfaService.name)
  private readonly box: SecretBox

  constructor(
    private readonly users: UserRepository,
    private readonly mfa: MfaRepository,
    private readonly passwords: PasswordService,
    private readonly lockout: FactorLockout,
    private readonly challenges: MfaChallengeService,
    private readonly sessions: SessionService,
    private readonly cookies: CookieService,
    private readonly mail: MailService,
    @InjectConfig() config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {
    this.box = new SecretBox(config.MFA_ENCRYPTION_KEY)
  }

  /** The second step of login: the challenge cookie plus the factor, then the session the password alone could not start. */
  async completeLogin(
    challengeToken: string | undefined,
    request: MfaVerifyRequest,
    client: ClientInfo,
  ): Promise<{ response: LoginResponse; cookies: CookieSpec[]; clear: CookieName[] }> {
    const challenge = challengeToken === undefined ? null : await this.challenges.verify(challengeToken)
    if (challenge === null) throw new NotAuthenticatedProblem("Sign in again")
    const account = await this.users.findById(challenge.userId)
    if (account === null || account.anonymisedAt !== null || account.emailVerifiedAt === null) throw new NotAuthenticatedProblem("Sign in again")
    await this.verify(challenge.userId, request)
    const started = await this.sessions.startIdentity(account, client, challenge.slug)
    return { ...started, clear: [{ name: this.cookies.mfaChallenge("", 0).name, path: this.cookies.mfaChallenge("", 0).path }] }
  }

  async status(userId: string): Promise<MfaStatus> {
    const factor = await this.mfa.confirmed(userId)
    return {
      enrolled: factor !== null,
      confirmedAt: factor?.confirmedAt?.toISOString() ?? null,
      recoveryCodesRemaining: factor === null ? 0 : (await this.mfa.unusedRecoveryCodes(userId)).length,
    }
  }

  /** A new, unconfirmed factor. Refused while one is confirmed: turn that off first, with a code. */
  async enrol(userId: string): Promise<MfaEnrolment> {
    if ((await this.mfa.confirmed(userId)) !== null) throw new ConflictProblem("A second factor is already set up; turn it off before setting up another")
    const account = await this.users.findById(userId)
    if (account === null) throw new NotAuthenticatedProblem()
    const secret = newTotpSecret()
    await this.mfa.startEnrolment(userId, this.box.seal(secret), "Authenticator app")
    return { secret, otpauthUri: otpauthUri(secret, account.email) }
  }

  /** Proves the new factor and returns its recovery codes, once. */
  async confirm(userId: string, code: string): Promise<RecoveryCodes> {
    await this.lockout.assertOpen(userId)
    const now = this.clock.now()
    const factor = await this.mfa.pending(userId, new Date(now.getTime() - ENROLMENT_TTL_MS))
    const secret = factor === null ? null : this.box.open(factor.secretEncrypted)
    const step = factor === null || secret === null ? null : acceptedStep(secret, code, now, null)
    if (factor === null || step === null) throw await this.refused(userId)
    const recoveryCodes = newRecoveryCodes()
    const hashes = await Promise.all(recoveryCodes.map((c) => this.passwords.hash(normaliseRecoveryCode(c))))
    if (!(await this.mfa.confirm(userId, factor.id, step, now, hashes))) throw await this.refused(userId)
    await this.lockout.clear(userId)
    this.logger.log({ msg: "second factor enabled", userId })
    await this.tell(userId, "factor-enabled", recoveryCodes.length)
    return { recoveryCodes }
  }

  /** Ten fresh codes replace whatever was left; a current code, not a recovery code, is the proof. */
  async regenerateRecoveryCodes(userId: string, code: string): Promise<RecoveryCodes> {
    await this.verify(userId, { code })
    const recoveryCodes = newRecoveryCodes()
    const hashes = await Promise.all(recoveryCodes.map((c) => this.passwords.hash(normaliseRecoveryCode(c))))
    await this.mfa.replaceRecoveryCodes(userId, hashes)
    await this.tell(userId, "recovery-codes-regenerated", recoveryCodes.length)
    return { recoveryCodes }
  }

  /** Off, proved by the factor itself or a recovery code — never by the password (ADR-0029). */
  async disable(userId: string, request: MfaVerifyRequest): Promise<void> {
    if ((await this.mfa.confirmed(userId)) === null) throw new ConflictProblem("No second factor is set up")
    await this.verify(userId, request)
    await this.mfa.removeAll(userId)
    this.logger.log({ msg: "second factor disabled", userId })
    await this.tell(userId, "factor-disabled", 0)
  }

  /**
   * The factor, proved: a current code spent atomically, or one unused
   * recovery code — which ends every other session this person holds and
   * tells them, because a recovery code in use means the factor is lost or
   * taken. Five refusals lock the factor for an hour (ADR-0029).
   */
  async verify(userId: string, request: MfaVerifyRequest): Promise<ProvedBy> {
    await this.lockout.assertOpen(userId)
    const now = this.clock.now()
    if (request.code !== undefined) {
      const factor = await this.mfa.confirmed(userId)
      const secret = factor === null ? null : this.box.open(factor.secretEncrypted)
      const step = factor === null || secret === null ? null : acceptedStep(secret, request.code, now, factor.lastUsedStep)
      if (factor === null || step === null || !(await this.mfa.spendStep(factor.id, step, now))) throw await this.refused(userId)
      await this.lockout.clear(userId)
      return "totp"
    }
    const presented = normaliseRecoveryCode(request.recoveryCode ?? "")
    for (const stored of await this.mfa.unusedRecoveryCodes(userId)) {
      if ((await this.passwords.verify(stored.codeHash, presented)) && (await this.mfa.spendRecoveryCode(stored.id, now))) {
        await this.lockout.clear(userId)
        this.logger.warn({ msg: "recovery code used", userId })
        await this.sessions.revokeEverywhere(userId)
        await this.tell(userId, "recovery-code-used", (await this.mfa.unusedRecoveryCodes(userId)).length)
        return "recovery"
      }
    }
    throw await this.refused(userId)
  }

  /** Counts a wrong proof against the person; the lock, when it comes, is on the record and in their inbox. */
  async refused(userId: string): Promise<ValidationProblem> {
    if (await this.lockout.fail(userId)) await this.tell(userId, "factor-locked", 0)
    return new ValidationProblem([{ path: "code", message: "is not a valid code", code: "invalid_code" }])
  }

  /** After the fact, best effort: the change stands whether or not the mail goes. */
  private async tell(userId: string, event: AccountSecurityEvent, remaining: number): Promise<void> {
    try {
      const account = await this.users.findById(userId)
      if (account === null) return
      await this.mail.enqueue(
        { kind: "account-security", to: account.email, orgId: null, fromName: "Patchgrid", params: { event, remaining } },
        `${userId}.${event}.${String(this.clock.now().getTime())}`,
      )
    } catch (error) {
      this.logger.error({ msg: "account security mail not queued", userId, event, error: String(error) })
    }
  }
}
