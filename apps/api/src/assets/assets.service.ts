import { Injectable } from "@nestjs/common"
import {
  type AgentVisibility,
  type Asset,
  type AssetDetail,
  type AssetListQuery,
  type AssetPage,
  type CreateAssetRequest,
  decodeCursor,
  encodeCursor,
  type LinkedAsset,
  type UpdateAssetRequest,
} from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, ValidationProblem } from "../common/problems/problem.exception"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { type AssetFields, AssetRepository, type AssetRow } from "./repositories/asset.repository"

/**
 * The CMDB (DOMAIN.md §9.3, RBAC.md §6). Agents keep the register; a
 * requester sees the assets they hold. Visibility is `scopeFor("asset")`
 * for a list and the same `own` decision for one asset, so the two cannot
 * disagree. An asset a ticket names is retired, never deleted.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly assets: AssetRepository,
    private readonly memberships: MembershipRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: AssetListQuery): Promise<AssetPage> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    this.permissions.assert(actor, "asset:read", { own: true })
    // The org's ticket visibility setting says nothing about assets; the policy is read for tickets only.
    const scope = this.permissions.scopeFor(actor, "asset", { agentVisibility: "ALL_TICKETS" })
    if (scope.kind === "none") return { items: [], nextCursor: null }
    const branch = scope.kind === "all" ? null : scope.branches[0]
    if (branch !== null && branch.kind !== "owner") throw new Error("an asset scope is only ever its owner")

    let after: { name: string; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      if (parts === null) throw fieldError("cursor", "is not a cursor this endpoint issued")
      after = { name: parts.sortValue, id: parts.id }
    }
    const rows = await this.assets.list(orgId, branch, {
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.ownerMembershipId === undefined ? {} : { ownerMembershipId: query.ownerMembershipId }),
      after,
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toAsset),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor({ sortValue: last.name, id: last.id }) : null,
    }
  }

  /** One logical read, one transaction: the asset and how many tickets name it. */
  async get(id: string): Promise<AssetDetail> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    return this.prisma.transaction(async () => {
      const row = await this.visibleOne(orgId, id, actor)
      // A count of tickets the reader cannot open would tell them something about those tickets (DOMAIN.md §9.3).
      const seesEveryTicket = this.permissions.scopeFor(actor, "ticket", { agentVisibility: this.visibility() }).kind === "all"
      const ticketCount = seesEveryTicket ? await this.assets.ticketCount(orgId, id) : null
      return {
        ...toAsset(row),
        notes: row.notes,
        ticketCount,
        capabilities: {
          canEdit: this.permissions.can(actor, "asset:write"),
          canDelete: this.permissions.can(actor, "asset:delete"),
        },
      }
    })
  }

  async create(request: CreateAssetRequest): Promise<AssetDetail> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "asset:write")
    const orgId = this.tenant.requireOrgId()
    const fields: AssetFields = {
      name: request.name,
      type: request.type,
      status: request.status ?? "IN_STOCK",
      serialNumber: request.serialNumber ?? null,
      ownerMembershipId: request.ownerMembershipId ?? null,
      purchaseDate: day(request.purchaseDate ?? null),
      warrantyExpiresAt: day(request.warrantyExpiresAt ?? null),
      notes: request.notes ?? null,
    }
    checkDates(fields)
    const id = await this.prisma.transaction(async () => {
      if (fields.ownerMembershipId !== null) await this.requireOwner(orgId, fields.ownerMembershipId)
      const created = await this.assets.create(orgId, fields)
      if (created === "serial-taken") throw new ConflictProblem("Another asset already has that serial number")
      await this.audit.record(orgId, [
        {
          action: "ASSET_CREATED",
          entityType: "Asset",
          entityId: created,
          diff: { name: fields.name, type: fields.type, serialNumber: fields.serialNumber },
        },
      ])
      return created
    })
    return this.get(id)
  }

  async update(id: string, request: UpdateAssetRequest): Promise<AssetDetail> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      await this.visibleOne(orgId, id, actor)
      this.permissions.assert(actor, "asset:write")
      await this.assets.lock(orgId, id)
      const before = await this.assets.find(orgId, id)
      if (before === null) throw new NotFoundProblem()

      const requested: Partial<AssetFields> = {}
      for (const [field, value] of Object.entries(request) as [keyof UpdateAssetRequest, unknown][]) {
        if (value === undefined) continue
        Object.assign(requested, {
          [field]: field === "purchaseDate" || field === "warrantyExpiresAt" ? day(value as string | null) : value,
        })
      }
      const changed = (Object.keys(requested) as (keyof AssetFields)[]).filter((field) => !same(before[field], requested[field]))
      if (changed.length === 0) return
      const changes = Object.fromEntries(changed.map((field) => [field, requested[field]])) as Partial<AssetFields>
      checkDates({ ...before, ...changes })
      if (changes.ownerMembershipId !== undefined && changes.ownerMembershipId !== null) {
        await this.requireOwner(orgId, changes.ownerMembershipId)
      }

      if ((await this.assets.update(orgId, id, changes)) === "serial-taken") {
        throw new ConflictProblem("Another asset already has that serial number")
      }
      const diff = Object.fromEntries(changed.map((field) => [field, { from: wire(before[field]), to: wire(changes[field] ?? null) }]))
      await this.audit.record(orgId, [{ action: "ASSET_UPDATED", entityType: "Asset", entityId: id, diff }])
    })
    return this.get(id)
  }

  /** For an asset entered by mistake. One a ticket names is retired instead — its history is the point. */
  async remove(id: string): Promise<void> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const row = await this.visibleOne(orgId, id, actor)
      this.permissions.assert(actor, "asset:delete")
      await this.assets.lock(orgId, id)
      if ((await this.assets.ticketCount(orgId, id)) > 0) {
        throw new ConflictProblem("Tickets name this asset; retire it rather than deleting it")
      }
      if (!(await this.assets.remove(orgId, id))) throw new NotFoundProblem()
      await this.audit.record(orgId, [
        { action: "ASSET_DELETED", entityType: "Asset", entityId: id, diff: { name: row.name, serialNumber: row.serialNumber } },
      ])
    })
  }

  /**
   * The assets among `ids` this actor may open — the same decision `get`
   * makes, for several at once. A ticket that names assets checks them here;
   * one the actor cannot see is simply absent, and the caller says so.
   */
  async visible(orgId: string, actor: TenantActor, ids: readonly string[]): Promise<LinkedAsset[]> {
    const rows = await this.assets.findMany(orgId, ids)
    return rows
      .filter((row) => this.permissions.can(actor, "asset:read", { own: row.ownerMembershipId === actor.membershipId }))
      .map(({ id, name, type, status }) => ({ id, name, type, status }))
  }

  /** Reads are 404 for an asset the actor may not open (RBAC.md §11). */
  private async visibleOne(orgId: string, id: string, actor: TenantActor): Promise<AssetRow> {
    const row = await this.assets.find(orgId, id)
    if (row === null) throw new NotFoundProblem()
    this.permissions.assertVisible(actor, "asset:read", { own: row.ownerMembershipId === actor.membershipId })
    return row
  }

  private visibility(): AgentVisibility {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }

  private async requireOwner(orgId: string, membershipId: string): Promise<void> {
    const owner = await this.memberships.findById(orgId, membershipId)
    if (owner === null || owner.status === "REMOVED") throw fieldError("ownerMembershipId", "is not a member of this workspace")
  }
}

export function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    serialNumber: row.serialNumber,
    owner: row.owner === null ? null : { membershipId: row.owner.id, displayName: row.owner.displayName },
    purchaseDate: dayString(row.purchaseDate),
    warrantyExpiresAt: dayString(row.warrantyExpiresAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** `2026-10-14` ⇄ the UTC midnight a `date` column holds. */
function day(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`)
}

function dayString(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10)
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

function wire(value: unknown): unknown {
  return value instanceof Date ? dayString(value) : value
}

function checkDates(fields: Pick<AssetFields, "purchaseDate" | "warrantyExpiresAt">): void {
  const { purchaseDate, warrantyExpiresAt } = fields
  if (purchaseDate !== null && warrantyExpiresAt !== null && warrantyExpiresAt < purchaseDate) {
    throw fieldError("warrantyExpiresAt", "is before the purchase date")
  }
}

function fieldError(path: string, message: string): ValidationProblem {
  return new ValidationProblem([{ path, message, code: "invalid_asset" }])
}
