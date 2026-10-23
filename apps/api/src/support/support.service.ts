import { Injectable } from "@nestjs/common"
import { type SupportSession, type SupportState } from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { StepUpService } from "../auth/mfa/step-up.service"
import { RevocationEpochService } from "../auth/revocation/revocation-epoch.service"
import { supportEpochKey } from "../auth/support/support-token.service"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem } from "../common/problems/problem.exception"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { statusOf, toSupportSession } from "./domain"
import { SupportSessionRepository } from "./repositories/support-session.repository"
import { SupportMail } from "./support-mail"

const HOUR_MS = 60 * 60_000

/**
 * The workspace's side of support access (ADR-0020, ADR-0041): admins see the
 * requests and sessions; only an owner grants, declines or revokes. A grant
 * is at most 72 hours and never for a workspace pending deletion; a
 * revocation ends the operator's reads on their next request.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly sessions: SupportSessionRepository,
    private readonly mail: SupportMail,
    private readonly epochs: RevocationEpochService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly stepUp: StepUpService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(): Promise<SupportSession[]> {
    this.permissions.assert(this.actors.requireTenantActor(), "support:read_sessions")
    const now = this.clock.now()
    return (await this.sessions.list(this.tenant.requireOrgId())).map((row) => toSupportSession(row, now))
  }

  async grant(id: string, hours: number): Promise<SupportSession> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "support:grant_access")
    // Letting an outsider read the workspace is a step-up action (ADR-0029).
    this.stepUp.assert(actor)
    const orgId = this.tenant.requireOrgId()
    if (this.tenant.organization()?.status !== "ACTIVE")
      throw new ConflictProblem("Support access is not granted to a workspace pending deletion")
    const now = this.clock.now()
    const expiresAt = new Date(now.getTime() + hours * HOUR_MS)
    const row = await this.prisma.transaction(async () => {
      const found = await this.sessions.find(orgId, id)
      if (found === null) throw new NotFoundProblem()
      if (!(await this.sessions.grant(orgId, id, actor.membershipId, now, expiresAt)))
        throw new ConflictProblem("This request was already decided")
      await this.audit.record(orgId, [
        {
          action: "SUPPORT_ACCESS_GRANTED",
          entityType: "SupportSession",
          entityId: id,
          diff: { hours, expiresAt: expiresAt.toISOString() },
        },
      ])
      return found
    })
    await this.mail.tell(
      orgId,
      "granted",
      { id, operatorName: row.platformAdmin.user.name },
      `It is read-only and runs until ${expiresAt.toUTCString()}.`,
    )
    return this.one(orgId, id)
  }

  async decline(id: string): Promise<SupportSession> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "support:grant_access")
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      if ((await this.sessions.find(orgId, id)) === null) throw new NotFoundProblem()
      if (!(await this.sessions.decline(orgId, id, actor.membershipId, this.clock.now())))
        throw new ConflictProblem("This request was already decided")
      await this.audit.record(orgId, [{ action: "SUPPORT_ACCESS_DECLINED", entityType: "SupportSession", entityId: id }])
    })
    return this.one(orgId, id)
  }

  /** Any owner, any time: the operator's next request is refused. */
  async revoke(id: string): Promise<SupportSession> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "support:revoke_access")
    const orgId = this.tenant.requireOrgId()
    const row = await this.prisma.transaction(async () => {
      const found = await this.sessions.find(orgId, id)
      if (found === null) throw new NotFoundProblem()
      if (
        statusOf(found, this.clock.now()) !== "ACTIVE" ||
        !(await this.sessions.end(orgId, id, "REVOKED", this.clock.now(), actor.membershipId))
      ) {
        throw new ConflictProblem("This session is not running")
      }
      await this.audit.record(orgId, [{ action: "SUPPORT_ACCESS_REVOKED", entityType: "SupportSession", entityId: id }])
      return found
    })
    await this.epochs.bump(supportEpochKey(id))
    await this.mail.tell(orgId, "ended", { id, operatorName: row.platformAdmin.user.name }, "An owner revoked it.")
    return this.one(orgId, id)
  }

  /**
   * What `/me` says about support (ADR-0041): to the operator, that they are
   * support; to the workspace's admins and owners, that someone is reading.
   */
  async stateFor(actor: TenantActor): Promise<SupportState | null> {
    const orgId = this.tenant.requireOrgId()
    if (actor.kind === "support") {
      const row = await this.sessions.find(orgId, actor.sessionId)
      if (row?.expiresAt == null) return null
      return { kind: "operator", sessionId: row.id, operatorName: row.platformAdmin.user.name, expiresAt: row.expiresAt.toISOString() }
    }
    if (!this.permissions.can(actor, "support:read_sessions")) return null
    const running = await this.sessions.running(orgId, this.clock.now())
    if (running?.expiresAt == null) return null
    return {
      kind: "watched",
      sessionId: running.id,
      operatorName: running.platformAdmin.user.name,
      expiresAt: running.expiresAt.toISOString(),
    }
  }

  private async one(orgId: string, id: string): Promise<SupportSession> {
    const row = await this.sessions.find(orgId, id)
    if (row === null) throw new NotFoundProblem()
    return toSupportSession(row, this.clock.now())
  }
}
