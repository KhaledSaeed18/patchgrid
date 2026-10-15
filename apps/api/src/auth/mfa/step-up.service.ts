import { Injectable } from "@nestjs/common"
import { STEP_UP_TTL_SECONDS, type StepUpRequest, type StepUpResponse } from "@patchgrid/contracts"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { NotAuthenticatedProblem, StepUpRequiredProblem, ValidationProblem } from "../../common/problems/problem.exception"
import { MfaRepository } from "../../platform/repositories/mfa.repository"
import { UserRepository } from "../../platform/repositories/user.repository"
import type { TenantActor } from "../actor"
import type { CookieSpec } from "../cookies"
import { PasswordService } from "../passwords/password.service"
import { type ClientInfo, SessionService } from "../sessions/session.service"
import { FactorLockout } from "./factor-lockout"
import { MemberMfaService } from "./member-mfa.service"

/**
 * Step-up re-authentication (ADR-0029): a fresh proof before an action whose
 * damage is irreversible, carried as a claim on the access token and checked
 * in the service — an authorization condition, so it lives where the others
 * do, not in a guard.
 *
 * The proof is the factor when one is enrolled, and only then the password:
 * a password can never stand in for a factor that exists, or the factor
 * guards nothing. A service account has no one to re-prove and cannot reach
 * these actions by scope anyway; an operator's support session is read-only.
 */
@Injectable()
export class StepUpService {
  constructor(
    private readonly users: UserRepository,
    private readonly mfa: MfaRepository,
    private readonly passwords: PasswordService,
    private readonly lockout: FactorLockout,
    private readonly factors: MemberMfaService,
    private readonly sessions: SessionService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** The condition itself: a member, re-proved within the window. Pure, so it can sit beside `permissions.assert`. */
  assert(actor: TenantActor): void {
    if (actor.kind !== "member" || actor.stepUpAt === undefined) throw new StepUpRequiredProblem()
    const now = Math.floor(this.clock.now().getTime() / 1000)
    if (now - actor.stepUpAt > STEP_UP_TTL_SECONDS || actor.stepUpAt > now) throw new StepUpRequiredProblem()
  }

  /** A `pg_id` holder re-proves themselves and gets that workspace's pair back with the claim on it. */
  async prove(userId: string, request: StepUpRequest, client: ClientInfo): Promise<{ response: StepUpResponse; cookies: CookieSpec[] }> {
    const account = await this.users.findById(userId)
    if (account === null || account.anonymisedAt !== null) throw new NotAuthenticatedProblem()
    const enrolled = (await this.mfa.confirmed(userId)) !== null
    if (enrolled) {
      if (request.password !== undefined) throw new ValidationProblem([{ path: "password", message: "a code from your authenticator is required", code: "factor_required" }])
      await this.factors.verify(userId, { ...(request.code === undefined ? {} : { code: request.code }), ...(request.recoveryCode === undefined ? {} : { recoveryCode: request.recoveryCode }) })
    } else {
      if (request.password === undefined) throw new ValidationProblem([{ path: "password", message: "is required when no second factor is set up", code: "password_required" }])
      await this.lockout.assertOpen(userId)
      if (!(await this.passwords.verify(account.passwordHash, request.password))) throw await this.factors.refused(userId)
      await this.lockout.clear(userId)
    }
    const now = this.clock.now()
    const cookies = await this.sessions.open(userId, request.slug, client, { stepUpAt: now })
    return { response: { stepUpExpiresAt: new Date(now.getTime() + STEP_UP_TTL_SECONDS * 1000).toISOString() }, cookies }
  }
}
