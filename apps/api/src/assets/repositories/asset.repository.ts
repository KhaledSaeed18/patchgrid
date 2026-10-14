import { Injectable } from "@nestjs/common"
import type { AssetStatus, AssetType } from "@patchgrid/contracts"
import type { Prisma } from "@patchgrid/database"

import type { ScopeBranch } from "../../authz/scope-filter"
import { PrismaService } from "../../prisma/prisma.service"

export type AssetRow = {
  id: string
  name: string
  type: AssetType
  status: AssetStatus
  serialNumber: string | null
  ownerMembershipId: string | null
  purchaseDate: Date | null
  warrantyExpiresAt: Date | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  owner: { id: string; displayName: string } | null
}

/** The stored fields a create or an edit sets; dates are calendar days at UTC midnight. */
export type AssetFields = {
  name: string
  type: AssetType
  status: AssetStatus
  serialNumber: string | null
  ownerMembershipId: string | null
  purchaseDate: Date | null
  warrantyExpiresAt: Date | null
  notes: string | null
}

export type AssetListFilter = {
  q?: string
  type?: AssetType
  status?: AssetStatus
  ownerMembershipId?: string
  /** Keyset: the last row of the previous page. */
  after: { name: string; id: string } | null
  limit: number
}

const ROW = {
  id: true,
  name: true,
  type: true,
  status: true,
  serialNumber: true,
  ownerMembershipId: true,
  purchaseDate: true,
  warrantyExpiresAt: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, displayName: true } },
} satisfies Prisma.AssetSelect

/** `Asset` and `TicketAsset` (DOMAIN.md §9.3). Tenant-owned; every method takes the org. */
@Injectable()
export class AssetRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `serial-taken` when another asset in this org already has the serial number. */
  async create(orgId: string, fields: AssetFields): Promise<string | "serial-taken"> {
    try {
      const row = await this.prisma.db.asset.create({ data: { orgId, ...fields }, select: { id: true } })
      return row.id
    } catch (error) {
      if (isUniqueViolation(error)) return "serial-taken"
      throw error
    }
  }

  async update(orgId: string, id: string, fields: Partial<AssetFields>): Promise<"ok" | "serial-taken"> {
    try {
      await this.prisma.db.asset.update({ where: { orgId_id: { orgId, id } }, data: fields })
      return "ok"
    } catch (error) {
      if (isUniqueViolation(error)) return "serial-taken"
      throw error
    }
  }

  find(orgId: string, id: string): Promise<AssetRow | null> {
    return this.prisma.db.asset.findUnique({ where: { orgId_id: { orgId, id } }, select: ROW })
  }

  findMany(orgId: string, ids: readonly string[]): Promise<AssetRow[]> {
    if (ids.length === 0) return Promise.resolve([])
    return this.prisma.db.asset.findMany({ where: { orgId, id: { in: [...ids] } }, select: ROW })
  }

  /**
   * One page by name, then id. The scope branch is ANDed with the filters, so
   * a requester's `ownerMembershipId` filter can narrow their list but never
   * widen it.
   */
  list(orgId: string, branch: Extract<ScopeBranch, { kind: "owner" }> | null, filter: AssetListFilter): Promise<AssetRow[]> {
    const and: Prisma.AssetWhereInput[] = [{ orgId }]
    if (branch !== null) and.push({ ownerMembershipId: branch.membershipId })
    if (filter.type !== undefined) and.push({ type: filter.type })
    if (filter.status !== undefined) and.push({ status: filter.status })
    if (filter.ownerMembershipId !== undefined) and.push({ ownerMembershipId: filter.ownerMembershipId })
    if (filter.q !== undefined) {
      and.push({
        OR: [
          { name: { contains: filter.q, mode: "insensitive" } },
          { serialNumber: { contains: filter.q, mode: "insensitive" } },
        ],
      })
    }
    if (filter.after !== null) {
      const { name, id } = filter.after
      and.push({ OR: [{ name: { gt: name } }, { name, id: { gt: id } }] })
    }
    return this.prisma.db.asset.findMany({
      where: { AND: and },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: filter.limit,
      select: ROW,
    })
  }

  /** A row lock, so a delete and a link cannot cross (`lock` → count → delete). */
  async lock(orgId: string, id: string): Promise<void> {
    await this.lockMany(orgId, [id])
  }

  /** Several, in id order, so two transactions locking the same pair cannot deadlock. */
  async lockMany(orgId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const sorted = [...new Set(ids)].toSorted()
    await this.prisma.db.$queryRaw`
      SELECT id FROM "Asset" WHERE "orgId" = ${orgId}::uuid AND id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`
  }

  ticketCount(orgId: string, assetId: string): Promise<number> {
    return this.prisma.db.ticketAsset.count({ where: { orgId, assetId } })
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.db.asset.deleteMany({ where: { orgId, id } })
    return count === 1
  }

  /** `false` when the ticket already names the asset. */
  async link(orgId: string, ticketId: string, assetId: string): Promise<boolean> {
    const { count } = await this.prisma.db.ticketAsset.createMany({ data: [{ orgId, ticketId, assetId }], skipDuplicates: true })
    return count === 1
  }

  async linkMany(orgId: string, ticketId: string, assetIds: readonly string[]): Promise<void> {
    if (assetIds.length === 0) return
    await this.prisma.db.ticketAsset.createMany({
      data: assetIds.map((assetId) => ({ orgId, ticketId, assetId })),
      skipDuplicates: true,
    })
  }

  async unlink(orgId: string, ticketId: string, assetId: string): Promise<boolean> {
    const { count } = await this.prisma.db.ticketAsset.deleteMany({ where: { orgId, ticketId, assetId } })
    return count === 1
  }
}

/** Prisma's P2002, recognised by its code so this file need not import the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}
