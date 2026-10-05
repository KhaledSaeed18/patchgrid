import { Controller, Get, type INestApplication, Post } from "@nestjs/common"
import { APP_FILTER, APP_GUARD } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import { ClsModule } from "nestjs-cls"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { FixedClock } from "../common/clock/clock"
import { Public, TenantOptional } from "../common/decorators/route-markers"
import { ProblemDetailsFilter } from "../common/problems/problem-details.filter"
import { APP_CONFIG, type AppConfig } from "../config/app-config"
import { MembershipRepository, type MembershipRecord } from "../memberships/repositories/membership.repository"
import type { OrganizationSummary } from "../platform/repositories/organization.repository"
import { ORGANIZATION_LOOKUP, type OrganizationLookup } from "../tenancy/organization-lookup"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { TenantResolutionGuard } from "../tenancy/tenant-resolution.guard"
import { TenantResolver } from "../tenancy/tenant-resolver"
import { ActorService } from "./actor"
import { AuthGuard } from "./auth.guard"
import { RequestedWithGuard } from "./requested-with.guard"
import { RevocationEpochService } from "./revocation/revocation-epoch.service"
import { SessionService } from "./sessions/session.service"
import { AccessTokenService } from "./tokens/access-token.service"

const config = {
  ROOT_DOMAIN: "lvh.me",
  WEB_ORIGIN_PORTS: [3000, 3001],
  isProduction: false,
  JWT_SECRET: "local-development-secret-that-is-at-least-32-chars",
  ACCESS_TOKEN_TTL_SECONDS: 900,
} as AppConfig

const acme: OrganizationSummary = { id: "0190b2f0-0000-7000-8000-00000000000a", slug: "acme", status: "ACTIVE", plan: "FREE", agentVisibility: "ALL_TICKETS" }
const globex: OrganizationSummary = { ...acme, id: "0190b2f0-0000-7000-8000-00000000000b", slug: "globex" }
const USER = "0190b2f0-0000-7000-8000-000000000001"
const MEM = "0190b2f0-0000-7000-8000-0000000000aa"

const lookup: OrganizationLookup = {
  byId: async (id) => [acme, globex].find((o) => o.id === id) ?? null,
  bySlug: async (slug) => [acme, globex].find((o) => o.slug === slug) ?? null,
  orgIdForTokenPrefix: async (prefix) => (prefix === "acmetok" ? acme.id : null),
  retiredSlug: async () => null,
}

const membership: MembershipRecord = {
  id: MEM,
  orgId: acme.id,
  userId: USER,
  role: "AGENT",
  status: "ACTIVE",
  kind: "HUMAN",
  displayName: "Agent",
  teamIds: ["t1", "t2"],
  leadOfTeamIds: ["t2"],
}
const memberships = { findById: vi.fn(async () => membership as MembershipRecord | null) }
const epochs = { isRevoked: vi.fn(async (): Promise<boolean | null> => false) }
const sessions = { identityFor: vi.fn(async (secret?: string) => (secret === "good-pg-id" ? USER : null)) }

@Controller("probe")
class ProbeController {
  constructor(private readonly actors: ActorService) {}

  @Get()
  read() {
    return this.actors.current() ?? null
  }

  @Post()
  write() {
    return { actor: this.actors.requireMember().membershipId }
  }

  @Get("picker")
  @TenantOptional()
  picker() {
    return this.actors.current() ?? null
  }

  @Get("open")
  @Public()
  open() {
    return { actor: this.actors.current() ?? null }
  }
}

let app: INestApplication
const clock = new FixedClock(new Date("2026-10-05T12:00:00Z"))
let accessTokens: AccessTokenService

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ClsModule.forRoot({ global: true, middleware: { mount: true, generateId: true } })],
    controllers: [ProbeController],
    providers: [
      TenantContextService,
      TenantResolver,
      ActorService,
      { provide: ORGANIZATION_LOOKUP, useValue: lookup },
      { provide: APP_CONFIG, useValue: config },
      { provide: AccessTokenService, useValue: new AccessTokenService(config, clock) },
      { provide: RevocationEpochService, useValue: epochs },
      { provide: SessionService, useValue: sessions },
      { provide: MembershipRepository, useValue: memberships },
      // The production order: resolve, CSRF, authenticate.
      { provide: APP_GUARD, useClass: TenantResolutionGuard },
      { provide: APP_GUARD, useClass: RequestedWithGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    ],
  }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  accessTokens = moduleRef.get(AccessTokenService)
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  clock.set(new Date("2026-10-05T12:00:00Z"))
  memberships.findById.mockResolvedValue(membership)
  epochs.isRevoked.mockResolvedValue(false)
})

