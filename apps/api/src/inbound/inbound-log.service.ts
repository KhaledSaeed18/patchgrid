import { Injectable } from "@nestjs/common"
import {
  decodeCursor,
  encodeCursor,
  formatTicketNumber,
  type InboundEmail,
  type InboundEmailListQuery,
  type InboundEmailPage,
} from "@patchgrid/contracts"
import { z } from "zod"

import { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { ValidationProblem } from "../common/problems/problem.exception"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { InboundEmailRepository, type InboundEmailRow } from "./repositories/inbound-email.repository"

const skippedSchema = z.array(z.object({ filename: z.string(), reason: z.string() }))

/**
 * What arrived at the workspace's address, and what became of it (ADR-0027):
 * how an admin sees that a colleague's mail was dropped, and why. Admin-only,
 * like the audit log it sits beside — it names senders and subjects of mail
 * that never became a ticket anyone could read.
 */
@Injectable()
export class InboundLogService {
  constructor(
    private readonly inbound: InboundEmailRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
  ) {}

  async list(query: InboundEmailListQuery): Promise<InboundEmailPage> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:read_audit")
    let after: { receivedAt: Date; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      const receivedAt = parts === null ? null : new Date(parts.sortValue)
      if (parts === null || receivedAt === null || Number.isNaN(receivedAt.getTime())) {
        throw new ValidationProblem([{ path: "cursor", message: "is not a cursor this endpoint issued", code: "invalid_cursor" }])
      }
      after = { receivedAt, id: parts.id }
    }
    const rows = await this.inbound.page(this.tenant.requireOrgId(), {
      ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      after,
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toInboundEmail),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeCursor({ sortValue: last.receivedAt.toISOString(), id: last.id }) : null,
    }
  }
}

function toInboundEmail(row: InboundEmailRow): InboundEmail {
  const skipped = skippedSchema.safeParse(row.skippedAttachments)
  return {
    id: row.id,
    fromAddress: row.fromAddress,
    subject: row.subject,
    authVerdict: row.authVerdict,
    outcome: row.outcome,
    sender: row.sender === null ? null : { membershipId: row.sender.id, displayName: row.sender.displayName },
    ticket: row.ticket === null ? null : { id: row.ticket.id, number: formatTicketNumber(row.ticket.type, row.ticket.number) },
    skippedAttachments: skipped.success ? skipped.data : [],
    receivedAt: row.receivedAt.toISOString(),
  }
}
