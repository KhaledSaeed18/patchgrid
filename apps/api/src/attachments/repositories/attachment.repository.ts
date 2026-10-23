import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

export type AttachmentRow = {
  id: string
  ticketId: string
  commentId: string | null
  uploaderMembershipId: string
  filename: string
  declaredMimeType: string
  mimeType: string | null
  sizeBytes: number
  storageKey: string
  status: "PENDING" | "READY"
  createdAt: Date
  uploader: { id: string; displayName: string }
  /** The comment it sits on, whose visibility it inherits; `null` for the ticket itself. */
  comment: { visibility: "PUBLIC" | "INTERNAL"; deletedAt: Date | null } | null
}

const ROW = {
  id: true,
  ticketId: true,
  commentId: true,
  uploaderMembershipId: true,
  filename: true,
  declaredMimeType: true,
  mimeType: true,
  sizeBytes: true,
  storageKey: true,
  status: true,
  createdAt: true,
  uploader: { select: { id: true, displayName: true } },
  comment: { select: { visibility: true, deletedAt: true } },
} as const

/** An abandoned upload, as the sweep removes it: what to delete, and what to give back. */
export type Abandoned = { id: string; sizeBytes: number; storageKey: string }

/** `Attachment` (ADR-0005). Tenant-owned; every method takes the org. */
@Injectable()
export class AttachmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    orgId: string,
    data: {
      ticketId: string
      commentId: string | null
      uploaderMembershipId: string
      filename: string
      declaredMimeType: string
      sizeBytes: number
      storageKey: string
    },
  ): Promise<AttachmentRow> {
    return this.prisma.db.attachment.create({ data: { orgId, ...data }, select: ROW })
  }

  find(orgId: string, id: string): Promise<AttachmentRow | null> {
    return this.prisma.db.attachment.findUnique({ where: { orgId_id: { orgId, id } }, select: ROW })
  }

  /**
   * A ticket's ready files, oldest first — those on an internal note only
   * when the reader may read internal notes, and none on a deleted comment.
   * The filter is in the query, as it is for the comments themselves.
   */
  listReady(orgId: string, ticketId: string, includeInternal: boolean): Promise<AttachmentRow[]> {
    return this.prisma.db.attachment.findMany({
      where: {
        orgId,
        ticketId,
        status: "READY",
        OR: [{ commentId: null }, { comment: { deletedAt: null, ...(includeInternal ? {} : { visibility: "PUBLIC" }) } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: ROW,
    })
  }

  /** `PENDING` → `READY` with what sniffing found; `false` if it was not pending any more. */
  async markReady(orgId: string, id: string, mimeType: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.db.attachment.updateMany({
      where: { orgId, id, status: "PENDING" },
      data: { status: "READY", mimeType, completedAt: now },
    })
    return count === 1
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.db.attachment.deleteMany({ where: { orgId, id } })
    return count === 1
  }

  /**
   * Uploads still `PENDING` past `cutoff`, locked and removed in one go — a
   * `complete` racing the sweep waits for the lock and then finds nothing.
   * Raw for `FOR UPDATE SKIP LOCKED`, so inside `transaction()`.
   */
  async removeAbandoned(orgId: string, cutoff: Date, limit: number): Promise<Abandoned[]> {
    const rows = await this.prisma.tx.$queryRaw<Abandoned[]>`
      SELECT id, "sizeBytes", "storageKey" FROM "Attachment"
      WHERE "orgId" = ${orgId}::uuid AND status = 'PENDING' AND "createdAt" < ${cutoff}
      ORDER BY "createdAt" LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`
    if (rows.length > 0) await this.prisma.db.attachment.deleteMany({ where: { orgId, id: { in: rows.map((r) => r.id) } } })
    return rows
  }
}
