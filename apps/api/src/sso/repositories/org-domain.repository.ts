import { Injectable } from "@nestjs/common"
import type { Role } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type OrgDomainRecord = {
  id: string
  slug: string
  name: string
  status: string
  domain: string | null
  domainVerifiedAt: Date | null
  domainChallenge: string | null
  requireSso: boolean
  allowDomainJoin: boolean
  defaultJoinRole: Role
}

const RECORD = {
  id: true,
  slug: true,
  name: true,
  status: true,
  domain: true,
  domainVerifiedAt: true,
  domainChallenge: true,
  requireSso: true,
  allowDomainJoin: true,
  defaultJoinRole: true,
} as const

/**
 * A workspace's email domain, its proof and "SSO required" (ADR-0054).
 * `Organization` is platform class: read by id, or by the verified domain,
 * which the partial unique index makes one workspace at most.
 */
@Injectable()
export class OrgDomainRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(orgId: string): Promise<OrgDomainRecord | null> {
    return this.prisma.db.organization.findUnique({ where: { id: orgId }, select: RECORD })
  }

  /** The workspace that proved this domain, if any — what routes a sign-in by email. */
  findByVerifiedDomain(domain: string): Promise<OrgDomainRecord | null> {
    return this.prisma.db.organization.findFirst({ where: { domain, domainVerifiedAt: { not: null } }, select: RECORD })
  }

  /** Locks the row for the transaction: a claim, a proof and the requirement serialise here. */
  async lock(orgId: string): Promise<void> {
    await this.prisma.tx.$executeRaw`SELECT 1 FROM "Organization" WHERE id = ${orgId}::uuid FOR UPDATE`
  }

  /** A new claim, unproved; `null` removes the domain. Either way the old proof is gone, and joining by it with the proof. */
  async claim(orgId: string, domain: string | null, challenge: string | null): Promise<void> {
    await this.prisma.db.organization.update({ where: { id: orgId }, data: { domain, domainChallenge: challenge, domainVerifiedAt: null, allowDomainJoin: false } })
  }

  /** Joining by the proved domain on or off, and its role (TENANCY.md §5). A check constraint holds it to a proved domain. */
  async setDomainJoin(orgId: string, enabled: boolean, role: Role): Promise<void> {
    await this.prisma.db.organization.update({ where: { id: orgId }, data: { allowDomainJoin: enabled, defaultJoinRole: role } })
  }

  /**
   * Marks the claim proved, if it is still the claim that was checked.
   * `false` when the domain changed meanwhile; the partial unique index throws
   * when another workspace proved it first.
   */
  async markVerified(orgId: string, domain: string, challenge: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.db.organization.updateMany({
      // The challenge that was checked, not one a reclaim issued meanwhile (M13 review).
      where: { id: orgId, domain, domainChallenge: challenge, domainVerifiedAt: null },
      data: { domainVerifiedAt: at, domainChallenge: null },
    })
    return count === 1
  }

  async setRequireSso(orgId: string, required: boolean): Promise<void> {
    await this.prisma.db.organization.update({ where: { id: orgId }, data: { requireSso: required } })
  }
}
