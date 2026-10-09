import { Injectable, Logger } from "@nestjs/common"
import {
  type CreateInvitationRequest,
  INVITATION_TTL_DAYS,
  type Invitation,
  type Role,
} from "@patchgrid/contracts"

import { ActorService } from "../../auth/actor"
import { hash } from "../../auth/sessions/session.service"
import { AuditService } from "../../audit/audit.service"
import { PermissionService } from "../../authz/permission.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { emailHash8 } from "../../common/privacy"
import {
  ConflictProblem,
  NotFoundProblem,
  PlanLimitProblem,
  ValidationProblem,
} from "../../common/problems/problem.exception"
import { PublicUrls } from "../../common/urls"
import { MailService } from "../../mail/mail.service"
import { OrganizationRepository } from "../../platform/repositories/organization.repository"
import { PrismaService } from "../../prisma/prisma.service"
import { QuotaService } from "../../quota/quota.service"
import { TeamRepository } from "../../teams/repositories/team.repository"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { type InvitationRecord, InvitationRepository } from "../repositories/invitation.repository"
import { MembershipRepository } from "../repositories/membership.repository"
import { newInvitationToken } from "./invitation-token"

const PRIVILEGED: ReadonlySet<Role> = new Set(["ADMIN", "OWNER"])

/**
 * Inviting people into the current organization (ADR-0033, TENANCY.md §5).
 *
 * The invitation, the revocation of any outstanding one for the same address
 * and the audit row commit together; the mail is enqueued after, because a
 * message about an invitation that rolled back would be a lie. The token
 * exists in exactly two places: the hash in the row, and the mail job.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name)

  constructor(
    private readonly invitations: InvitationRepository,
    private readonly memberships: MembershipRepository,
    private readonly teams: TeamRepository,
    private readonly organizations: OrganizationRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly urls: PublicUrls,
    private readonly quota: QuotaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async listPending(): Promise<Invitation[]> {
    this.permissions.assert(this.actors.requireTenantActor(), "member:invite")
    const rows = await this.invitations.listPending(this.tenant.requireOrgId(), this.clock.now())
    return rows.map(toInvitation)
  }

  async create(request: CreateInvitationRequest): Promise<Invitation> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "member:invite")
    // An admin cannot mint a peer through the invitation side door (ADR-0033).
    if (PRIVILEGED.has(request.role)) this.permissions.assert(actor, "member:promote_admin")

    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const { token, secret } = newInvitationToken(orgId)

    const invitation = await this.prisma.transaction(async () => {
      if (request.teamId !== undefined) {
        const team = await this.teams.findById(orgId, request.teamId)
        if (team === null || !team.isActive) {
          throw new ValidationProblem([{ path: "teamId", message: "is not an active team", code: "invalid_team" }])
        }
      }

      const existing = await this.memberships.findByEmail(orgId, request.email)
      if (existing?.status === "ACTIVE") throw new ConflictProblem("That address is already a member")
      if (existing?.status === "DISABLED") {
        throw new ConflictProblem("That address belongs to a disabled member; enable them instead")
      }

      // A hint, so the admin hears it now rather than the invitee at acceptance,
      // where the seat is actually taken — and where the limit is enforced.
      if (request.role !== "REQUESTER" && !(await this.quota.hasRoom(orgId, "AGENT_SEATS"))) {
        throw new PlanLimitProblem("AGENT_SEATS", "Every agent seat on this plan is in use")
      }

      const superseded = await this.invitations.revokePendingFor(orgId, request.email, now)
      const created = await this.invitations.create(orgId, {
        email: request.email,
        role: request.role,
        teamId: request.teamId ?? null,
        tokenHash: hash(secret),
        expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
        invitedByMembershipId: actor.membershipId,
      })
      await this.audit.record(orgId, [
        {
          action: "MEMBER_INVITED",
          entityType: "Invitation",
          entityId: created.id,
          diff: {
            email: created.email,
            role: created.role,
            teamId: created.teamId,
            ...(superseded.length > 0 ? { supersedes: superseded } : {}),
          },
        },
      ])
      return created
    })

    await this.sendInvite(orgId, invitation, token, actor.membershipId)
    return toInvitation(invitation)
  }

  async revoke(id: string): Promise<void> {
    this.permissions.assert(this.actors.requireTenantActor(), "member:invite")
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      if (!(await this.invitations.revoke(orgId, id, this.clock.now()))) throw new NotFoundProblem()
      await this.audit.record(orgId, [{ action: "INVITATION_REVOKED", entityType: "Invitation", entityId: id }])
    })
  }

  /**
   * After commit. A failure here leaves a valid invitation nobody was told
   * about — logged, and fixed by inviting again, which supersedes it. Failing
   * the request instead would report an invitation that exists as one that
   * does not.
   */
  private async sendInvite(orgId: string, invitation: InvitationRecord, token: string, inviterId: string) {
    try {
      const [org, inviter] = await Promise.all([
        this.organizations.findProfileById(orgId),
        this.memberships.findById(orgId, inviterId),
      ])
      if (org === null) throw new Error(`organization ${orgId} vanished`)
      await this.mail.enqueue(
        {
          kind: "invite",
          to: invitation.email,
          orgId,
          fromName: org.name,
          params: {
            orgName: org.name,
            inviterName: inviter?.displayName ?? org.name,
            role: invitation.role,
            acceptUrl: this.urls.app(`/invite?token=${encodeURIComponent(token)}`),
            expiresInDays: INVITATION_TTL_DAYS,
          },
        },
        invitation.id,
      )
    } catch (error) {
      this.logger.error({
        msg: "invitation mail could not be enqueued",
        invitationId: invitation.id,
        to: emailHash8(invitation.email),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function toInvitation(row: InvitationRecord): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    teamId: row.teamId,
    invitedByMembershipId: row.invitedByMembershipId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}
