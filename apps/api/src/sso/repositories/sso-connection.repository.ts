import { Injectable } from "@nestjs/common"
import type { SsoDefaultRole } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type SsoConnectionRecord = {
  id: string
  orgId: string
  issuer: string
  clientId: string
  clientSecretSealed: string
  defaultRole: SsoDefaultRole
  enabled: boolean
  updatedAt: Date
}

const RECORD = { id: true, orgId: true, issuer: true, clientId: true, clientSecretSealed: true, defaultRole: true, enabled: true, updatedAt: true } as const

/**
 * A workspace's one OpenID Connect connection (ADR-0054). Tenant-owned: every
 * method takes the org and filters on it, under RLS as well.
 */
@Injectable()
export class SsoConnectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(orgId: string): Promise<SsoConnectionRecord | null> {
    const row = await this.prisma.db.ssoConnection.findUnique({ where: { orgId }, select: RECORD })
    return row === null ? null : toRecord(row)
  }

  /**
   * Creates or replaces the connection. A new issuer drops every identity
   * link: a subject is unique per issuer only, and a new provider's `sub` must
   * never inherit an old one's membership. Run inside the caller's transaction.
   */
  async save(
    orgId: string,
    data: { issuer: string; clientId: string; clientSecretSealed: string; defaultRole: SsoDefaultRole; enabled: boolean },
  ): Promise<{ record: SsoConnectionRecord; issuerChanged: boolean }> {
    const existing = await this.prisma.db.ssoConnection.findUnique({ where: { orgId }, select: { id: true, issuer: true } })
    if (existing === null) {
      const created = await this.prisma.db.ssoConnection.create({ data: { orgId, ...data }, select: RECORD })
      return { record: toRecord(created), issuerChanged: false }
    }
    const issuerChanged = existing.issuer !== data.issuer
    if (issuerChanged) await this.prisma.db.ssoIdentity.deleteMany({ where: { orgId, connectionId: existing.id } })
    const updated = await this.prisma.db.ssoConnection.update({ where: { orgId_id: { orgId, id: existing.id } }, data, select: RECORD })
    return { record: toRecord(updated), issuerChanged }
  }
}

function toRecord(row: Omit<SsoConnectionRecord, "defaultRole"> & { defaultRole: string }): SsoConnectionRecord {
  // The CHECK constraint keeps it to these two; a third would be a schema bug, refused rather than widened.
  if (row.defaultRole !== "REQUESTER" && row.defaultRole !== "AGENT") throw new Error(`SsoConnection ${row.id} has default role ${row.defaultRole}`)
  return { ...row, defaultRole: row.defaultRole }
}
