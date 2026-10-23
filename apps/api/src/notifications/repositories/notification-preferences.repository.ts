import { Injectable } from "@nestjs/common"
import { type EmailPrefs, emailPrefsSchema } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

/**
 * A member's email choices (`Membership.emailPrefs`) and the workspace's
 * kill switch beside them. Tenant-owned; every method takes the org and the
 * membership, and a member only ever reads and writes their own.
 */
@Injectable()
export class NotificationPreferencesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async read(orgId: string, membershipId: string): Promise<{ prefs: EmailPrefs; orgEnabled: boolean } | null> {
    return this.prisma.transaction(async () => {
      const membership = await this.prisma.db.membership.findUnique({
        where: { orgId_id: { orgId, id: membershipId } },
        select: { emailPrefs: true },
      })
      const org = await this.prisma.db.organization.findUnique({ where: { id: orgId }, select: { emailNotificationsEnabled: true } })
      if (membership === null || org === null) return null
      return { prefs: emailPrefsSchema.catch({}).parse(membership.emailPrefs), orgEnabled: org.emailNotificationsEnabled }
    })
  }

  /**
   * Merges the given choices into the stored ones in one statement, so two
   * tabs saving different types at once both land. Raw SQL because Prisma
   * cannot express `jsonb || jsonb` — so inside `transaction()`, where the
   * tenant setting is applied. Returns the stored choices after the merge,
   * and the kill switch, as `read` does — in the same transaction.
   */
  async merge(orgId: string, membershipId: string, patch: EmailPrefs): Promise<{ prefs: EmailPrefs; orgEnabled: boolean } | null> {
    return this.prisma.transaction(async () => {
      const [row] = await this.prisma.tx.$queryRaw<{ emailPrefs: unknown }[]>`
        UPDATE "Membership"
        SET "emailPrefs" = "emailPrefs" || ${JSON.stringify(patch)}::jsonb
        WHERE "orgId" = ${orgId}::uuid AND "id" = ${membershipId}::uuid
        RETURNING "emailPrefs"
      `
      if (row === undefined) return null
      const org = await this.prisma.db.organization.findUnique({ where: { id: orgId }, select: { emailNotificationsEnabled: true } })
      if (org === null) return null
      return { prefs: emailPrefsSchema.catch({}).parse(row.emailPrefs), orgEnabled: org.emailNotificationsEnabled }
    })
  }
}
