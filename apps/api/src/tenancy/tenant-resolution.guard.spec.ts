import { Controller, Get, type INestApplication } from "@nestjs/common"
import { APP_FILTER, APP_GUARD } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import { ClsModule } from "nestjs-cls"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Public, TenantOptional } from "../common/decorators/route-markers"
import { ProblemDetailsFilter } from "../common/problems/problem-details.filter"
import { APP_CONFIG, type AppConfig } from "../config/app-config"
import type { OrganizationSummary } from "../platform/repositories/organization.repository"
import { ORGANIZATION_LOOKUP, type OrganizationLookup } from "./organization-lookup"
import { TenantContextService } from "./tenant-context.service"
import { TenantResolutionGuard } from "./tenant-resolution.guard"
import { TenantResolver } from "./tenant-resolver"

const acme: OrganizationSummary = {
  id: "0190b2f0-0000-7000-8000-00000000000a",
  slug: "acme",
  status: "ACTIVE",
  plan: "PRO",
  agentVisibility: "OWN_TEAM_ONLY",
}
const frozen: OrganizationSummary = { ...acme, id: "0190b2f0-0000-7000-8000-00000000000f", slug: "frozen", status: "SUSPENDED" }
const ORGS = [acme, frozen]

const lookup: OrganizationLookup = {
  byId: async (id) => ORGS.find((o) => o.id === id) ?? null,
  bySlug: async (slug) => ORGS.find((o) => o.slug === slug) ?? null,
  orgIdForTokenPrefix: async (prefix) => (prefix === "acmetok" ? acme.id : null),
  retiredSlug: async () => null,
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const cookieFor = (slug: string, orgId: string) => `pg_at_${slug}=${b64({ alg: "HS256" })}.${b64({ org: orgId })}.sig`

/** What a handler sees after the guard ran. */
@Controller("probe")
class ProbeController {
  constructor(private readonly tenant: TenantContextService) {}

  @Get()
  bound() {
    return { orgId: this.tenant.current()?.orgId ?? null, slug: this.tenant.organization()?.slug ?? null }
  }

  @Get("public")
  @Public()
  open() {
    return { orgId: this.tenant.current()?.orgId ?? null }
  }

  @Get("optional")
  @TenantOptional()
  optional() {
    return { orgId: this.tenant.current()?.orgId ?? null }
  }
}

let app: INestApplication

beforeAll(async () => {
  const config = { ROOT_DOMAIN: "lvh.me", WEB_ORIGIN_PORTS: [3000, 3001], isProduction: false } as AppConfig
  const moduleRef = await Test.createTestingModule({
    imports: [ClsModule.forRoot({ global: true, middleware: { mount: true, generateId: true } })],
    controllers: [ProbeController],
    providers: [
      TenantContextService,
      TenantResolver,
      { provide: ORGANIZATION_LOOKUP, useValue: lookup },
      { provide: APP_CONFIG, useValue: config },
      { provide: APP_GUARD, useClass: TenantResolutionGuard },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    ],
  }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  await app.init()
})

afterAll(async () => {
  await app.close()
})

const http = () => request(app.getHttpServer())

describe("TenantResolutionGuard over HTTP", () => {
  it("writes the tenant into the context for a tenant-bound route", async () => {
    const response = await http()
      .get("/probe")
      .set("Origin", "http://acme.lvh.me:3001")
      .set("Cookie", cookieFor("acme", acme.id))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ orgId: acme.id, slug: "acme" })
  })

  it("accepts the server-side assertion header in place of Origin", async () => {
    const response = await http()
      .get("/probe")
      .set("X-Patchgrid-Tenant", "acme")
      .set("Cookie", cookieFor("acme", acme.id))
    expect(response.status).toBe(200)
    expect(response.body.orgId).toBe(acme.id)
  })

  it("accepts a bearer token with no cookies or Origin at all", async () => {
    const response = await http().get("/probe").set("Authorization", "Bearer pg_acmetok_secret")
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ orgId: acme.id, slug: "acme" })
  })

  it("skips public and tenant-optional routes, leaving no tenant in the context", async () => {
    expect((await http().get("/probe/public")).body).toEqual({ orgId: null })
    expect((await http().get("/probe/optional")).body).toEqual({ orgId: null })
  })

  it.each([
    ["an unknown workspace", { Origin: "http://nobody.lvh.me:3001" }, 404, "not-found"],
    ["no session on a known workspace", { Origin: "http://acme.lvh.me:3001" }, 401, "not-authenticated"],
    ["a cookie for another workspace", { Origin: "http://acme.lvh.me:3001", Cookie: cookieFor("acme", frozen.id) }, 403, "tenant-mismatch"],
    ["a suspended workspace", { Origin: "http://frozen.lvh.me:3001", Cookie: cookieFor("frozen", frozen.id) }, 403, "organization-suspended"],
    ["a token used on another workspace", { Origin: "http://frozen.lvh.me:3001", Authorization: "Bearer pg_acmetok_s" }, 403, "tenant-mismatch"],
    ["a foreign Origin", { Origin: "https://evil.example", Cookie: cookieFor("acme", acme.id) }, 403, "tenant-mismatch"],
    ["nothing naming a workspace", { Cookie: cookieFor("acme", acme.id) }, 403, "tenant-mismatch"],
    ["an unknown token", { Authorization: "Bearer pg_nope_s" }, 401, "not-authenticated"],
  ])("refuses %s as Problem Details", async (_label, headers, status, type) => {
    const response = await http().get("/probe").set(headers)
    expect(response.status).toBe(status)
    expect(response.headers["content-type"]).toContain("application/problem+json")
    expect(response.body.type).toBe(`https://patchgrid.xyz/problems/${type}`)
    expect(response.body.status).toBe(status)
  })
})
