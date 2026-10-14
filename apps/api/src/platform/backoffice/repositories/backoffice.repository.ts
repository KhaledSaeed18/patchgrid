import { Injectable } from "@nestjs/common"
import { OPEN_TICKET_STATUSES, type OrganizationStatus, type Plan } from "@patchgrid/contracts"
import type { Prisma } from "@patchgrid/database"

import { PrismaService } from "../../../prisma/prisma.service"

export type OrgRow = {
  id: string
  name: string
  slug: string
  status: OrganizationStatus
  plan: Plan
  domain: string | null
  createdAt: Date
  deletionRequestedAt: Date | null
}

const ORG = { id: true, name: true, slug: true, status: true, plan: true, domain: true, createdAt: true, deletionRequestedAt: true } satisfies Prisma.OrganizationSelect

/**
 * What the back-office reads and changes (RBAC.md §8). The organization
 * methods touch platform-class tables only; `countsIn` and `membershipIdsIn`
 * read tenant tables and must run inside `runAsTenant` for that org, where
 * RLS decides what they see.
 */
@Injectable()
export class BackofficeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first, keyset on (createdAt, id). */
  list(filter: { q?: string; status?: OrganizationStatus; after: { createdAt: Date; id: string } | null; limit: number }): Promise<OrgRow[]> {
    return this.prisma.db.organization.findMany({
      where: {
        AND: [
          filter.status === undefined ? {} : { status: filter.status },
          filter.q === undefined
            ? {}
            : { OR: [{ name: { contains: filter.q, mode: "insensitive" } }, { slug: { contains: filter.q.toLowerCase() } }] },
          filter.after === null
            ? {}
            : { OR: [{ createdAt: { lt: filter.after.createdAt } }, { createdAt: filter.after.createdAt, id: { lt: filter.after.id } }] },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      select: ORG,
    })
  }

  find(id: string): Promise<OrgRow | null> {
    return this.prisma.db.organization.findUnique({ where: { id }, select: ORG })
  }

  /** Active members per org, from the picker's projection — platform class, so no tenant is entered to count. */
  async activeMembers(orgIds: readonly string[]): Promise<Map<string, number>> {
    if (orgIds.length === 0) return new Map()
    const rows = await this.prisma.db.userOrgIndex.groupBy({
      by: ["orgId"],
      where: { orgId: { in: [...orgIds] }, statusForDisplay: "ACTIVE" },
      _count: { _all: true },
    })
    return new Map(rows.map((r) => [r.orgId, r._count._all]))
  }

  /** Moves the status only from `from`; `false` when it was not there — a racing operator won. */
  async moveStatus(id: string, from: OrganizationStatus, to: OrganizationStatus): Promise<boolean> {
    const { count } = await this.prisma.db.organization.updateMany({ where: { id, status: from }, data: { status: to } })
    if (count === 1) await this.prisma.db.userOrgIndex.updateMany({ where: { orgId: id }, data: { orgStatus: to } })
    return count === 1
  }

  /** `PENDING_DELETION` → `ACTIVE`, the request forgotten, before the purge gets there (ADR-0043). */
  async restoreDeletion(id: string): Promise<boolean> {
    const { count } = await this.prisma.db.organization.updateMany({
      where: { id, status: "PENDING_DELETION" },
      data: { status: "ACTIVE", deletionRequestedAt: null },
    })
    if (count === 1) await this.prisma.db.userOrgIndex.updateMany({ where: { orgId: id }, data: { orgStatus: "ACTIVE", orgDeletionRequestedAt: null } })
    return count === 1
  }

  async setPlan(id: string, plan: Plan): Promise<void> {
    await this.prisma.db.organization.update({ where: { id }, data: { plan } })
  }

  /** Inside `runAsTenant(orgId)`. */
  async countsIn(orgId: string) {
    const db = this.prisma.db
    const [seats, requesters, tickets, openTickets, assets, articles, storage] = [
      await db.membership.count({ where: { orgId, status: "ACTIVE", kind: "HUMAN", role: { not: "REQUESTER" } } }),
      await db.membership.count({ where: { orgId, status: "ACTIVE", kind: "HUMAN", role: "REQUESTER" } }),
      await db.ticket.count({ where: { orgId } }),
      await db.ticket.count({ where: { orgId, status: { in: [...OPEN_TICKET_STATUSES] } } }),
      await db.asset.count({ where: { orgId } }),
      await db.knowledgeArticle.count({ where: { orgId } }),
      await db.usageCounter.findFirst({ where: { orgId, period: "current", metric: "STORAGE_BYTES" }, select: { value: true } }),
    ]
    return { seats, requesters, tickets, openTickets, assets, articles, storageBytes: Number(storage?.value ?? 0) }
  }

  /** Inside `runAsTenant(orgId)`: whether anyone could still run the workspace if it came back. */
  async hasActiveOwner(orgId: string): Promise<boolean> {
    return (await this.prisma.db.membership.count({ where: { orgId, role: "OWNER", status: "ACTIVE", kind: "HUMAN" } })) > 0
  }

  /** Inside `runAsTenant(orgId)`: every membership, so each one's sessions can be ended. */
  async membershipIdsIn(orgId: string): Promise<string[]> {
    const rows = await this.prisma.db.membership.findMany({ where: { orgId }, select: { id: true } })
    return rows.map((r) => r.id)
  }
}
