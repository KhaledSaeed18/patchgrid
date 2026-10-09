import { Injectable } from "@nestjs/common"
import type {
  CreateTeamRequest,
  Team,
  TeamDetail,
  UpdateTeamRequest,
} from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { RevocationEpochService } from "../auth/revocation/revocation-epoch.service"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem } from "../common/problems/problem.exception"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { type TeamRecord, TeamRepository, type TeamRow } from "./repositories/team.repository"

/**
 * Teams (ADR-0025, RBAC.md §3). Admins create, rename, deactivate and choose
 * leads; a lead manages who is in their own team, and nothing else. Every
 * change to who is in a team, or who leads it, bumps that member's epoch in
 * the same transaction (TENANCY.md §6), so a token carrying stale team facts
 * dies at once.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly teams: TeamRepository,
    private readonly memberships: MembershipRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly epochs: RevocationEpochService,
  ) {}

  async list(): Promise<Team[]> {
    this.permissions.assert(this.actors.requireTenantActor(), "team:read")
    return (await this.teams.list(this.tenant.requireOrgId())).map(toTeam)
  }

  async get(id: string): Promise<TeamDetail> {
    this.permissions.assertVisible(this.actors.requireTenantActor(), "team:read")
    const orgId = this.tenant.requireOrgId()
    const [row, members] = await Promise.all([this.teams.findRow(orgId, id), this.teams.members(orgId, id)])
    if (row === null) throw new NotFoundProblem()
    return { ...toTeam(row), members: members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })) }
  }

  async create(request: CreateTeamRequest): Promise<TeamDetail> {
    this.permissions.assert(this.actors.requireTenantActor(), "team:write")
    const orgId = this.tenant.requireOrgId()
    const id = await this.prisma.transaction(async () => {
      const created = await this.teams.create(orgId, { name: request.name, description: request.description ?? null })
      if (created === "name-taken") throw new ConflictProblem("A team with that name already exists")
      await this.audit.record(orgId, [
        { action: "TEAM_CREATED", entityType: "Team", entityId: created, diff: { name: request.name } },
      ])
      return created
    })
    return this.get(id)
  }

  /** Rename, describe, deactivate or reactivate. Deactivated teams keep their members; tickets will need them. */
  async update(id: string, request: UpdateTeamRequest): Promise<TeamDetail> {
    this.permissions.assert(this.actors.requireTenantActor(), "team:write")
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const before = await this.teams.findRow(orgId, id)
      if (before === null) throw new NotFoundProblem()
      if ((await this.teams.update(orgId, id, request)) === "name-taken") {
        throw new ConflictProblem("A team with that name already exists")
      }
      const diff = Object.fromEntries(
        (Object.keys(request) as (keyof UpdateTeamRequest)[])
          .filter((field) => request[field] !== before[field])
          .map((field) => [field, { from: before[field], to: request[field] }]),
      )
      if (Object.keys(diff).length > 0) {
        await this.audit.record(orgId, [{ action: "TEAM_UPDATED", entityType: "Team", entityId: id, diff }])
      }
    })
    return this.get(id)
  }

  /** Adds an existing, active agent or above. Idempotent. */
  async addMember(teamId: string, membershipId: string): Promise<void> {
    await this.changeMembership(teamId, async (orgId, team) => {
      const target = await this.memberships.findById(orgId, membershipId)
      if (target === null || target.status === "REMOVED") throw new NotFoundProblem("No such member")
      if (target.status !== "ACTIVE") throw new ConflictProblem("Only an active member can join a team")
      if (target.role === "REQUESTER") throw new ConflictProblem("Requesters do not join teams; change their role first")
      if ((await this.teams.findMembership(orgId, team.id, membershipId)) !== null) return []

      await this.teams.addMember(orgId, team.id, membershipId)
      await this.audit.record(orgId, [
        { action: "TEAM_MEMBER_ADDED", entityType: "Team", entityId: team.id, diff: { membershipId } },
      ])
      return [membershipId]
    })
  }

  /** Removing the lead also clears the lead. */
  async removeMember(teamId: string, membershipId: string): Promise<void> {
    await this.changeMembership(teamId, async (orgId, team) => {
      const current = await this.teams.findMembership(orgId, team.id, membershipId)
      if (current === null) throw new NotFoundProblem("That member is not in this team")

      await this.teams.removeMember(orgId, team.id, membershipId)
      await this.audit.record(orgId, [
        { action: "TEAM_MEMBER_REMOVED", entityType: "Team", entityId: team.id, diff: { membershipId } },
        ...(current.isLead
          ? [{ action: "TEAM_LEAD_CHANGED" as const, entityType: "Team" as const, entityId: team.id, diff: { lead: { from: membershipId, to: null } } }]
          : []),
      ])
      return [membershipId]
    })
  }

  /** An admin's call, not a lead's. The new lead must already be in the team and hold AGENT or above. */
  async setLead(teamId: string, membershipId: string | null): Promise<TeamDetail> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "team:write")
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const team = await this.lockedActiveTeam(orgId, teamId)
      if (membershipId !== null) {
        const inTeam = await this.teams.findMembership(orgId, team.id, membershipId)
        if (inTeam === null) throw new ConflictProblem("A lead must be a member of the team; add them first")
        if (inTeam.isLead) return
        const target = await this.memberships.findById(orgId, membershipId)
        if (target === null || target.status !== "ACTIVE" || target.role === "REQUESTER") {
          throw new ConflictProblem("A lead must be an active agent or above")
        }
      }
      const previous = await this.teams.clearLead(orgId, team.id)
      if (previous === membershipId) return
      if (membershipId !== null) await this.teams.makeLead(orgId, team.id, membershipId)
      await this.audit.record(orgId, [
        { action: "TEAM_LEAD_CHANGED", entityType: "Team", entityId: team.id, diff: { lead: { from: previous, to: membershipId } } },
      ])
      for (const affected of [previous, membershipId]) if (affected !== null) await this.epochs.bump(affected)
    })
    return this.get(teamId)
  }

  /**
   * Membership changes: a lead may make them for their own team (`lead`), an
   * admin for any. Locked per team, then the change, then the epoch bumps for
   * whoever `apply` names, all in one transaction.
   */
  private async changeMembership(
    teamId: string,
    apply: (orgId: string, team: TeamRecord) => Promise<string[]>,
  ): Promise<void> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const team = await this.teams.findById(orgId, teamId)
      if (team === null) throw new NotFoundProblem()
      this.permissions.assert(actor, "team:manage_own_members", { lead: leads(actor, team.id) })
      await this.lockedActiveTeam(orgId, teamId)
      for (const affected of await apply(orgId, team)) await this.epochs.bump(affected)
    })
  }

  private async lockedActiveTeam(orgId: string, teamId: string): Promise<TeamRecord> {
    await this.teams.lock(orgId, teamId)
    const team = await this.teams.findById(orgId, teamId)
    if (team === null) throw new NotFoundProblem()
    if (!team.isActive) throw new ConflictProblem("The team is deactivated")
    return team
  }
}

function leads(actor: TenantActor, teamId: string): boolean {
  return actor.kind === "member" && actor.leadOfTeamIds.includes(teamId)
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    memberCount: row.memberCount,
    lead: row.lead,
  }
}
