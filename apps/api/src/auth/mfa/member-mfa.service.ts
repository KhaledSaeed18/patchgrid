import { Injectable, Logger } from "@nestjs/common"
import type { FactorAdded, HolderProof, LoginResponse, MemberFactorProof, MfaEnrolment, MfaStatus, RecoveryCodes } from "@patchgrid/contracts"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { ConflictProblem, NotAuthenticatedProblem, ServiceUnavailableProblem, ValidationProblem } from "../../common/problems/problem.exception"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import { MfaRepository } from "../../platform/repositories/mfa.repository"
import { RedisService } from "../../redis/redis.service"
import { UserRepository } from "../../platform/repositories/user.repository"
import type { CookieName, CookieSpec } from "../cookies"
import { CookieService } from "../cookies"
import { PasskeyCeremonies } from "../passkeys/passkey-ceremonies"
import { PasswordService } from "../passwords/password.service"
import { type ClientInfo, SessionService } from "../sessions/session.service"
import { AccountSecurityNotifier } from "./account-security-notifier"
import { FactorLockout } from "./factor-lockout"
import { MFA_CHALLENGE_TTL_SECONDS, MfaChallengeService } from "./mfa-challenge.service"
import { newRecoveryCodes, normaliseRecoveryCode } from "./recovery-codes"
import { SecretBox } from "./secret-box"
import { acceptedStep, newTotpSecret, otpauthUri } from "./totp"

/** An unconfirmed factor is good for this long (ADR-0029). */
const ENROLMENT_TTL_MS = 60 * 60_000

/** How the holder was proved — a recovery code is a proof that also ends every other session. */
export type ProvedBy = "totp" | "recovery" | "passkey" | "password"

/** A factor, as any of the routes that take one hands it over: exactly one field is set. */
type FactorProofInput = Pick<MemberFactorProof, "code" | "recoveryCode" | "passkey">

