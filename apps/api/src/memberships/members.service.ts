import { Injectable } from "@nestjs/common"
import {
  decodeCursor,
  encodeCursor,
  type Member,
  type MemberListQuery,
  type MemberPage,
  type Role,
} from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { RevocationEpochService } from "../auth/revocation/revocation-epoch.service"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import {
  ConflictProblem,
  NotFoundProblem,
  NotPermittedProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import { UserOrgIndexRepository } from "../platform/repositories/user-org-index.repository"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { type MembershipRecord, MembershipRepository, type MemberRow } from "./repositories/membership.repository"

const PRIVILEGED: ReadonlySet<Role> = new Set(["ADMIN", "OWNER"])

/**
 * Members of the current organization (ADR-0033, RBAC.md §3 and §6).
 *
 * Every change runs in one transaction that first locks the organization row,
 * so the last-owner rule is decided on committed data: two owners demoting
 * each other serialise, and the second sees one owner left. The same
 * transaction mirrors the change into the picker's projection, writes the
 * audit row, and bumps the revocation epoch last — a bump that cannot be
 * recorded fails the change rather than pretending it revoked anything.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly workspaces: UserOrgIndexRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly epochs: RevocationEpochService,
  ) {}

  async list(query: MemberListQuery): Promise<MemberPage> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "member:read")
    if (query.includeRemoved && !this.seesRemoved(actor)) throw new NotPermittedProblem()

    let after: { createdAt: Date; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      const createdAt = parts === null ? null : new Date(parts.sortValue)
      if (parts === null || createdAt === null || Number.isNaN(createdAt.getTime())) {
        throw new ValidationProblem([{ path: "cursor", message: "is not a cursor this endpoint issued", code: "invalid_cursor" }])
      }
      after = { createdAt, id: parts.id }
    }

    const rows = await this.memberships.list(this.tenant.requireOrgId(), {
      includeRemoved: query.includeRemoved,
      withContact: this.permissions.can(actor, "member:read_contact"),
      limit: query.limit + 1,
      after,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toMember),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  }

  async get(id: string): Promise<Member> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assertVisible(actor, "member:read")
    const row = await this.memberships.findMember(
      this.tenant.requireOrgId(),
      id,
      this.permissions.can(actor, "member:read_contact"),
    )
    if (row === null || (row.status === "REMOVED" && !this.seesRemoved(actor))) throw new NotFoundProblem()
    return toMember(row)
  }

  async changeRole(id: string, role: Role): Promise<Member> {
    await this.change(id, async (actor, orgId, target) => {
      this.permissions.assert(actor, "member:update_role", subjectOf(actor, target))
      // Raising anyone to ADMIN or OWNER is an owner's call, whoever they are now.
      if (PRIVILEGED.has(role)) this.permissions.assert(actor, "member:promote_admin")
      if (target.role === role) return false
      if (target.role === "OWNER") await this.assertNotLastOwner(orgId, target)

      await this.memberships.setRole(orgId, target.id, role)
      // Teams are where agents work; a requester leads and works in none (ADR-0025).
      const leftTeams = role === "REQUESTER" ? await this.memberships.leaveAllTeams(orgId, target.id) : []
      if (target.userId !== null) await this.workspaces.mirror(target.userId, orgId, { role })
      await this.audit.record(orgId, [
        {
          action: "MEMBER_ROLE_CHANGED",
          entityType: "Membership",
          entityId: target.id,
          diff: { role: { from: target.role, to: role }, ...(leftTeams.length > 0 ? { leftTeams } : {}) },
        },
      ])
      return true
    })
    return this.get(id)
  }

  async disable(id: string): Promise<Member> {
    await this.change(id, async (actor, orgId, target) => {
      this.permissions.assert(actor, "member:disable", subjectOf(actor, target))
      if (target.status !== "ACTIVE") throw new ConflictProblem("Only an active member can be disabled")
      if (target.role === "OWNER") await this.assertNotLastOwner(orgId, target)

      await this.memberships.setStatus(orgId, target.id, "DISABLED")
      if (target.userId !== null) await this.workspaces.mirror(target.userId, orgId, { status: "DISABLED" })
      await this.audit.record(orgId, [{ action: "MEMBER_DISABLED", entityType: "Membership", entityId: target.id }])
      return true
    })
    return this.get(id)
  }

  /** `member:disable` governs the switch in both directions (ADR-0033). */
  async enable(id: string): Promise<Member> {
    await this.change(id, async (actor, orgId, target) => {
      this.permissions.assert(actor, "member:disable", subjectOf(actor, target))
      if (target.status !== "DISABLED") throw new ConflictProblem("Only a disabled member can be enabled")

      await this.memberships.setStatus(orgId, target.id, "ACTIVE")
      if (target.userId !== null) await this.workspaces.mirror(target.userId, orgId, { status: "ACTIVE" })
      await this.audit.record(orgId, [{ action: "MEMBER_ENABLED", entityType: "Membership", entityId: target.id }])
      // Nothing was revoked by enabling; tokens from before the disable stay dead.
      return false
    })
    return this.get(id)
  }

  /** Terminal: the row stays so history keeps its author; everything else goes (ADR-0033). */
  async remove(id: string): Promise<void> {
    await this.change(id, async (actor, orgId, target) => {
      this.permissions.assert(actor, "member:remove", subjectOf(actor, target))
      if (target.role === "OWNER" && target.status === "ACTIVE") await this.assertNotLastOwner(orgId, target)

      await this.memberships.setStatus(orgId, target.id, "REMOVED")
      const leftTeams = await this.memberships.leaveAllTeams(orgId, target.id)
      if (target.userId !== null) await this.workspaces.remove(target.userId, orgId)
      await this.audit.record(orgId, [
        {
          action: "MEMBER_REMOVED",
          entityType: "Membership",
          entityId: target.id,
          diff: { status: { from: target.status, to: "REMOVED" }, ...(leftTeams.length > 0 ? { leftTeams } : {}) },
        },
      ])
      return true
    })
  }

  /**
   * The shape of every change: lock the organization, load the target (a
   * removed member is gone — `404`), let `apply` decide and write, then bump
   * the epoch inside the transaction when `apply` says sessions must die.
   */
  private async change(
    id: string,
    apply: (actor: TenantActor, orgId: string, target: MembershipRecord) => Promise<boolean>,
  ): Promise<void> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      await this.memberships.lockOrganization(orgId)
      const target = await this.memberships.findById(orgId, id)
      if (target === null || target.status === "REMOVED") throw new NotFoundProblem()
      if (await apply(actor, orgId, target)) await this.epochs.bump(target.id)
    })
  }

  /** Under the organization lock `change` took, so the count cannot move underneath. */
  private async assertNotLastOwner(orgId: string, target: MembershipRecord): Promise<void> {
    if (target.status !== "ACTIVE") return
    if ((await this.memberships.countActiveOwners(orgId)) <= 1) {
      throw new ConflictProblem("An organization must keep at least one owner; promote another owner first")
    }
  }

  /** Removed members are an admin's view; nobody else learns they exist. */
  private seesRemoved(actor: TenantActor): boolean {
    return this.permissions.permissionsFor(actor).includes("member:remove")
  }
}

function subjectOf(actor: TenantActor, target: MembershipRecord) {
  return { self: target.id === actor.membershipId, targetRole: target.role }
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    kind: row.kind,
    joinedAt: row.joinedAt?.toISOString() ?? null,
    teams: row.teams,
    contact:
      row.contact === null
        ? null
        : { email: row.contact.email, lastLoginAt: row.contact.lastLoginAt?.toISOString() ?? null },
  }
}
