/**
 * The M9 load check (FEATURES.md): one workspace with a hundred thousand
 * tickets, so the scope-filter UNION ALL and the keyset cursors can be timed
 * against something that resembles a busy tenant rather than a demo.
 *
 *   pnpm --filter @patchgrid/database run load:tickets -- --slug acme --count 100000
 *
 * Idempotent in effect: it adds `count` tickets each run, numbered from the
 * counter, spread over the last two years, across the workspace's teams and
 * people. No SLA policy is attached — the point is the list queries, not a
 * hundred thousand clocks for the sweep to flag. Remove them with --remove.
 */
import { computePriority } from "@patchgrid/contracts"

import { createPrismaClient, type Prisma } from "../src/index.ts"

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (key?.startsWith("--") === true) {
    const value = process.argv[i + 1]
    if (value === undefined || value.startsWith("--")) args.set(key.slice(2), "true")
    else {
      args.set(key.slice(2), value)
      i += 1
    }
  }
}
const slug = args.get("slug") ?? "acme"
const count = Number(args.get("count") ?? 100_000)
const remove = args.get("remove") === "true"
const LOAD_TAG = "[load]"

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL
  if (url === undefined) throw new Error("DATABASE_MIGRATION_URL is required (the owner role writes without a tenant context)")
  const db = createPrismaClient({ connectionString: url })
  const org = await db.organization.findUniqueOrThrow({ where: { slug }, select: { id: true } })

  if (remove) {
    const gone = await db.ticket.deleteMany({ where: { orgId: org.id, title: { startsWith: LOAD_TAG } } })
    console.log(`removed ${String(gone.count)} load tickets from ${slug}`)
    await db.$disconnect()
    return
  }

  const members = await db.membership.findMany({
    where: { orgId: org.id, status: "ACTIVE", kind: "HUMAN" },
    select: { id: true, role: true },
  })
  const teams = await db.team.findMany({ where: { orgId: org.id }, select: { id: true } })
  const categories = await db.category.findMany({ where: { orgId: org.id }, select: { id: true } })
  const requesters = members.map((m) => m.id)
  const agents = members.filter((m) => m.role !== "REQUESTER").map((m) => m.id)
  if (requesters.length === 0 || agents.length === 0) throw new Error(`${slug} needs members to raise and work tickets`)

  const counter = await db.ticketCounter.upsert({
    where: { orgId_type: { orgId: org.id, type: "INCIDENT" } },
    create: { orgId: org.id, type: "INCIDENT", nextValue: 1 },
    update: {},
  })
  const statuses = ["NEW", "ASSIGNED", "IN_PROGRESS", "PENDING", "RESOLVED", "CLOSED", "CLOSED", "CLOSED", "CANCELLED"] as const
  const levels = ["LOW", "MEDIUM", "HIGH"] as const
  const next = rng(count)
  const now = Date.now()
  const span = 2 * 365 * 24 * 60 * 60_000
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T

  const BATCH = 5_000
  const started = Date.now()
  const number = counter.nextValue
  for (let offset = 0; offset < count; offset += BATCH) {
    const rows: Prisma.TicketCreateManyInput[] = []
    for (let i = offset; i < Math.min(count, offset + BATCH); i += 1) {
      const createdAt = new Date(now - Math.floor(next() * span))
      const status = pick(statuses)
      const impact = pick(levels)
      const urgency = pick(levels)
      const open = status === "NEW"
      const resolvedAt = status === "RESOLVED" || status === "CLOSED" ? new Date(createdAt.getTime() + 3_600_000) : null
      rows.push({
        orgId: org.id,
        number: number + i,
        type: "INCIDENT",
        title: `${LOAD_TAG} Ticket ${String(number + i)}`,
        description: "Generated for the load check; carries no meaning.",
        status,
        impact,
        urgency,
        // The matrix the database checks (DOMAIN.md §3): never a value the API would refuse.
        priority: computePriority(impact, urgency),
        source: "PORTAL",
        categoryId: categories.length > 0 && next() < 0.8 ? pick(categories).id : null,
        requesterMembershipId: pick(requesters),
        assigneeMembershipId: open ? null : pick(agents),
        teamId: teams.length > 0 && (!open || next() < 0.5) ? pick(teams).id : null,
        responseClockStartedAt: createdAt,
        resolutionClockStartedAt: createdAt,
        respondedAt: open ? null : new Date(createdAt.getTime() + 600_000),
        resolvedAt,
        closedAt: status === "CLOSED" && resolvedAt !== null ? new Date(resolvedAt.getTime() + 60_000) : null,
        cancelledAt: status === "CANCELLED" ? new Date(createdAt.getTime() + 1_800_000) : null,
        createdAt,
        updatedAt: resolvedAt ?? createdAt,
      })
    }
    await db.ticket.createMany({ data: rows })
    process.stdout.write(`\r${String(Math.min(count, offset + BATCH))} / ${String(count)}`)
  }
  await db.ticketCounter.update({ where: { orgId_type: { orgId: org.id, type: "INCIDENT" } }, data: { nextValue: number + count } })
  const total = await db.ticket.count({ where: { orgId: org.id } })
  console.log(
    `\n${slug} now holds ${String(total)} tickets (${String(count)} added in ${String(Math.round((Date.now() - started) / 1000))}s)`,
  )
  await db.$disconnect()
}

void main()
