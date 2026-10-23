import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

export type SavedViewRow = {
  id: string
  name: string
  query: unknown
  teamId: string | null
  team: { id: string; name: string } | null
  owner: { id: string; displayName: string }
}

const ROW = {
  id: true,
  name: true,
  query: true,
  teamId: true,
  team: { select: { id: true, name: true } },
  owner: { select: { id: true, displayName: true } },
} as const

/** Saved views (ADR-0052). Tenant-owned: every method takes the org and filters on it. */
@Injectable()
export class SavedViewRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** A person's own views and those shared with their teams, by name; one read, owner and team joined. */
  listFor(orgId: string, membershipId: string, teamIds: readonly string[]): Promise<SavedViewRow[]> {
    return this.prisma.db.savedView.findMany({
      where: { orgId, OR: [{ ownerMembershipId: membershipId }, ...(teamIds.length === 0 ? [] : [{ teamId: { in: [...teamIds] } }])] },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: ROW,
    })
  }

  find(orgId: string, id: string): Promise<SavedViewRow | null> {
    return this.prisma.db.savedView.findUnique({ where: { orgId_id: { orgId, id } }, select: ROW })
  }

  /** Serialises one person's creates for this transaction, so the cap they check holds. */
  async lockOwner(orgId: string, membershipId: string): Promise<void> {
    await this.prisma.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`saved-views:${orgId}:${membershipId}`}, 0))`
  }

  countOwned(orgId: string, membershipId: string): Promise<number> {
    return this.prisma.db.savedView.count({ where: { orgId, ownerMembershipId: membershipId } })
  }

  /** `null` when the owner already has a view by that name. */
  async create(
    orgId: string,
    data: { ownerMembershipId: string; teamId: string | null; name: string; query: object },
  ): Promise<SavedViewRow | null> {
    try {
      return await this.prisma.db.savedView.create({ data: { orgId, ...data }, select: ROW })
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    return (await this.prisma.db.savedView.deleteMany({ where: { orgId, id } })).count === 1
  }
}

/** Prisma's P2002, recognised by its code so this file need not import the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}
