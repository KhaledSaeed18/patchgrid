import { Injectable } from "@nestjs/common"
import type { AgentVisibility, OrganizationStatus, Plan } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type OrganizationSettingsRecord = {
  id: string
  name: string
  slug: string
  status: OrganizationStatus
  plan: Plan
  domain: string | null
  agentVisibility: AgentVisibility
  emailNotificationsEnabled: boolean
  createdAt: Date
}

const RECORD = {
  id: true,
  name: true,
  slug: true,
  status: true,
  plan: true,
  domain: true,
  agentVisibility: true,
  emailNotificationsEnabled: true,
  createdAt: true,
} as const

/**
 * `Organization` and its slug history are platform class (ADR-0022), read and
 * written here by id. The picker's projection carries the name and slug, so
 * every change to either mirrors into it in the same transaction.
 */
@Injectable()
export class OrganizationSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(orgId: string): Promise<OrganizationSettingsRecord | null> {
    return this.prisma.db.organization.findUnique({ where: { id: orgId }, select: RECORD })
  }

  async update(
    orgId: string,
    data: { name?: string; agentVisibility?: AgentVisibility; emailNotificationsEnabled?: boolean },
  ): Promise<void> {
    await this.prisma.db.organization.update({ where: { id: orgId }, data })
  }

  /** When this organization last released a slug — the start of its cooldown. */
  async lastSlugRelease(orgId: string): Promise<Date | null> {
    const row = await this.prisma.db.organizationSlugHistory.findFirst({
      where: { orgId },
      orderBy: { releasedAt: "desc" },
      select: { releasedAt: true },
    })
    return row?.releasedAt ?? null
  }

  /** The old slug is kept forever — never reusable — and redirects until `redirectUntil`. */
  async retireSlug(orgId: string, slug: string, releasedAt: Date, redirectUntil: Date): Promise<void> {
    await this.prisma.db.organizationSlugHistory.create({ data: { orgId, slug, releasedAt, redirectUntil } })
  }

  async setSlug(orgId: string, slug: string): Promise<void> {
    await this.prisma.db.organization.update({ where: { id: orgId }, data: { slug } })
  }

  async mirrorToPicker(orgId: string, change: { orgSlug?: string; orgName?: string }): Promise<void> {
    await this.prisma.db.userOrgIndex.updateMany({ where: { orgId }, data: change })
  }
}
