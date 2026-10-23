import { Injectable } from "@nestjs/common"
import { type SupportEntry, type SupportSession } from "@patchgrid/contracts"

import { ActorService, type PlatformActor } from "../../auth/actor"
import { SupportTokenService } from "../../auth/support/support-token.service"
import { AuditService } from "../../audit/audit.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { ConflictProblem, NotFoundProblem } from "../../common/problems/problem.exception"
import { PublicUrls } from "../../common/urls"
import { PrismaService } from "../../prisma/prisma.service"
import { statusOf, toSupportSession } from "../../support/domain"
import { SupportSessionRepository } from "../../support/repositories/support-session.repository"
import { SupportMail } from "../../support/support-mail"
import { PlatformAuditRepository } from "../repositories/platform-audit.repository"
import { runAsTenant } from "../run-as-tenant"
import { BackofficeRepository } from "./repositories/backoffice.repository"

export type Entered = SupportEntry & { slug: string; token: string; maxAgeSeconds: number }

/**
 * The operator's side of support access (ADR-0020, ADR-0041): ask, see what
 * the owners decided, and — while a grant runs — enter the workspace as a
 * read-only support actor. The rows are the tenant's, so every step runs
 * inside it, crossing logged.
 */
@Injectable()
export class PlatformSupportService {
  constructor(
    private readonly orgs: BackofficeRepository,
    private readonly sessions: SupportSessionRepository,
    private readonly mail: SupportMail,
    private readonly tokens: SupportTokenService,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditRepository,
    private readonly prisma: PrismaService,
    private readonly urls: PublicUrls,
    private readonly actors: ActorService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async request(orgId: string, reason: string): Promise<SupportSession> {
    const actor = this.actors.requirePlatform()
    const org = await this.orgs.find(orgId)
    if (org === null) throw new NotFoundProblem()
    if (org.status !== "ACTIVE") throw new ConflictProblem("Support access is asked for only in an active workspace")
    const session = await runAsTenant(org.id, crossing(actor, "request support access"), async () => {
      const id = await this.prisma.transaction(async () => {
        const created = await this.sessions.request(org.id, actor.platformAdminId, reason)
        await this.audit.record(org.id, [
          { action: "SUPPORT_ACCESS_REQUESTED", entityType: "SupportSession", entityId: created, diff: { reason } },
        ])
        return created
      })
      const row = await this.sessions.find(org.id, id)
      if (row === null) throw new NotFoundProblem()
      await this.mail.tell(
        org.id,
        "requested",
        { id, operatorName: row.platformAdmin.user.name },
        `Their reason: “${reason}”. Nothing is readable until an owner grants it.`,
      )
      return toSupportSession(row, this.clock.now())
    })
    await this.platformAudit.record({
      platformAdminId: actor.platformAdminId,
      action: "PLATFORM_SUPPORT_REQUESTED",
      targetOrgId: org.id,
      diff: { sessionId: session.id },
    })
    return session
  }

  async list(orgId: string): Promise<SupportSession[]> {
    const actor = this.actors.requirePlatform()
    if ((await this.orgs.find(orgId)) === null) throw new NotFoundProblem()
    const now = this.clock.now()
    return runAsTenant(orgId, crossing(actor, "list support sessions"), async () =>
      (await this.sessions.list(orgId)).map((row) => toSupportSession(row, now)),
    )
  }

  /** A support token for a running grant of this operator's, good until the grant or the platform session ends. */
  async enter(orgId: string, sessionId: string): Promise<Entered> {
    const actor = this.actors.requirePlatform()
    const org = await this.orgs.find(orgId)
    if (org === null) throw new NotFoundProblem()
    const now = this.clock.now()
    const row = await runAsTenant(org.id, crossing(actor, "enter support session"), () => this.sessions.find(org.id, sessionId))
    if (row?.platformAdminId !== actor.platformAdminId) throw new NotFoundProblem()
    if (statusOf(row, now) !== "ACTIVE" || row.expiresAt === null) throw new ConflictProblem("This session is not running")
    const expiresAt = Math.min(Math.floor(row.expiresAt.getTime() / 1000), actor.sessionExpiresAt)
    const token = await this.tokens.sign({
      userId: actor.userId,
      platformAdminId: actor.platformAdminId,
      sessionId,
      orgId: org.id,
      expiresAt,
    })
    await this.platformAudit.record({
      platformAdminId: actor.platformAdminId,
      action: "PLATFORM_SUPPORT_ENTERED",
      targetOrgId: org.id,
      diff: { sessionId },
    })
    return {
      slug: org.slug,
      token,
      maxAgeSeconds: Math.max(expiresAt - Math.floor(now.getTime() / 1000), 0),
      workspaceUrl: this.urls.workspace(org.slug, "/"),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    }
  }

  async slugOf(orgId: string): Promise<string> {
    this.actors.requirePlatform()
    const org = await this.orgs.find(orgId)
    if (org === null) throw new NotFoundProblem()
    return org.slug
  }
}

function crossing(actor: PlatformActor, reason: string) {
  return { actor: `platform-admin:${actor.platformAdminId}`, reason: `support: ${reason}` }
}
