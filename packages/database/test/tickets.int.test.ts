/**
 * The ticket tables' constraints, against the live schema as the owner (who
 * bypasses RLS, so only the constraints themselves are under test): the
 * services hold these rules readably; the database holds them unforgettably.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import process from "node:process"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createPrismaClient, type PrismaClient } from "../src/index.ts"

try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../../.env"))
} catch {
  // variables come from the environment
}

const url = process.env.DATABASE_MIGRATION_URL
if (url === undefined || url === "") throw new Error("DATABASE_MIGRATION_URL is required")

let db: PrismaClient
const suffix = randomUUID().slice(0, 8)
const orgs = { acme: "", globex: "" }
let requester = ""
let globexCategory = ""

const ticket = (over: Record<string, unknown> = {}) => ({
  orgId: orgs.acme,
  number: Math.floor(Math.random() * 1e9) + 1,
  type: "INCIDENT" as const,
  title: "Printer on fire",
  description: "Third floor",
  impact: "HIGH" as const,
  urgency: "HIGH" as const,
  priority: "CRITICAL" as const,
  requesterMembershipId: requester,
  responseClockStartedAt: new Date(),
  resolutionClockStartedAt: new Date(),
  source: "PORTAL" as const,
  ...over,
})

beforeAll(async () => {
  db = createPrismaClient({ connectionString: url })
  for (const name of ["acme", "globex"] as const) {
    orgs[name] = (await db.organization.create({ data: { name, slug: `${name}-t-${suffix}` } })).id
  }
  const user = await db.user.create({ data: { email: `req-${suffix}@probe.test`, name: "R" } })
  requester = (await db.membership.create({ data: { orgId: orgs.acme, userId: user.id, role: "REQUESTER", displayName: "R" } })).id
  globexCategory = (await db.category.create({ data: { orgId: orgs.globex, name: "Hardware", depth: 1 } })).id
})

afterAll(async () => {
  const orgIds = Object.values(orgs)
  await db.ticket.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.category.deleteMany({ where: { orgId: { in: orgIds }, parentId: { not: null } } })
  await db.category.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.sLAPolicy.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.membership.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.user.deleteMany({ where: { email: `req-${suffix}@probe.test` } })
  await db.organization.deleteMany({ where: { id: { in: orgIds } } })
  await db.$disconnect()
})

describe("ticket constraints", () => {
  it("accept a well-formed incident", async () => {
    await expect(db.ticket.create({ data: ticket() })).resolves.toMatchObject({ status: "NEW", version: 1 })
  })

  it("refuse a priority the matrix would not give", async () => {
    await expect(db.ticket.create({ data: ticket({ priority: "LOW" }) })).rejects.toThrow(/Ticket_priority_matrix_check/)
  })

  it("refuse a status the type does not have", async () => {
    await expect(db.ticket.create({ data: ticket({ status: "KNOWN_ERROR" }) })).rejects.toThrow(/Ticket_type_status_check/)
    await expect(db.ticket.create({ data: ticket({ type: "CHANGE", status: "NEW" }) })).rejects.toThrow(/Ticket_type_status_check/)
  })

  it("refuse another tenant's category — the composite key cannot express it", async () => {
    await expect(db.ticket.create({ data: ticket({ categoryId: globexCategory }) })).rejects.toThrow(/foreign key/i)
  })
})

describe("category and SLA constraints", () => {
  it("hold the tree to three levels, depth meaning how many parents", async () => {
    await expect(db.category.create({ data: { orgId: orgs.acme, name: "Orphan", depth: 2 } })).rejects.toThrow(/Category_depth_check/)
    const root = await db.category.create({ data: { orgId: orgs.acme, name: "Software", depth: 1 } })
    await expect(db.category.create({ data: { orgId: orgs.acme, name: "Too deep", depth: 4, parentId: root.id } })).rejects.toThrow(
      /Category_depth_check/
    )
  })

  it("keep names unique per parent, and among top-level categories", async () => {
    const a = await db.category.create({ data: { orgId: orgs.acme, name: `Hardware ${suffix}`, depth: 1 } })
    const b = await db.category.create({ data: { orgId: orgs.acme, name: `Network ${suffix}`, depth: 1 } })
    await db.category.create({ data: { orgId: orgs.acme, name: "Other", depth: 2, parentId: a.id } })
    await expect(db.category.create({ data: { orgId: orgs.acme, name: "Other", depth: 2, parentId: b.id } })).resolves.toBeDefined()
    await expect(db.category.create({ data: { orgId: orgs.acme, name: "Other", depth: 2, parentId: a.id } })).rejects.toThrow()
    await expect(db.category.create({ data: { orgId: orgs.acme, name: `Hardware ${suffix}`, depth: 1 } })).rejects.toThrow()
  })

  it("allow policies only for the clocked types, with warnings inside their targets", async () => {
    const base = { orgId: orgs.acme, priority: "HIGH" as const, responseTargetMinutes: 30, resolutionTargetMinutes: 480, responseWarningMinutes: 10, resolutionWarningMinutes: 60 }
    await expect(db.sLAPolicy.create({ data: { ...base, ticketType: "PROBLEM" } })).rejects.toThrow(/SLAPolicy_type_check/)
    await expect(db.sLAPolicy.create({ data: { ...base, ticketType: "INCIDENT", responseWarningMinutes: 30 } })).rejects.toThrow(
      /SLAPolicy_targets_check/
    )
    await expect(db.sLAPolicy.create({ data: { ...base, ticketType: "INCIDENT" } })).resolves.toBeDefined()
  })
})
