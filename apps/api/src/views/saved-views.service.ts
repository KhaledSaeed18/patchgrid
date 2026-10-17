import { Injectable } from "@nestjs/common"
import { type CreateSavedViewRequest, MAX_SAVED_VIEWS, type SavedView, savedViewQuerySchema } from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem, ValidationProblem } from "../common/problems/problem.exception"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { type SavedViewRow, SavedViewRepository } from "./repositories/saved-view.repository"

/**
 * Saved views (ADR-0052): a name and a list query, kept for oneself or shared
 * with one of one's teams. A view is never its results: whoever opens it runs
 * its query under their own visibility, so sharing widens no one's sight.
 */
@Injectable()
export class SavedViewsService {
  constructor(
    private readonly views: SavedViewRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  async list(): Promise<SavedView[]> {
    const { actor, orgId } = this.who()
    const rows = await this.views.listFor(orgId, actor.membershipId, teamsOf(actor))
    return rows.flatMap((row) => toView(row, actor))
  }

  async create(request: CreateSavedViewRequest): Promise<SavedView> {
    const { actor, orgId } = this.who()
    const teamId = request.teamId ?? null
    // Shared only with a team the author is in: a view is for colleagues, not for anyone's team.
    if (teamId !== null && !teamsOf(actor).includes(teamId)) {
      throw new ValidationProblem([{ path: "teamId", message: "is not one of your teams", code: "not_your_team" }])
    }
    const row = await this.prisma.transaction(async () => {
      await this.views.lockOwner(orgId, actor.membershipId)
      if ((await this.views.countOwned(orgId, actor.membershipId)) >= MAX_SAVED_VIEWS) {
        throw new ConflictProblem(`You can keep at most ${String(MAX_SAVED_VIEWS)} saved views`)
      }
      const created = await this.views.create(orgId, { ownerMembershipId: actor.membershipId, teamId, name: request.name, query: request.query })
      if (created === null) throw new ConflictProblem(`You already have a view named "${request.name}"`)
      return created
    })
    const [view] = toView(row, actor)
    if (view === undefined) throw new Error("a view just saved does not read back")
    return view
  }

  /** Its author removes it; a shared one, also the team's lead or an admin. A view the reader cannot see is a 404. */
  async remove(id: string): Promise<void> {
    const { actor, orgId } = this.who()
    await this.prisma.transaction(async () => {
      const row = await this.views.find(orgId, id)
      if (row === null || !visibleTo(row, actor)) throw new NotFoundProblem()
      if (!removableBy(row, actor)) throw new NotPermittedProblem("Only its author, the team's lead or an admin can remove a shared view")
      await this.views.remove(orgId, id)
    })
  }

  private who(): { actor: TenantActor; orgId: string } {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "view:manage")
    return { actor, orgId: this.tenant.requireOrgId() }
  }
}

function teamsOf(actor: TenantActor): string[] {
  return actor.kind === "member" ? actor.teamIds : []
}

function visibleTo(row: SavedViewRow, actor: TenantActor): boolean {
  return row.owner.id === actor.membershipId || (row.teamId !== null && teamsOf(actor).includes(row.teamId))
}

function removableBy(row: SavedViewRow, actor: TenantActor): boolean {
  if (row.owner.id === actor.membershipId) return true
  if (row.teamId === null) return false
  const leads = actor.kind === "member" && actor.leadOfTeamIds.includes(row.teamId)
  return leads || actor.role === "ADMIN" || actor.role === "OWNER"
}

/** A row as the wire has it; a stored query that no longer parses is left out rather than served broken. */
function toView(row: SavedViewRow, actor: TenantActor): SavedView[] {
  const query = savedViewQuerySchema.safeParse(row.query)
  if (!query.success) return []
  return [
    {
      id: row.id,
      name: row.name,
      query: query.data,
      team: row.team,
      owner: { membershipId: row.owner.id, displayName: row.owner.displayName },
      removable: removableBy(row, actor),
    },
  ]
}
