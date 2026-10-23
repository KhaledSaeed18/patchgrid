import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

/**
 * Which membership an identity provider's subject is (ADR-0054). Tenant-owned;
 * a person by membership, never by user (ADR-0023).
 */
@Injectable()
export class SsoIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async membershipFor(orgId: string, connectionId: string, subject: string): Promise<string | null> {
    const row = await this.prisma.db.ssoIdentity.findUnique({
      where: { orgId_connectionId_subject: { orgId, connectionId, subject } },
      select: { membershipId: true },
    })
    return row?.membershipId ?? null
  }

  /** The subject already linked to this membership, if any: one identity per member. */
  async subjectOf(orgId: string, membershipId: string): Promise<string | null> {
    const row = await this.prisma.db.ssoIdentity.findUnique({
      where: { orgId_membershipId: { orgId, membershipId } },
      select: { subject: true },
    })
    return row?.subject ?? null
  }

  async link(orgId: string, connectionId: string, subject: string, membershipId: string, at: Date): Promise<string> {
    const row = await this.prisma.db.ssoIdentity.create({
      data: { orgId, connectionId, subject, membershipId, lastSignInAt: at },
      select: { id: true },
    })
    return row.id
  }

  async touch(orgId: string, connectionId: string, subject: string, at: Date): Promise<void> {
    await this.prisma.db.ssoIdentity.updateMany({ where: { orgId, connectionId, subject }, data: { lastSignInAt: at } })
  }
}
