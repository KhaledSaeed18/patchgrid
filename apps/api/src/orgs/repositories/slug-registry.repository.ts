import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

/**
 * The one definition of "is this slug free?" (TENANCY.md §2). A slug in use
 * now, or released at any time in the past, is taken — and uniqueness spans
 * two tables, so no constraint can hold it. Provisioning and slug change both
 * decide it under a transaction-scoped advisory lock on the slug, so two
 * claimants of one slug serialise and the second sees the first's commit.
 */
@Injectable()
export class SlugRegistryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inside `transaction()`; released when it ends. Several slugs are locked in
   * a fixed order, so two changes touching the same pair cannot deadlock.
   */
  async lock(...slugs: string[]): Promise<void> {
    for (const slug of [...new Set(slugs)].toSorted()) {
      await this.prisma.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`slug:${slug}`}))`
    }
  }

  async isTaken(slug: string): Promise<boolean> {
    const [current, retired] = await Promise.all([
      this.prisma.db.organization.findUnique({ where: { slug }, select: { id: true } }),
      this.prisma.db.organizationSlugHistory.findUnique({ where: { slug }, select: { id: true } }),
    ])
    return current !== null || retired !== null
  }
}
