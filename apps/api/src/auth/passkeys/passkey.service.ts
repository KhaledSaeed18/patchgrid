import { Injectable, Logger } from "@nestjs/common"
import type {
  HolderProof,
  MemberFactorProof,
  Passkey,
  PasskeyCreationCeremony,
  PasskeyLoginRequest,
  PasskeyRegistered,
  PasskeyRegisterRequest,
  PasskeyRequestCeremony,
  SignedInResponse,
} from "@patchgrid/contracts"

import { ConflictProblem, NotAuthenticatedProblem, NotFoundProblem, ValidationProblem } from "../../common/problems/problem.exception"
import { MfaRepository } from "../../platform/repositories/mfa.repository"
import { PasskeyRepository, type PasskeyRecord } from "../../platform/repositories/passkey.repository"
import { UserRepository } from "../../platform/repositories/user.repository"
import type { CookieSpec } from "../cookies"
import { AccountSecurityNotifier } from "../mfa/account-security-notifier"
import { MemberMfaService } from "../mfa/member-mfa.service"
import { MfaChallengeService } from "../mfa/mfa-challenge.service"
import { newRecoveryCodes, normaliseRecoveryCode } from "../mfa/recovery-codes"
import { PasswordService } from "../passwords/password.service"
import { type ClientInfo, SessionService } from "../sessions/session.service"
import { PasskeyCeremonies } from "./passkey-ceremonies"

/**
 * A member's passkeys (ADR-0053): registered against a fresh proof, signed in
 * with alone, used as the second step and for step-up, listed, renamed and
 * removed. Everything is the person's, reached by `pg_id` from the account
 * pages — except the passwordless login, which is public and names no one
 * until the credential does.
 *
 * Operators never use one: the back-office takes no assertion, and the
 * ceremonies refuse the admin host's origin even if a request is built by
 * hand (ADR-0040, ADR-0053).
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name)

  constructor(
    private readonly users: UserRepository,
    private readonly passkeys: PasskeyRepository,
    private readonly mfa: MfaRepository,
    private readonly ceremonies: PasskeyCeremonies,
    private readonly factors: MemberMfaService,
    private readonly mfaChallenges: MfaChallengeService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly notifier: AccountSecurityNotifier,
  ) {}

  async list(userId: string): Promise<Passkey[]> {
    return (await this.passkeys.listForUser(userId)).map(toWire)
  }

  /**
   * Registration options, against a fresh proof by the step-up rule: a passkey
   * signs in alone, so a stolen `pg_id` that could add one would own the
   * account (ADR-0053). The attestation that follows must answer within five
   * minutes.
   */
  async registrationOptions(userId: string, proof: HolderProof): Promise<PasskeyCreationCeremony> {
    const account = await this.users.findById(userId)
    if (account === null || account.anonymisedAt !== null) throw new NotAuthenticatedProblem()
    await this.factors.proveHolder(userId, proof)
    return this.ceremonies.creationOptions(account, await this.passkeys.listForUser(userId))
  }

  /**
   * The new passkey, verified against the challenge issued to this person.
   * When it is their first factor of any kind, the recovery codes come with
   * it and are shown once; otherwise the codes they have stand. The challenge
   * is single-use, so a retried request is refused rather than doubled.
   */
  async register(userId: string, request: PasskeyRegisterRequest): Promise<PasskeyRegistered> {
    const verified = await this.ceremonies.verifyRegistration(userId, request.challengeId, request.credential, request.label)
    if (verified === null) throw new ValidationProblem([{ path: "credential", message: "could not be verified", code: "invalid_passkey" }])
    const fresh = (await this.mfa.methods(userId)).length === 0 ? newRecoveryCodes() : null
    const hashes = fresh === null ? null : await Promise.all(fresh.map((c) => this.passwords.hash(normaliseRecoveryCode(c))))
    const added = await this.passkeys.add(userId, verified, hashes)
    if (added === null) throw new ConflictProblem("This passkey is already registered")
    const recoveryCodes = added.codesIssued ? fresh : null
    this.logger.log({ msg: "passkey added", userId, passkeyId: added.passkey.id })
    await this.notifier.tell(userId, "passkey-added", recoveryCodes?.length ?? 0)
    return { passkey: toWire(added.passkey), recoveryCodes }
  }

  /** A label guards nothing, so renaming takes only the session. */
  async rename(userId: string, id: string, label: string): Promise<Passkey> {
    const renamed = await this.passkeys.rename(userId, id, label)
    if (renamed === null) throw new NotFoundProblem("No such passkey")
    return toWire(renamed)
  }

  /**
   * Removal takes a factor, by the same rule as turning the authenticator app
   * off; a passkey may prove its own removal. Removing the last factor in a
   * workspace that requires one gates the next sign-in, not this session.
   */
  async remove(userId: string, id: string, proof: MemberFactorProof): Promise<void> {
    if (!(await this.passkeys.listForUser(userId)).some((p) => p.id === id)) throw new NotFoundProblem("No such passkey")
    await this.factors.verify(userId, proof)
    if (!(await this.passkeys.remove(userId, id))) throw new NotFoundProblem("No such passkey")
    this.logger.log({ msg: "passkey removed", userId, passkeyId: id })
    await this.notifier.tell(userId, "passkey-removed", 0)
  }

  /** A challenge for a `pg_id` holder to prove themselves with one of their passkeys. */
  async proofOptions(userId: string): Promise<PasskeyRequestCeremony> {
    const held = await this.passkeys.listForUser(userId)
    if (held.length === 0) throw new ConflictProblem("No passkey is set up")
    return this.ceremonies.requestOptions("proof", userId, held)
  }

  /**
   * A challenge for the second step of login, authenticated by the MFA
   * challenge cookie the password step set — the person has no `pg_id` yet.
   */
  async secondStepOptions(challengeToken: string | undefined): Promise<PasskeyRequestCeremony> {
    const challenge = challengeToken === undefined ? null : await this.mfaChallenges.verify(challengeToken)
    if (challenge === null) throw new NotAuthenticatedProblem("Sign in again")
    const held = await this.passkeys.listForUser(challenge.userId)
    if (held.length === 0) throw new ConflictProblem("No passkey is set up")
    return this.ceremonies.requestOptions("proof", challenge.userId, held)
  }

  /** Options for a passwordless sign-in: no credentials listed, so the authenticator offers what it holds. */
  loginOptions(): Promise<PasskeyRequestCeremony> {
    return this.ceremonies.requestOptions("login", null, [])
  }

  /**
   * Signing in with a passkey alone (ADR-0053). A user-verified passkey is
   * both factors, so there is no `mfa-required` stage after it, and it
   * satisfies a workspace's `requireMfa`. An unknown credential, a wrong
   * signature, a refused origin and a spent challenge are one `401`, and none
   * counts against anyone's lockout: an unknown credential names no one, and a
   * bad signature is not someone guessing a code.
   */
  async login(request: PasskeyLoginRequest, client: ClientInfo): Promise<{ response: SignedInResponse; cookies: CookieSpec[] }> {
    const asserted = await this.ceremonies.verifyAssertion("login", request.challengeId, request.credential, null)
    const account = asserted === null ? null : await this.users.findById(asserted.userId)
    if (account === null || account.anonymisedAt !== null || account.emailVerifiedAt === null) throw new NotAuthenticatedProblem("That passkey did not sign you in")
    return this.sessions.startIdentity(account, client, request.slug)
  }
}

function toWire(p: PasskeyRecord): Passkey {
  return { id: p.id, label: p.label, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt?.toISOString() ?? null, synced: p.backedUp }
}
