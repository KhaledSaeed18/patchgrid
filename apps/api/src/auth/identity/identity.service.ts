import { Injectable, Logger } from "@nestjs/common"
import type { LoginResponse } from "@patchgrid/contracts"
import { randomBytes } from "node:crypto"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { emailHash8 } from "../../common/privacy"
import { NotAuthenticatedProblem, NotPermittedProblem } from "../../common/problems/problem.exception"
import { PublicUrls } from "../../common/urls"
import { MailService } from "../../mail/mail.service"
import {
  EmailVerificationRepository,
  type OneTimeTokenRecord,
  PasswordResetTokenRepository,
} from "../../platform/repositories/one-time-token.repository"
import { type AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { CookieName, CookieSpec } from "../cookies"
import { PasswordService } from "../passwords/password.service"
import { type ClientInfo, hash, SessionService } from "../sessions/session.service"

/** TENANCY.md §4. */
export const VERIFICATION_TTL_HOURS = 24
/** ADR-0032: long enough to open a mailbox, short enough that a forgotten link is dead. */
export const RESET_TTL_MINUTES = 30

/**
 * The anonymous identity flows (ADR-0017, ADR-0031).
 *
 * Every one of them answers the same way whether or not the address has an
 * account; what differs goes to the inbox, and the inbox is reached through the
 * queue so that even the time taken does not differ. Signup therefore starts no
 * session: the emailed link does, by handing a verified account to
 * `SessionService.startIdentity`.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name)

  constructor(
    private readonly users: UserRepository,
    private readonly verifications: EmailVerificationRepository,
    private readonly resets: PasswordResetTokenRepository,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly urls: PublicUrls,
    private readonly sessions: SessionService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** `202` always. */
  async signup(email: string, password: string, name: string): Promise<void> {
    // The same work on both paths: the hash is computed whether or not it is kept.
    const passwordHash = await this.passwords.hash(password)
    const existing = await this.users.findByEmail(email)

    if (existing === null) {
      const account = await this.users.create({ email, name, passwordHash })
      await this.sendVerification(account)
      return
    }

    if (existing.emailVerifiedAt === null && existing.anonymisedAt === null) {
      // Nobody has proved they own this address yet, so the first password
      // stands and only the link is re-sent. The owner can reset after verifying.
      await this.sendVerification(existing)
      return
    }

    await this.mail.enqueue(
      {
        kind: "account-exists",
        to: existing.email,
        orgId: null,
        fromName: "Patchgrid",
        params: {
          name: existing.name,
          loginUrl: this.urls.app("/login"),
          resetUrl: this.urls.app("/reset-password"),
        },
      },
      existing.id,
    )
  }

  /** The link completes signup and starts the session (TENANCY.md §4). */
  async verifyEmail(
    token: string,
    client: ClientInfo,
  ): Promise<{ response: LoginResponse; cookies: CookieSpec[] }> {
    const now = this.clock.now()
    const record = await this.verifications.findByHash(hash(token))
    if (!isLive(record, now) || !(await this.verifications.consume(record.id, now))) {
      throw new NotAuthenticatedProblem("This verification link is invalid or has expired")
    }
    await this.users.markVerified(record.userId, now)
    const account = await this.users.findById(record.userId)
    if (account === null || account.anonymisedAt !== null) {
      throw new NotAuthenticatedProblem("This verification link is invalid or has expired")
    }
    this.logger.log({ msg: "email verified", userId: account.id })
    return this.sessions.startIdentity(account, client)
  }

  /** `202` always; mail only for an account that exists and is unverified. */
  async resendVerification(email: string): Promise<void> {
    const account = await this.users.findByEmail(email)
    if (account === null || account.emailVerifiedAt !== null || account.anonymisedAt !== null) return
    await this.sendVerification(account)
  }

  /** `202` always; mail only for a verified, live account. */
  async requestPasswordReset(email: string): Promise<void> {
    const account = await this.users.findByEmail(email)
    if (account === null || account.emailVerifiedAt === null || account.anonymisedAt !== null) return

    const now = this.clock.now()
    const secret = newSecret()
    const record = await this.resets.issue(
      account.id,
      hash(secret),
      new Date(now.getTime() + RESET_TTL_MINUTES * 60_000),
      now,
    )
    await this.mail.enqueue(
      {
        kind: "reset-password",
        to: account.email,
        orgId: null,
        fromName: "Patchgrid",
        params: {
          name: account.name,
          resetUrl: this.urls.app(`/reset-password?token=${secret}`),
          expiresInMinutes: RESET_TTL_MINUTES,
        },
      },
      record.id,
    )
  }

  /** Sets the password and ends every session the account had (ADR-0031). */
  async confirmPasswordReset(token: string, password: string): Promise<void> {
    const now = this.clock.now()
    const record = await this.resets.findByHash(hash(token))
    if (!isLive(record, now) || !(await this.resets.consume(record.id, now))) {
      throw new NotAuthenticatedProblem("This reset link is invalid or has expired")
    }
    await this.users.setPassword(record.userId, await this.passwords.hash(password))
    // Following a link delivered to the inbox proves control of it.
    await this.users.markVerified(record.userId, now)
    await this.sessions.revokeEverywhere(record.userId)
    this.logger.log({ msg: "password reset", userId: record.userId })
  }

  /** Authenticated; the current password is re-checked, and every session ends. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<CookieName[]> {
    const account = await this.users.findById(userId)
    const ok = await this.passwords.verify(account?.passwordHash ?? null, currentPassword)
    if (account === null || !ok) throw new NotPermittedProblem("The current password is incorrect")
    await this.users.setPassword(account.id, await this.passwords.hash(newPassword))
    this.logger.log({ msg: "password changed", userId: account.id })
    return this.sessions.revokeEverywhere(account.id)
  }

  private async sendVerification(account: AccountRecord): Promise<void> {
    const now = this.clock.now()
    const secret = newSecret()
    const record = await this.verifications.issue(
      account.id,
      hash(secret),
      new Date(now.getTime() + VERIFICATION_TTL_HOURS * 3_600_000),
      now,
    )
    await this.mail.enqueue(
      {
        kind: "verify-email",
        to: account.email,
        orgId: null,
        fromName: "Patchgrid",
        params: {
          name: account.name,
          verifyUrl: this.urls.app(`/verify-email?token=${secret}`),
          expiresInHours: VERIFICATION_TTL_HOURS,
        },
      },
      record.id,
    )
    this.logger.log({ msg: "verification issued", to: emailHash8(account.email) })
  }
}

/** 256 random bits, base64url — 43 characters, the shape the contracts accept. */
const newSecret = (): string => randomBytes(32).toString("base64url")

function isLive(record: OneTimeTokenRecord | null, now: Date): record is OneTimeTokenRecord {
  return record !== null && record.usedAt === null && record.expiresAt.getTime() > now.getTime()
}
