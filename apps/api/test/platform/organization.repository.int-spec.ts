/**
 * The platform repositories against the live schema, as patchgrid_app, with
 * no tenant context at all — which is the point: `Organization`,
 * `OrganizationSlugHistory` and `ApiTokenIndex` are platform class
 * (ADR-0022) and must be readable before any tenant is known.
 */
import { Logger } from "@nestjs/common"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { ClsServiceManager } from "nestjs-cls"
import { randomUUID } from "node:crypto"
import path from "node:path"
import process from "node:process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { AppConfig } from "../../src/config/app-config"
import { ApiTokenIndexRepository } from "../../src/platform/repositories/api-token-index.repository"
import { OrganizationRepository } from "../../src/platform/repositories/organization.repository"
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

const cls = ClsServiceManager.getClsService<RequestContextStore>()
const suffix = randomUUID().slice(0, 8)
const slug = `acme-${suffix}`
const oldSlug = `acme-old-${suffix}`
const expiredSlug = `acme-gone-${suffix}`
const prefix = `tok${suffix}`

let owner: PrismaClient
let prisma: PrismaService
let organizations: OrganizationRepository
let tokens: ApiTokenIndexRepository
let orgId = ""

beforeAll(async () => {
  Logger.overrideLogger(false)
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const config = { DATABASE_URL: requireEnv("DATABASE_URL"), DATABASE_POOL_MAX: 1 } as AppConfig
  prisma = new PrismaService(config, cls, new TenantContextService(cls))
  await prisma.onModuleInit()
  organizations = new OrganizationRepository(prisma)
  tokens = new ApiTokenIndexRepository(prisma)

  const org = await owner.organization.create({
    data: { name: slug, slug, plan: "PRO", agentVisibility: "OWN_TEAM_ONLY" },
  })
  orgId = org.id
  const now = Date.now()
  await owner.organizationSlugHistory.createMany({
    data: [
      { orgId, slug: oldSlug, releasedAt: new Date(now - 86_400_000), redirectUntil: new Date(now + 29 * 86_400_000) },
      { orgId, slug: expiredSlug, releasedAt: new Date(now - 60 * 86_400_000), redirectUntil: new Date(now - 30 * 86_400_000) },
    ],
  })
  await owner.apiTokenIndex.createMany({
    data: [
      { prefix, orgId },
      { prefix: `${prefix}x`, orgId, revokedAt: new Date() },
    ],
  })
})

afterAll(async () => {
  if (orgId !== "") {
    await owner.apiTokenIndex.deleteMany({ where: { orgId } })
    await owner.organizationSlugHistory.deleteMany({ where: { orgId } })
    await owner.organization.delete({ where: { id: orgId } })
  }
  await Promise.all([owner.$disconnect(), prisma.onModuleDestroy()])
})

describe("OrganizationRepository, with no tenant context", () => {
  it("reads the summary by id and by slug", async () => {
    const expected = { id: orgId, slug, status: "ACTIVE", plan: "PRO", agentVisibility: "OWN_TEAM_ONLY" }
    expect(await organizations.findSummaryById(orgId)).toEqual(expected)
    expect(await organizations.findSummaryBySlug(slug)).toEqual(expected)
    expect(await organizations.findSummaryBySlug(`nobody-${suffix}`)).toBeNull()
  })

  it("reads a retired slug with its redirect window, whether open or closed", async () => {
    const open = await organizations.findRetiredSlug(oldSlug)
    expect(open?.orgId).toBe(orgId)
    expect(open?.redirectUntil.getTime()).toBeGreaterThan(Date.now())

    const closed = await organizations.findRetiredSlug(expiredSlug)
    expect(closed?.orgId).toBe(orgId)
    expect(closed?.redirectUntil.getTime()).toBeLessThan(Date.now())

    expect(await organizations.findRetiredSlug(slug)).toBeNull()
  })
})

describe("ApiTokenIndexRepository, with no tenant context", () => {
  it("maps a prefix to its org and reports revocation", async () => {
    expect(await tokens.findByPrefix(prefix)).toEqual({ orgId, revokedAt: null })
    expect((await tokens.findByPrefix(`${prefix}x`))?.revokedAt).toBeInstanceOf(Date)
    expect(await tokens.findByPrefix(`nope${suffix}`)).toBeNull()
  })
})
