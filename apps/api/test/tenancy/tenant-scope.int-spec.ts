/**
 * Isolation layers 1 and 3 as the API wires them, with RLS (layer 4) live
 * underneath: the request context, PrismaService.db / transaction(), and the
 * two crossing helpers — against a real database, as patchgrid_app.
 *
 * Two organizations get a team with the SAME name, so a leak is visible rather
 * than plausible (TENANCY.md §10). Rows are seeded and removed through the
 * owner role, which holds BYPASSRLS.
 */
import { Logger } from "@nestjs/common"
import { createPrismaClient, NoTenantContextError, type PrismaClient } from "@patchgrid/database"
import { ClsServiceManager } from "nestjs-cls"
import { randomUUID } from "node:crypto"
import path from "node:path"
import process from "node:process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { AppConfig } from "../../src/config/app-config"
import { runAsPlatform } from "../../src/platform/run-as-platform"
import { runAsTenant } from "../../src/platform/run-as-tenant"
import { PrismaService } from "../../src/prisma/prisma.service"
import type { RequestContextStore } from "../../src/tenancy/request-context"
import { TenantContextService } from "../../src/tenancy/tenant-context.service"

try {
  process.loadEnvFile(path.join(__dirname, "../../../../.env"))
} catch {
  // variables come from the environment
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}

// Identity checks are written as `a === b` booleans: on failure, vitest would
// otherwise try to pretty-print a Prisma client proxy and throw from its
// ownKeys trap instead of reporting the mismatch.
const crossing = { actor: "test:tenant-scope", reason: "integration spec" }
const cls = ClsServiceManager.getClsService<RequestContextStore>()

let owner: PrismaClient
let prisma: PrismaService

const suffix = randomUUID().slice(0, 8)
const acme = { id: "", slug: `acme-${suffix}` }
const globex = { id: "", slug: `globex-${suffix}` }

beforeAll(async () => {
  Logger.overrideLogger(false)
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })

  // Three connections, not one: a transaction holds one for its duration, and a
  // crossing made inside it needs another (see "inside an open transaction").
  const config = {
    DATABASE_URL: requireEnv("DATABASE_URL"),
    DATABASE_POOL_MAX: 3,
  } as AppConfig
  prisma = new PrismaService(config, cls, new TenantContextService(cls))
  await prisma.onModuleInit()

  for (const org of [acme, globex]) {
    const created = await owner.organization.create({ data: { name: org.slug, slug: org.slug } })
    org.id = created.id
    await owner.team.create({ data: { orgId: created.id, name: "IT Support" } })
  }
})

afterAll(async () => {
  const orgIds = [acme.id, globex.id].filter((id) => id !== "")
  await owner.team.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.organization.deleteMany({ where: { id: { in: orgIds } } })
  await Promise.all([owner.$disconnect(), prisma.onModuleDestroy()])
})

const teamOrgs = async () => (await prisma.db.team.findMany()).map((t) => t.orgId)

describe("PrismaService.db outside any tenant", () => {
  it("throws for a tenant-owned model rather than running unscoped", async () => {
    await expect(prisma.db.team.findMany()).rejects.toBeInstanceOf(NoTenantContextError)
  })

  it("reaches platform-class models", async () => {
    const orgs = await prisma.db.organization.findMany({
      where: { id: { in: [acme.id, globex.id] } },
    })
    expect(orgs).toHaveLength(2)
  })
})

describe("runAsTenant", () => {
  it("scopes every query in the callback to that org, with no where clause", async () => {
    expect(await runAsTenant(acme.id, crossing, teamOrgs)).toEqual([acme.id])
    expect(await runAsTenant(globex.id, crossing, teamOrgs)).toEqual([globex.id])
  })

  it("lets RLS refuse a write into another tenant", async () => {
    await expect(
      runAsTenant(acme.id, crossing, () =>
        prisma.db.team.create({ data: { orgId: globex.id, name: "Planted" } }),
      ),
    ).rejects.toThrow(/row-level security/)
  })
})

describe("runAsPlatform", () => {
  it("cannot reach tenant-owned models even from inside a tenant", async () => {
    await runAsTenant(acme.id, crossing, async () => {
      await expect(runAsPlatform(crossing, teamOrgs)).rejects.toBeInstanceOf(NoTenantContextError)
      expect(await teamOrgs()).toEqual([acme.id])
    })
  })
})

