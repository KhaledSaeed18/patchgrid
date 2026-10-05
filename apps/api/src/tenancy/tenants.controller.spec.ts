import type { INestApplication } from "@nestjs/common"
import { APP_FILTER, APP_PIPE } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { CLOCK, FixedClock } from "../common/clock/clock"
import { ProblemDetailsFilter } from "../common/problems/problem-details.filter"
import { ZodValidationPipe } from "../common/problems/zod-validation.pipe"
import type { OrganizationSummary } from "../platform/repositories/organization.repository"
import { ORGANIZATION_LOOKUP, type OrganizationLookup } from "./organization-lookup"
import { TenantLookupService } from "./tenant-lookup.service"
import { TenantsController } from "./tenants.controller"

const acme: OrganizationSummary = {
  id: "0190b2f0-0000-7000-8000-00000000000a",
  slug: "acme-corp",
  status: "ACTIVE",
  plan: "FREE",
  agentVisibility: "ALL_TICKETS",
}
const lookup: OrganizationLookup = {
  byId: async (id) => (id === acme.id ? acme : null),
  bySlug: async (slug) => (slug === acme.slug ? acme : null),
  orgIdForTokenPrefix: async () => null,
  retiredSlug: async (slug) => (slug === "acme" ? { orgId: acme.id } : null),
}

let app: INestApplication

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [TenantsController],
    providers: [
      TenantLookupService,
      { provide: ORGANIZATION_LOOKUP, useValue: lookup },
      { provide: CLOCK, useValue: new FixedClock(new Date("2026-10-05T12:00:00Z")) },
      // The real global pipe: it refuses a param that no schema declares.
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    ],
  }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  await app.init()
})

afterAll(async () => {
  await app.close()
})

describe("GET /tenants/:slug", () => {
  it("answers active and moved", async () => {
    const active = await request(app.getHttpServer()).get("/tenants/acme-corp")
    expect(active.status).toBe(200)
    expect(active.body).toEqual({ status: "active", slug: "acme-corp" })

    const moved = await request(app.getHttpServer()).get("/tenants/acme")
    expect(moved.body).toEqual({ status: "moved", slug: "acme", currentSlug: "acme-corp" })
  })

  it.each(["nobody", "api", "Not%20A%20Slug", "a".repeat(40)])(
    "is a 404 problem, never a 400, for %s",
    async (slug) => {
      const response = await request(app.getHttpServer()).get(`/tenants/${slug}`)
      expect(response.status).toBe(404)
      expect(response.body.type).toBe("https://patchgrid.xyz/problems/not-found")
    },
  )
})
