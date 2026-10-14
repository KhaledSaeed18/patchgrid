import { Injectable } from "@nestjs/common"
import type { MembershipStatus, OrgExportStatus, Role } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type OrgExportRow = {
  id: string
  status: OrgExportStatus
  requestedAt: Date
  readyAt: Date | null
  expiresAt: Date | null
  sizeBytes: bigint | null
  storageKey: string | null
  failure: string | null
  requestedBy: { id: string; displayName: string; role: Role; status: MembershipStatus; user: { email: string } | null }
}

const ROW = {
  id: true,
  status: true,
  requestedAt: true,
  readyAt: true,
  expiresAt: true,
  sizeBytes: true,
  storageKey: true,
  failure: true,
  requestedBy: { select: { id: true, displayName: true, role: true, status: true, user: { select: { email: true } } } },
} as const

/**
 * `OrgExport` (ADR-0044). Tenant-owned; every method takes the org. Each move
 * names the status it starts from, so a retried job cannot finish an export
 * twice, nor revive one the sweep expired.
 */
@Injectable()
export class OrgExportRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(orgId: string, requestedByMembershipId: string, at: Date): Promise<string> {
    const row = await this.prisma.db.orgExport.create({ data: { orgId, requestedByMembershipId, requestedAt: at }, select: { id: true } })
    return row.id
  }

  find(orgId: string, id: string): Promise<OrgExportRow | null> {
    return this.prisma.db.orgExport.findUnique({ where: { orgId_id: { orgId, id } }, select: ROW })
  }

  list(orgId: string, limit = 20): Promise<OrgExportRow[]> {
    return this.prisma.db.orgExport.findMany({ where: { orgId }, orderBy: [{ requestedAt: "desc" }, { id: "desc" }], take: limit, select: ROW })
  }

  /** The newest export that counts against the daily allowance — a failed one does not. */
  async latestCounted(orgId: string): Promise<Date | null> {
    const row = await this.prisma.db.orgExport.findFirst({
      where: { orgId, status: { not: "FAILED" } },
      orderBy: { requestedAt: "desc" },
      select: { requestedAt: true },
    })
    return row?.requestedAt ?? null
  }

  async start(orgId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.db.orgExport.updateMany({ where: { orgId, id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "RUNNING" } })
    return count === 1
  }

  async ready(orgId: string, id: string, done: { storageKey: string; sizeBytes: number; readyAt: Date; expiresAt: Date }): Promise<boolean> {
    const { count } = await this.prisma.db.orgExport.updateMany({
      where: { orgId, id, status: "RUNNING" },
      data: { status: "READY", storageKey: done.storageKey, sizeBytes: BigInt(done.sizeBytes), readyAt: done.readyAt, expiresAt: done.expiresAt },
    })
    return count === 1
  }

  async fail(orgId: string, id: string, failure: string): Promise<void> {
    await this.prisma.db.orgExport.updateMany({ where: { orgId, id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", failure: failure.slice(0, 500) } })
  }

  /** Ready exports whose link has lapsed — the retention sweep's work. */
  lapsed(orgId: string, now: Date): Promise<{ id: string; storageKey: string | null }[]> {
    return this.prisma.db.orgExport.findMany({ where: { orgId, status: "READY", expiresAt: { lte: now } }, select: { id: true, storageKey: true } })
  }

  async expire(orgId: string, id: string): Promise<void> {
    await this.prisma.db.orgExport.updateMany({ where: { orgId, id, status: "READY" }, data: { status: "EXPIRED" } })
  }
}