/**
 * A member's second factors (ADR-0029, ADR-0045, ADR-0053): the second step
 * of login, the self-service around the authenticator app, and the one rule
 * every proof follows. Everything here is about the person, not a workspace:
 * the identity holder reaches it from the picker, and a workspace only ever
 * asks "is there a factor?" through `SessionService`.
 *
 * A person may hold an authenticator app, passkeys, or both. Any factor they
 * hold is a proof; the password is a proof only when they hold none. The
 * verification rules for codes are the platform's (ADR-0040): one lockout per
 * person, a code spent atomically so it never works twice, and a recovery
 * code that signs out everywhere and tells the person by mail. A passkey is
 * not guessable, so a refused one is not counted against the lockout.
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
    private readonly ceremonies: PasskeyCeremonies,
    private readonly sessions: SessionService,
    private readonly cookies: CookieService,
    private readonly notifier: AccountSecurityNotifier,
    private readonly redis: RedisService,
    @InjectConfig() config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {
    this.box = new SecretBox(config.MFA_ENCRYPTION_KEY)
  }

  /** The second step of login: the challenge cookie plus a factor, then the session the password alone could not start. */
  async completeLogin(
    challengeToken: string | undefined,
    request: FactorProofInput,
    client: ClientInfo,
  ): Promise<{ response: LoginResponse; cookies: CookieSpec[]; clear: CookieName[] }> {
    const challenge = challengeToken === undefined ? null : await this.challenges.verify(challengeToken)
    if (challenge === null) throw new NotAuthenticatedProblem("Sign in again")
    const account = await this.users.findById(challenge.userId)
    if (account === null || account.anonymisedAt !== null || account.emailVerifiedAt === null) throw new NotAuthenticatedProblem("Sign in again")
    await this.verify(challenge.userId, request)
    // One session per challenge: a completed challenge cookie replayed inside its five minutes earns nothing more (M9 review).
    if (!(await this.spendChallenge(challenge.jti))) throw new NotAuthenticatedProblem("Sign in again")
    const started = await this.sessions.startIdentity(account, client, challenge.slug)
    return { ...started, clear: [{ name: this.cookies.mfaChallenge("", 0).name, path: this.cookies.mfaChallenge("", 0).path }] }
  }

  async status(userId: string): Promise<MfaStatus> {
    const methods = await this.mfa.methods(userId)
    const totp = methods.includes("totp") ? await this.mfa.confirmed(userId) : null
    return {
      enrolled: totp !== null,
      confirmedAt: totp?.confirmedAt?.toISOString() ?? null,
      methods,
      recoveryCodesRemaining: methods.length === 0 ? 0 : (await this.mfa.unusedRecoveryCodes(userId)).length,
    }
  }

  /**
   * A new, unconfirmed authenticator app, against a fresh proof (M9 review,
   * ADR-0053): a long-lived `pg_id` in the wrong hands must not be able to
   * enrol an authenticator of its own, and nor may a password beside a
   * passkey. Refused while one is confirmed: turn that off first.
   */
  async enrol(userId: string, proof: HolderProof): Promise<MfaEnrolment> {
    if ((await this.mfa.confirmed(userId)) !== null) throw new ConflictProblem("An authenticator app is already set up; turn it off before setting up another")
    const account = await this.users.findById(userId)
    if (account === null) throw new NotAuthenticatedProblem()
    await this.proveHolder(userId, proof)
    const secret = newTotpSecret()
    await this.mfa.startEnrolment(userId, this.box.seal(secret), "Authenticator app")
    return { secret, otpauthUri: otpauthUri(secret, account.email) }
  }

  /** Proves the new factor; when it is the person's first of any kind, returns their recovery codes, once. */
  async confirm(userId: string, code: string): Promise<FactorAdded> {
    await this.lockout.assertOpen(userId)
    const now = this.clock.now()
    const factor = await this.mfa.pending(userId, new Date(now.getTime() - ENROLMENT_TTL_MS))
    const secret = factor === null ? null : this.box.open(factor.secretEncrypted)
    const step = factor === null || secret === null ? null : acceptedStep(secret, code, now, null)
    if (factor === null || step === null) throw await this.refused(userId)
    const fresh = (await this.mfa.methods(userId)).length === 0 ? newRecoveryCodes() : null
    const hashes = fresh === null ? null : await this.hashAll(fresh)
    const result = await this.mfa.confirm(userId, factor.id, step, now, hashes, "if-first")
    if (!result.confirmed) throw await this.refused(userId)
    await this.lockout.clear(userId)
    const recoveryCodes = result.codesIssued ? fresh : null
    this.logger.log({ msg: "second factor enabled", userId })
    await this.notifier.tell(userId, "factor-enabled", recoveryCodes?.length ?? 0)
    return { recoveryCodes }
  }

  /** Ten fresh codes replace whatever was left; a live factor, not a recovery code, is the proof. */
  async regenerateRecoveryCodes(userId: string, proof: Pick<MemberFactorProof, "code" | "passkey">): Promise<RecoveryCodes> {
    await this.verify(userId, proof)
    const recoveryCodes = newRecoveryCodes()
    await this.mfa.replaceRecoveryCodes(userId, await this.hashAll(recoveryCodes))
    await this.notifier.tell(userId, "recovery-codes-regenerated", recoveryCodes.length)
    return { recoveryCodes }
  }

  /** The authenticator app off, proved by a factor — never by the password (ADR-0029). */
  async disable(userId: string, proof: FactorProofInput): Promise<void> {
    if ((await this.mfa.confirmed(userId)) === null) throw new ConflictProblem("No authenticator app is set up")
    await this.verify(userId, proof)
    await this.mfa.removeTotp(userId)
    this.logger.log({ msg: "second factor disabled", userId })
    await this.notifier.tell(userId, "factor-disabled", 0)
  }

  /**
   * The step-up rule (ADR-0045, ADR-0053): any factor the person holds is a
   * proof, and the password is one only when they hold none — a password can
   * never stand in for a factor that exists, or the factor guards nothing.
   * Step-up, adding a passkey and setting up the authenticator app all take it.
   */
  async proveHolder(userId: string, proof: HolderProof): Promise<ProvedBy> {
    const held = await this.mfa.methods(userId)
    if (held.length > 0) {
      if (proof.password !== undefined) throw new ValidationProblem([{ path: "password", message: "a second factor is required", code: "factor_required" }])
      return this.verify(userId, proof)
    }
    if (proof.password === undefined) throw new ValidationProblem([{ path: "password", message: "is required when no second factor is set up", code: "password_required" }])
    const account = await this.users.findById(userId)
    if (account === null || account.anonymisedAt !== null) throw new NotAuthenticatedProblem()
    await this.lockout.assertOpen(userId)
    if (!(await this.passwords.verify(account.passwordHash, proof.password))) throw await this.refused(userId, "password")
    await this.lockout.clear(userId)
    return "password"
  }

  /**
   * A factor, proved: a passkey assertion against a challenge issued to this
   * person; a current code spent atomically; or one unused recovery code —
   * which ends every other session this person holds and tells them, because
   * a recovery code in use means their devices are lost or taken. Five
   * refused codes lock the codes for an hour (ADR-0029).
   */
  async verify(userId: string, proof: FactorProofInput): Promise<ProvedBy> {
    if (proof.passkey !== undefined) {
      const asserted = await this.ceremonies.verifyAssertion("proof", proof.passkey.challengeId, proof.passkey.credential, userId)
      if (asserted === null) throw new ValidationProblem([{ path: "passkey", message: "could not be verified", code: "invalid_passkey" }])
      return "passkey"
    }
    await this.lockout.assertOpen(userId)
    const now = this.clock.now()
    if (proof.code !== undefined) {
      const factor = await this.mfa.confirmed(userId)
      const secret = factor === null ? null : this.box.open(factor.secretEncrypted)
      const step = factor === null || secret === null ? null : acceptedStep(secret, proof.code, now, factor.lastUsedStep)
      if (factor === null || step === null || !(await this.mfa.spendStep(factor.id, step, now))) throw await this.refused(userId)
      await this.lockout.clear(userId)
      return "totp"
    }
    const presented = normaliseRecoveryCode(proof.recoveryCode ?? "")
    for (const stored of await this.mfa.unusedRecoveryCodes(userId)) {
      if ((await this.passwords.verify(stored.codeHash, presented)) && (await this.mfa.spendRecoveryCode(stored.id, now))) {
        await this.lockout.clear(userId)
        this.logger.warn({ msg: "recovery code used", userId })
        // Every session before this second ends; the one this proof earns, minted next, survives.
        await this.sessions.revokeEverywhere(userId, { before: true })
        await this.notifier.tell(userId, "recovery-code-used", (await this.mfa.unusedRecoveryCodes(userId)).length)
        return "recovery"
      }
    }
    throw await this.refused(userId)
  }

  /** `true` the first time a challenge completes; with Redis down the login waits, as the lockout does. */
  private async spendChallenge(jti: string): Promise<boolean> {
    try {
      return (await this.redis.client.set(`mfa:challenge:${jti}`, "1", "EX", MFA_CHALLENGE_TTL_SECONDS, "NX")) === "OK"
    } catch (error) {
      this.logger.error({ msg: "challenge registry unavailable", error: String(error) })
      throw new ServiceUnavailableProblem("Sign-in cannot be completed right now; retry shortly")
    }
  }

  /** Counts a wrong proof against the person; the lock, when it comes, is on the record and in their inbox. */
  private async refused(userId: string, path: "code" | "password" = "code"): Promise<ValidationProblem> {
    if (await this.lockout.fail(userId)) await this.notifier.tell(userId, "factor-locked", 0)
    return path === "code"
      ? new ValidationProblem([{ path: "code", message: "is not a valid code", code: "invalid_code" }])
      : new ValidationProblem([{ path: "password", message: "does not match", code: "invalid_password" }])
  }

  private hashAll(codes: readonly string[]): Promise<string[]> {
    return Promise.all(codes.map((c) => this.passwords.hash(normaliseRecoveryCode(c))))
  }
}