describe("PrismaService.transaction", () => {
  it("hands db the transaction client, and rolls everything back on throw", async () => {
    const outcome = runAsTenant(acme.id, crossing, () =>
      prisma.transaction(async (tx) => {
        expect(prisma.db === tx).toBe(true)
        await prisma.db.team.create({ data: { orgId: acme.id, name: `Network ${suffix}` } })
        expect(await teamOrgs()).toHaveLength(2)
        throw new Error("roll it back")
      }),
    )
    await expect(outcome).rejects.toThrow("roll it back")
    expect(await runAsTenant(acme.id, crossing, teamOrgs)).toHaveLength(1)
  })

  it("commits, and the committed rows are only visible to their tenant", async () => {
    await runAsTenant(acme.id, crossing, () =>
      prisma.transaction(async () => {
        await prisma.db.team.create({ data: { orgId: acme.id, name: `Security ${suffix}` } })
      }),
    )
    expect(await runAsTenant(acme.id, crossing, teamOrgs)).toHaveLength(2)
    expect(await runAsTenant(globex.id, crossing, teamOrgs)).toHaveLength(1)
    await owner.team.deleteMany({ where: { orgId: acme.id, name: `Security ${suffix}` } })
  })

  it("joins an open transaction instead of nesting one", async () => {
    await runAsTenant(acme.id, crossing, () =>
      prisma.transaction(async (outer) => {
        await prisma.transaction(async (inner) => {
          expect(inner === outer).toBe(true)
          expect(prisma.db === outer).toBe(true)
        })
      }),
    )
  })

  it("refuses a foreign orgId inside the transaction and rolls it back", async () => {
    const outcome = runAsTenant(acme.id, crossing, () =>
      prisma.transaction(async () => {
        await prisma.db.team.create({ data: { orgId: acme.id, name: `Legit ${suffix}` } })
        await prisma.db.team.create({ data: { orgId: globex.id, name: `Planted ${suffix}` } })
      }),
    )
    await expect(outcome).rejects.toThrow(/row-level security/)
    expect(await runAsTenant(acme.id, crossing, teamOrgs)).toHaveLength(1)
    expect(await owner.team.count({ where: { name: { in: [`Legit ${suffix}`, `Planted ${suffix}`] } } })).toBe(0)
  })

  it("runs platform-only with no tenant, and still throws for tenant-owned models inside", async () => {
    await prisma.transaction(async (tx) => {
      expect(prisma.db === tx).toBe(true)
      const org = await prisma.db.organization.findUnique({ where: { id: acme.id } })
      expect(org?.slug).toBe(acme.slug)
      await expect(prisma.db.team.findMany()).rejects.toBeInstanceOf(NoTenantContextError)
    })
  })
})

describe("crossing inside an open transaction", () => {
  it("runs the other tenant outside the transaction, scoped to that tenant", async () => {
    await runAsTenant(acme.id, crossing, () =>
      prisma.transaction(async (acmeTx) => {
        await prisma.db.team.create({ data: { orgId: acme.id, name: `Uncommitted ${suffix}` } })

        await runAsTenant(globex.id, crossing, async () => {
          expect(prisma.db === acmeTx).toBe(false)
          expect(await teamOrgs()).toEqual([globex.id])
        })

        // Back in acme's transaction, uncommitted work is still visible.
        expect(prisma.db === acmeTx).toBe(true)
        expect(await teamOrgs()).toHaveLength(2)
        throw new Error("discard")
      }),
    ).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "discard") throw error
    })
  })

  it("does not let the setting outlive its transaction on the pool", async () => {
    await runAsTenant(acme.id, crossing, () => prisma.transaction(teamOrgs))
    // Straight past the extension on the same pool: no context, no tenant.
    await expect(prisma.db.team.findMany()).rejects.toBeInstanceOf(NoTenantContextError)
    const [row] = await prisma.db.$queryRaw<{ org: string | null }[]>`
      SELECT current_setting('app.current_org_id', true) AS org`
    expect(row?.org ?? "").toBe("")
  })
})
