import { Injectable } from "@nestjs/common"
import type { AgentVisibility, OrganizationStatus, Plan } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

/**
 * What resolution and the request pipeline need to know about an organization.
 * Deliberately small: it is cached in Redis and handed to every request.
 */
export type OrganizationSummary = {
  id: string
  slug: string
  status: OrganizationStatus
  plan: Plan
  agentVisibility: AgentVisibility
}

export type RetiredSlug = {
  orgId: string
  /** 302 until here (ADR-0017); the reservation itself never lapses (TENANCY.md §2). */
  redirectUntil: Date
}

const SUMMARY = { id: true, slug: true, status: true, plan: true, agentVisibility: true } as const

/**
 * `Organization` is platform class (ADR-0022): no policy, reachable before a
 * tenant is known. That is the whole reason resolution can run at all.
 */
@Injectable()
export class OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  findSummaryById(id: string): Promise<OrganizationSummary | null> {
    return this.prisma.db.organization.findUnique({ where: { id }, select: SUMMARY })
  }

  findSummaryBySlug(slug: string): Promise<OrganizationSummary | null> {
    return this.prisma.db.organization.findUnique({ where: { slug }, select: SUMMARY })
  }

  findRetiredSlug(slug: string): Promise<RetiredSlug | null> {
    return this.prisma.db.organizationSlugHistory.findUnique({
      where: { slug },
      select: { orgId: true, redirectUntil: true },
    })
  }
}
