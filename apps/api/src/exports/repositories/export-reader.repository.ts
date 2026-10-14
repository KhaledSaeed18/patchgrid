import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

const PAGE = 500

/** One page of one entity, and where the next starts — `null` at the end. */
export type ExportPage = { rows: object[]; next: string | null }
export type ExportReader = { file: string; read: (orgId: string, after: string | null) => Promise<ExportPage> }

export type ExportAttachment = { id: string; ticketId: string; commentId: string | null; filename: string; mimeType: string | null; sizeBytes: number; storageKey: string; createdAt: Date }

/**
 * What an export reads (ADR-0044): every entity of one org, a page at a
 * time, inside `runAsTenant`, each page its own transaction. Pages follow the
 * table's key — the id where it has one, the pair where it is a join table —
 * so a row written during the export is either in or out, never twice.
 * Secrets never leave: token and invitation hashes are omitted at the query.
 */
@Injectable()
export class ExportReaderRepository {
  constructor(private readonly prisma: PrismaService) {}

  readonly readers: readonly ExportReader[] = [
    this.byId("members", async (orgId, after) => {
      const rows = await this.prisma.db.membership.findMany({
        where: { orgId, ...gt(after) },
        orderBy: { id: "asc" },
        take: PAGE,
        include: { user: { select: { email: true } } },
      })
      // An erased member's address left with them (ADR-0028); the export does not bring it back.
      return rows.map(({ user, ...m }) => ({ ...m, email: m.anonymisedAt === null ? (user?.email ?? null) : null }))
    }),
    this.byId("teams", (orgId, after) => this.prisma.db.team.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byKey(
      "team-memberships",
      (orgId, after) =>
        this.prisma.db.teamMembership.findMany({
          where: { orgId, ...pairAfter(after, "teamId", "membershipId") },
          orderBy: [{ teamId: "asc" }, { membershipId: "asc" }],
          take: PAGE,
        }),
      (r) => pair(r.teamId, r.membershipId),
    ),
    this.byId("invitations", (orgId, after) =>
      this.prisma.db.invitation.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE, omit: { tokenHash: true } }),
    ),
    this.byId("categories", (orgId, after) => this.prisma.db.category.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byId("sla-policies", (orgId, after) => this.prisma.db.sLAPolicy.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byId("tickets", (orgId, after) => this.prisma.db.ticket.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byId("comments", (orgId, after) => this.prisma.db.comment.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byId("ticket-links", (orgId, after) => this.prisma.db.ticketLink.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byKey(
      "ticket-watchers",
      (orgId, after) =>
        this.prisma.db.ticketWatcher.findMany({
          where: { orgId, ...pairAfter(after, "ticketId", "membershipId") },
          orderBy: [{ ticketId: "asc" }, { membershipId: "asc" }],
          take: PAGE,
        }),
      (r) => pair(r.ticketId, r.membershipId),
    ),
    this.byKey(
      "problem-details",
      (orgId, after) =>
        this.prisma.db.problemDetails.findMany({ where: { orgId, ...(after === null ? {} : { ticketId: { gt: after } }) }, orderBy: { ticketId: "asc" }, take: PAGE }),
      (r) => r.ticketId,
    ),
    this.byKey(
      "change-details",
      (orgId, after) =>
        this.prisma.db.changeDetails.findMany({ where: { orgId, ...(after === null ? {} : { ticketId: { gt: after } }) }, orderBy: { ticketId: "asc" }, take: PAGE }),
      (r) => r.ticketId,
    ),
    this.byId("change-approvals", (orgId, after) => this.prisma.db.changeApproval.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byId("assets", (orgId, after) => this.prisma.db.asset.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byKey(
      "ticket-assets",
      (orgId, after) =>
        this.prisma.db.ticketAsset.findMany({
          where: { orgId, ...pairAfter(after, "ticketId", "assetId") },
          orderBy: [{ ticketId: "asc" }, { assetId: "asc" }],
          take: PAGE,
        }),
      (r) => pair(r.ticketId, r.assetId),
    ),
    this.byId("knowledge-articles", (orgId, after) =>
      this.prisma.db.knowledgeArticle.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE }),
    ),
    this.byId("inbound-emails", (orgId, after) => this.prisma.db.inboundEmail.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byId("audit-log", (orgId, after) => this.prisma.db.auditLog.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
    this.byId("api-tokens", (orgId, after) =>
      this.prisma.db.apiToken.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE, omit: { tokenHash: true } }),
    ),
    this.byId("support-sessions", (orgId, after) => this.prisma.db.supportSession.findMany({ where: { orgId, ...gt(after) }, orderBy: { id: "asc" }, take: PAGE })),
  ]

  /** Uploaded files only — a pending upload was never part of the record. */
  async attachments(orgId: string, after: string | null): Promise<ExportAttachment[]> {
    return this.prisma.db.attachment.findMany({
      where: { orgId, status: "READY", ...gt(after) },
      orderBy: { id: "asc" },
      take: PAGE,
      select: { id: true, ticketId: true, commentId: true, filename: true, mimeType: true, sizeBytes: true, storageKey: true, createdAt: true },
    })
  }

  private byId(file: string, read: (orgId: string, after: string | null) => Promise<({ id: string } & object)[]>): ExportReader {
    return this.byKey(file, read, (r) => r.id)
  }

  private byKey<T extends object>(file: string, read: (orgId: string, after: string | null) => Promise<T[]>, keyOf: (row: T) => string): ExportReader {
    return {
      file,
      read: async (orgId, after) => {
        const rows = await read(orgId, after)
        const last = rows.at(-1)
        return { rows, next: rows.length === PAGE && last !== undefined ? keyOf(last) : null }
      },
    }
  }
}

function gt(after: string | null): { id?: { gt: string } } {
  return after === null ? {} : { id: { gt: after } }
}

function pair(first: string, second: string): string {
  return `${first}/${second}`
}

/** Strictly after `(a, b)` in `(first, second)` order. */
function pairAfter<A extends string, B extends string>(after: string | null, first: A, second: B) {
  if (after === null) return {}
  const [a = "", b = ""] = after.split("/")
  return { OR: [{ [first]: { gt: a } }, { [first]: a, [second]: { gt: b } }] }
}

export const EXPORT_PAGE = PAGE
