import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../../prisma/prisma.service"

export type DispatchableOrg = { id: string; plan: "FREE" | "PRO" }

/**
 * The dispatcher's one cross-tenant read (ADR-0018): which organizations get
 * background work. `Organization` is platform-class, so this runs with no
 * tenant context; a suspended or pending-deletion workspace is skipped, so no
 * sweep touches dormant data.
 */
@Injectable()
export class DispatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listDispatchable(): Promise<DispatchableOrg[]> {
    return this.prisma.db.organization.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, plan: true },
      orderBy: { id: "asc" },
    })
  }
}
