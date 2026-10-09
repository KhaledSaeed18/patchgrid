import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

/** Explicit watchers (RBAC.md §5); the requester and assignee watch implicitly and are never rows. */
@Injectable()
export class WatcherRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(orgId: string, ticketId: string): Promise<{ membershipId: string; displayName: string }[]> {
    return this.prisma.db.ticketWatcher
      .findMany({
        where: { orgId, ticketId },
        orderBy: { addedAt: "asc" },
        select: { membershipId: true, member: { select: { displayName: true } } },
      })
      .then((rows) => rows.map((r) => ({ membershipId: r.membershipId, displayName: r.member.displayName })))
  }

  /** `true` if this call added the watcher; adding twice is a no-op. */
  async add(orgId: string, ticketId: string, membershipId: string, addedBy: string): Promise<boolean> {
    const { count } = await this.prisma.db.ticketWatcher.createMany({
      data: [{ orgId, ticketId, membershipId, addedByMembershipId: addedBy }],
      skipDuplicates: true,
    })
    return count === 1
  }

  /** `true` if this call removed the watcher. */
  async remove(orgId: string, ticketId: string, membershipId: string): Promise<boolean> {
    const { count } = await this.prisma.db.ticketWatcher.deleteMany({ where: { orgId, ticketId, membershipId } })
    return count === 1
  }
}
