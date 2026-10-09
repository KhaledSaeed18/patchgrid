import { Injectable } from "@nestjs/common"
import type { Category, CreateCategoryRequest, UpdateCategoryRequest } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, ValidationProblem } from "../common/problems/problem.exception"
import { PrismaService } from "../prisma/prisma.service"
import { TeamRepository } from "../teams/repositories/team.repository"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { planMove, routeTeam, visible } from "./domain/tree"
import { type CategoryRecord, CategoryRepository } from "./repositories/category.repository"

const MOVE_REFUSAL = {
  cycle: "cannot be inside itself or one of its own subcategories",
  "too-deep": "would put a subcategory deeper than three levels",
  "unknown-parent": "is not a category in this workspace",
  "inactive-parent": "is deactivated",
} as const

/**
 * The category tree (DOMAIN.md §5). Everyone reads the active tree — a
 * requester picks from it — and admins change it: three levels, names unique
 * per parent, deactivated never deleted, each optionally routed to a team.
 */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly teams: TeamRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  async list(includeInactive: boolean): Promise<Category[]> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "category:read")
    // The inactive part of the tree is an admin's view.
    if (includeInactive) this.permissions.assert(actor, "category:write")
    const all = await this.categories.all(this.tenant.requireOrgId())
    const shown = visible(all)
    return (includeInactive ? all : all.filter((c) => shown.has(c.id))).map(toCategory)
  }

  /** The team a ticket in this category routes to, for the ticket service. */
  async routeTeam(orgId: string, categoryId: string): Promise<string | null> {
    return routeTeam(categoryId, await this.categories.all(orgId))
  }

  async create(request: CreateCategoryRequest): Promise<Category> {
    this.permissions.assert(this.actors.requireTenantActor(), "category:write")
    const orgId = this.tenant.requireOrgId()
    return this.prisma.transaction(async () => {
      await this.categories.lockTree(orgId)
      const all = await this.categories.all(orgId)
      const parentId = request.parentId ?? null
      if (parentId !== null) {
        const parent = all.find((c) => c.id === parentId)
        if (parent === undefined) throw fieldError("parentId", MOVE_REFUSAL["unknown-parent"])
        if (!parent.isActive) throw fieldError("parentId", MOVE_REFUSAL["inactive-parent"])
        if (parent.depth >= 3) throw fieldError("parentId", MOVE_REFUSAL["too-deep"])
      }
      await this.assertTeam(orgId, request.defaultTeamId ?? null)
      const siblings = all.filter((c) => c.parentId === parentId)
      const created = await this.categories.create(orgId, {
        name: request.name,
        parentId,
        depth: parentId === null ? 1 : (all.find((c) => c.id === parentId)?.depth ?? 0) + 1,
        defaultTeamId: request.defaultTeamId ?? null,
        sortOrder: siblings.length,
      })
      if (created === "name-taken") throw new ConflictProblem("A category with that name already exists there")
      return toCategory(created)
    })
  }

  async update(id: string, request: UpdateCategoryRequest): Promise<Category> {
    this.permissions.assert(this.actors.requireTenantActor(), "category:write")
    const orgId = this.tenant.requireOrgId()
    return this.prisma.transaction(async () => {
      await this.categories.lockTree(orgId)
      const all = await this.categories.all(orgId)
      const current = all.find((c) => c.id === id)
      if (current === undefined) throw new NotFoundProblem()

      const changes: Parameters<CategoryRepository["update"]>[2] = {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
        ...(request.sortOrder === undefined ? {} : { sortOrder: request.sortOrder }),
      }
      if (request.parentId !== undefined && request.parentId !== current.parentId) {
        const plan = planMove(id, request.parentId, all)
        if (!plan.ok) throw fieldError("parentId", MOVE_REFUSAL[plan.reason])
        for (const [nodeId, depth] of plan.depths) {
          if (nodeId !== id) await this.categories.setDepth(orgId, nodeId, depth)
        }
        changes.parentId = request.parentId
        changes.depth = plan.depths.get(id) ?? current.depth
      }
      if (request.defaultTeamId !== undefined) {
        await this.assertTeam(orgId, request.defaultTeamId)
        changes.defaultTeamId = request.defaultTeamId
      }

      const result = await this.categories.update(orgId, id, changes)
      if (result === "name-taken") throw new ConflictProblem("A category with that name already exists there")
      const updated = (await this.categories.all(orgId)).find((c) => c.id === id)
      if (updated === undefined) throw new NotFoundProblem()
      return toCategory(updated)
    })
  }

  private async assertTeam(orgId: string, teamId: string | null): Promise<void> {
    if (teamId === null) return
    const team = await this.teams.findById(orgId, teamId)
    if (team === null || !team.isActive) throw fieldError("defaultTeamId", "is not an active team")
  }
}

function fieldError(path: string, message: string): ValidationProblem {
  return new ValidationProblem([{ path, message, code: "invalid_category" }])
}

function toCategory(record: CategoryRecord): Category {
  return { ...record }
}
