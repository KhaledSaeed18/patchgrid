/**
 * Demo intake for the seed (FEATURES.md M6): a few of the requester's
 * incidents arrived by email, a reply threaded onto one, and the inbound log
 * holds what a desk's address really receives — a forged sender, a stranger,
 * an out-of-office. Rows only: the raw messages are not stored, so the log
 * shows them and nothing re-reads them.
 *
 * Seed-only, and deterministic relative to `now`.
 */
import type { PrismaClient } from "../src/index.ts"
import type { SeededOrg } from "../src/lookalikes.ts"

const MINUTE = 60_000

export async function seedDemoInbound(
  db: PrismaClient,
  org: SeededOrg,
  requester: { membershipId: string; email: string },
  now = new Date(),
): Promise<number> {
  const incidents = await db.ticket.findMany({
    // Not the lookalike incident, which arrived by email already.
    where: { orgId: org.id, type: "INCIDENT", requesterMembershipId: requester.membershipId, inboundEmails: { none: {} } },
    orderBy: { number: "asc" },
    take: 4,
    select: { id: true, title: true, createdAt: true },
  })
  await db.ticket.updateMany({ where: { orgId: org.id, id: { in: incidents.map((t) => t.id) } }, data: { source: "EMAIL" } })
  const key = (n: number) => `org/${org.id}/inbound/demo-${String(n)}.eml`
  const domain = requester.email.split("@").at(-1) ?? "patchgrid.test"
  const rows = [
    ...incidents.map((ticket, i) => ({
      orgId: org.id,
      messageKey: `<demo-${String(i)}@${domain}>`,
      fromAddress: requester.email,
      subject: ticket.title,
      authVerdict: "PASS" as const,
      outcome: "CREATED" as const,
      senderMembershipId: requester.membershipId,
      ticketId: ticket.id,
      rawStorageKey: key(i),
      receivedAt: ticket.createdAt,
      processedAt: ticket.createdAt,
    })),
    ...(incidents[0] === undefined
      ? []
      : [
          {
            orgId: org.id,
            messageKey: `<demo-reply@${domain}>`,
            fromAddress: requester.email,
            subject: `Re: ${incidents[0].title}`,
            authVerdict: "PASS" as const,
            outcome: "THREADED" as const,
            senderMembershipId: requester.membershipId,
            ticketId: incidents[0].id,
            rawStorageKey: key(10),
            receivedAt: new Date(now.getTime() - 50 * MINUTE),
            processedAt: new Date(now.getTime() - 50 * MINUTE),
          },
        ]),
    {
      orgId: org.id,
      messageKey: "<demo-forged@attacker.test>",
      fromAddress: "ceo@patchgrid.test",
      subject: "Urgent: approve this wire transfer today",
      authVerdict: "FAIL" as const,
      outcome: "UNAUTHENTICATED" as const,
      rawStorageKey: key(11),
      receivedAt: new Date(now.getTime() - 40 * MINUTE),
      processedAt: new Date(now.getTime() - 40 * MINUTE),
    },
    {
      orgId: org.id,
      messageKey: "<demo-stranger@contractor.test>",
      fromAddress: "jo@contractor.test",
      subject: "Badge for the server room?",
      authVerdict: "PASS" as const,
      outcome: "UNKNOWN_SENDER" as const,
      rawStorageKey: key(12),
      receivedAt: new Date(now.getTime() - 30 * MINUTE),
      processedAt: new Date(now.getTime() - 30 * MINUTE),
    },
    {
      orgId: org.id,
      messageKey: `<demo-ooo@${domain}>`,
      fromAddress: requester.email,
      subject: "Automatic reply: Out of office until Monday",
      authVerdict: "PASS" as const,
      outcome: "AUTO_REPLY" as const,
      error: "Auto-Submitted: auto-replied",
      rawStorageKey: key(13),
      receivedAt: new Date(now.getTime() - 20 * MINUTE),
      processedAt: new Date(now.getTime() - 20 * MINUTE),
    },
  ]
  await db.inboundEmail.createMany({ data: rows })
  return rows.length
}
