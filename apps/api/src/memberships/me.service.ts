import { Injectable } from "@nestjs/common"
import { type Me, ticketTypeSchema } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { NotAuthenticatedProblem } from "../common/problems/problem.exception"
import { OrganizationRepository } from "../platform/repositories/organization.repository"
import { UserRepository } from "../platform/repositories/user.repository"
import { SupportService } from "../support/support.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { MembershipRepository } from "./repositories/membership.repository"

/**
 * The caller in the current workspace (RBAC.md §7): the UI renders navigation
 * from this answer and never re-derives it. Read fresh on every call, after
 * the auth guard has already confirmed the membership is active.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly users: UserRepository,
    private readonly organizations: OrganizationRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly support: SupportService,
  ) {}

  async me(): Promise<Me> {
    const actor = this.actors.requireTenantActor()
    const resolved = this.tenant.organization()
    if (resolved === undefined) throw new NotAuthenticatedProblem()

    const org = async () => {
      const profile = await this.organizations.findProfileById(resolved.id)
      if (profile === null) throw new NotAuthenticatedProblem()
      return { id: resolved.id, name: profile.name, slug: resolved.slug, plan: resolved.plan, agentVisibility: resolved.agentVisibility, requireMfa: resolved.requireMfa }
    }
    const support = await this.support.stateFor(actor)

    // An operator in a support session is no member: they are named as support, and offered reads only (ADR-0041).
    if (actor.kind === "support") {
      return {
        user: null,
        membership: { id: actor.sessionId, role: "ADMIN", displayName: `Patchgrid support · ${support?.operatorName ?? "operator"}`, avatarUrl: null },
        org: await org(),
        teams: [],
        permissions: this.permissions.permissionsFor(actor),
        creatableTypes: [],
        support,
      }
    }

    const [member, profile, account] = await Promise.all([
      this.memberships.findMember(resolved.id, actor.membershipId, true),
      this.organizations.findProfileById(resolved.id),
      actor.kind === "member" ? this.users.findById(actor.userId) : Promise.resolve(null),
    ])
    // The guard read this membership moments ago; its absence now is a session to end, not a 404.
    if (member === null || profile === null) throw new NotAuthenticatedProblem()

    return {
      user: account === null ? null : { id: account.id, email: account.email, name: account.name },
      membership: { id: member.id, role: member.role, displayName: member.displayName, avatarUrl: member.avatarUrl },
      org: {
        id: resolved.id,
        name: profile.name,
        slug: resolved.slug,
        plan: resolved.plan,
        agentVisibility: resolved.agentVisibility,
        requireMfa: resolved.requireMfa,
      },
      teams: member.teams,
      permissions: this.permissions.permissionsFor(actor),
      creatableTypes: ticketTypeSchema.options.filter((type) => this.permissions.can(actor, "ticket:create", { ticketType: type })),
      support,
    }
  }
}