const http = () => request(app.getHttpServer())
const signed = async (org = acme.id) => (await accessTokens.sign({ sub: USER, org, mem: MEM, role: "AGENT" })).token
const asAcme = async (token?: string) => ({
  Origin: "http://acme.lvh.me:3001",
  Cookie: `pg_at_acme=${token ?? (await signed())}`,
})

describe("AuthGuard over HTTP", () => {
  it("turns a valid access cookie into a member actor with fresh team facts", async () => {
    const response = await http().get("/probe").set(await asAcme())
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      kind: "member",
      userId: USER,
      orgId: acme.id,
      membershipId: MEM,
      role: "AGENT",
      teamIds: ["t1", "t2"],
      leadOfTeamIds: ["t2"],
    })
    expect(memberships.findById).toHaveBeenCalledWith(acme.id, MEM)
  })

  it("refuses an unsigned cookie that resolution accepted, and an expired one", async () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
    const forged = `${b64({ alg: "HS256" })}.${b64({ org: acme.id, sub: USER, mem: MEM })}.sig`
    expect((await http().get("/probe").set(await asAcme(forged))).status).toBe(401)

    const token = await signed()
    clock.advance(901_000)
    expect((await http().get("/probe").set(await asAcme(token))).status).toBe(401)
  })

  it("refuses a token for another org under this cookie name", async () => {
    const response = await http().get("/probe").set(await asAcme(await signed(globex.id)))
    expect(response.status).toBe(403)
    expect(response.body.type).toContain("tenant-mismatch")
  })

  it("enforces the revocation epoch, and fails open for reads but closed for writes without it", async () => {
    const headers = { ...(await asAcme()), "X-Requested-With": "patchgrid" }
    epochs.isRevoked.mockResolvedValue(true)
    expect((await http().get("/probe").set(headers)).status).toBe(401)

    epochs.isRevoked.mockResolvedValue(null)
    expect((await http().get("/probe").set(headers)).status).toBe(200)
    const write = await http().post("/probe").set(headers)
    expect(write.status).toBe(503)
    expect(write.body.type).toContain("service-unavailable")
  })

  it("refuses when the membership is gone, disabled, or belongs to someone else", async () => {
    memberships.findById.mockResolvedValueOnce(null)
    expect((await http().get("/probe").set(await asAcme())).status).toBe(401)
    memberships.findById.mockResolvedValueOnce({ ...membership, status: "DISABLED" })
    expect((await http().get("/probe").set(await asAcme())).status).toBe(401)
    memberships.findById.mockResolvedValueOnce({ ...membership, userId: "0190b2f0-0000-7000-8000-000000000002" })
    expect((await http().get("/probe").set(await asAcme())).status).toBe(401)
  })

  it("requires X-Requested-With on cookie-borne mutations, even with a valid session", async () => {
    const headers = await asAcme()
    expect((await http().post("/probe").set(headers)).status).toBe(403)
    const ok = await http().post("/probe").set({ ...headers, "X-Requested-With": "patchgrid" })
    expect(ok.status).toBe(201)
    expect(ok.body).toEqual({ actor: MEM })
  })

  it("authenticates tenant-optional routes by pg_id alone", async () => {
    expect((await http().get("/probe/picker")).status).toBe(401)
    const picker = await http().get("/probe/picker").set("Cookie", "pg_id=good-pg-id")
    expect(picker.body).toEqual({ kind: "identity", userId: USER })
  })

  it("leaves public routes without an actor and lets resolution answer first", async () => {
    expect((await http().get("/probe/open")).body).toEqual({ actor: null })
    // Unknown workspace: resolution's 404, not auth's 401.
    expect((await http().get("/probe").set("Origin", "http://nobody.lvh.me:3001")).status).toBe(404)
    // A resolving API token is not yet an actor (M8).
    expect((await http().get("/probe").set("Authorization", "Bearer pg_acmetok_s")).status).toBe(401)
  })
})
