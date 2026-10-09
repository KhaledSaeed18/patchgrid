import { Injectable } from "@nestjs/common"
import type { CommentAuthorKind, CommentVisibility } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type CommentRow = {
  id: string
  ticketId: string
  authorMembershipId: string | null
  authorKind: CommentAuthorKind
  body: string
  visibility: CommentVisibility
  editedAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  author: { id: string; displayName: string } | null
}

const ROW = {
  id: true,
  ticketId: true,
  authorMembershipId: true,
  authorKind: true,
  body: true,
  visibility: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  author: { select: { id: true, displayName: true } },
} as const

/**
 * Comments (DOMAIN.md §7). `includeInternal` is the ONLY way an internal note
 * leaves this repository, and the service passes it from the permission check:
 * a requester-scoped read cannot return one, because the query never asks.
 */
@Injectable()
export class CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(orgId: string, ticketId: string, includeInternal: boolean): Promise<CommentRow[]> {
    return this.prisma.db.comment.findMany({
      where: { orgId, ticketId, ...(includeInternal ? {} : { visibility: "PUBLIC" }) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: ROW,
    })
  }

  find(orgId: string, ticketId: string, id: string): Promise<CommentRow | null> {
    return this.prisma.db.comment.findUnique({ where: { orgId_ticketId_id: { orgId, ticketId, id } }, select: ROW })
  }

  create(
    orgId: string,
    data: { ticketId: string; authorMembershipId: string | null; authorKind: CommentAuthorKind; body: string; visibility: CommentVisibility },
  ): Promise<CommentRow> {
    return this.prisma.db.comment.create({ data: { orgId, ...data }, select: ROW })
  }

  async edit(orgId: string, id: string, body: string, at: Date): Promise<void> {
    await this.prisma.db.comment.update({ where: { orgId_id: { orgId, id } }, data: { body, editedAt: at } })
  }

  /** Soft: the row stays so the audit log points at something (DOMAIN.md §7). */
  async softDelete(orgId: string, id: string, by: string, at: Date): Promise<void> {
    await this.prisma.db.comment.update({
      where: { orgId_id: { orgId, id } },
      data: { deletedAt: at, deletedByMembershipId: by },
    })
  }
}
