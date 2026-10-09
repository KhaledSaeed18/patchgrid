/**
 * Workspace creation through the booted AppModule: the live slug check, the
 * provisioning transaction under RLS, the session it opens, and the slug race —
 * two creators, one slug, exactly one workspace.
 */
import { requireEnv } from "../support/env"

import { Controller, Get, type INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { ActorService } from "../../src/auth/actor"
import { AuthModule } from "../../src/auth/auth.module"
import { PasswordService } from "../../src/auth/passwords/password.service"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"

@Controller("probe")
class ProbeController {
  constructor(private readonly actors: ActorService) {}

  @Get()
  read() {
    return this.actors.current() ?? null
  }
}

const suffix = randomUUID().slice(0, 8)
const email = `founder-${suffix}@probe.test`
const password = "correct horse battery staple"
const slug = `acme-${suffix}`
const racedSlug = `race-${suffix}`
const retiredSlug = `old-${suffix}`
const HEADERS = { "Content-Type": "application/json", "X-Requested-With": "patchgrid" }

let owner: PrismaClient
let app: INestApplication
let userId = ""
let pgId = ""
let retiredOwnerId = ""

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, AuthModule], controllers: [ProbeController] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  // Listening on an ephemeral port: supertest then reuses it, rather than binding and closing
  // the shared server per request, which breaks requests made concurrently.
  await app.listen(0)

  const passwordHash = await app.get(PasswordService).hash(password)
  const user = await owner.user.create({ data: { email, name: "Founder", passwordHash, emailVerifiedAt: new Date() } })
  userId = user.id

  // A workspace that once used `retiredSlug`: the slug must stay unavailable forever.
  const former = await owner.organization.create({ data: { name: "Former", slug: `former-${suffix}` } })
  retiredOwnerId = former.id
  await owner.organizationSlugHistory.create({
    data: { orgId: former.id, slug: retiredSlug, releasedAt: new Date(Date.now() - 86_400_000 * 40), redirectUntil: new Date(Date.now() - 86_400_000 * 10) },
  })

  const login = await request(app.getHttpServer()).post("/api/v1/auth/login").set(HEADERS).send({ email, password })
  pgId = (login.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("pg_id="))?.split(";")[0] ?? ""
})

afterAll(async () => {
  const orgIds = (await owner.organization.findMany({ where: { slug: { in: [slug, racedSlug, `former-${suffix}`] } }, select: { id: true } })).map((o) => o.id)
  await owner.team.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.usageCounter.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.refreshToken.deleteMany({ where: { userId } })
  await owner.userOrgIndex.deleteMany({ where: { userId } })
  await owner.membership.deleteMany({ where: { userId } })
  await owner.organizationSlugHistory.deleteMany({ where: { orgId: retiredOwnerId } })
  await owner.organization.deleteMany({ where: { id: { in: orgIds } } })
  await owner.user.delete({ where: { id: userId } })
  await app.close()
  await owner.$disconnect()
})

const http = () => request(app.getHttpServer())
const create = (body: object) => http().post("/api/v1/orgs").set(HEADERS).set("Cookie", pgId).send(body)

describe("workspace provisioning", () => {
  it("answers the live slug check, including a retired slug as taken", async () => {
    expect((await http().get(`/api/v1/orgs/slug-available?slug=${slug}`)).body).toEqual({ slug, available: true, reason: null })
    expect((await http().get(`/api/v1/orgs/slug-available?slug=${retiredSlug}`)).body).toEqual({ slug: retiredSlug, available: false, reason: "taken" })
    expect((await http().get("/api/v1/orgs/slug-available?slug=api")).body.reason).toBe("reserved")
  })

  it("requires a pg_id", async () => {
    expect((await http().post("/api/v1/orgs").set(HEADERS).send({ name: "Acme", slug })).status).toBe(401)
  })

  it("creates the workspace, its owner, the picker row and the default teams, and opens the session", async () => {
    const response = await create({ name: "Acme", slug, domain: "ACME.com" })
    expect(response.status).toBe(201)
    expect(response.body.organization).toMatchObject({ name: "Acme", slug, status: "ACTIVE", plan: "FREE" })
    expect(response.body.session).toEqual({ slug })
    const cookies = response.headers["set-cookie"] as unknown as string[]
    expect(cookies.some((c) => c.startsWith(`pg_at_${slug}=`))).toBe(true)
    expect(cookies.some((c) => c.startsWith(`pg_rt_${slug}=`))).toBe(true)

    const org = await owner.organization.findUnique({ where: { slug }, include: { teams: true, memberships: true, userOrgIndex: true } })
    expect(org?.domain).toBe("acme.com")
    expect(org?.teams.map((t) => t.name).sort()).toEqual(["IT Support", "Network", "Security"])
    expect(org?.memberships).toHaveLength(1)
    expect(org?.memberships[0]).toMatchObject({ userId, role: "OWNER", status: "ACTIVE", kind: "HUMAN", displayName: "Founder" })
    expect(org?.userOrgIndex[0]).toMatchObject({ userId, roleForDisplay: "OWNER", orgSlug: slug, orgName: "Acme" })
    const seats = await owner.usageCounter.findUnique({ where: { orgId_period_metric: { orgId: org?.id ?? "", period: "current", metric: "AGENT_SEATS" } } })
    expect(seats?.value).toBe(1n)

    // The session it opened works on the new tenant, as its owner.
    const access = cookies.find((c) => c.startsWith(`pg_at_${slug}=`))?.split(";")[0] ?? ""
    const probe = await http().get("/api/v1/probe").set("Origin", `http://${slug}.lvh.me:3001`).set("Cookie", access)
    expect(probe.status).toBe(200)
    expect(probe.body).toMatchObject({ kind: "member", role: "OWNER", orgId: org?.id })
    expect((await http().get(`/api/v1/tenants/${slug}`)).body).toEqual({ status: "active", slug })
  })

  it("is 409 for a taken slug and for a retired one", async () => {
    const taken = await create({ name: "Acme Again", slug })
    expect(taken.status).toBe(409)
    expect(taken.body.type).toContain("conflict")
    expect((await create({ name: "Former Again", slug: retiredSlug })).status).toBe(409)
    expect((await http().get(`/api/v1/orgs/slug-available?slug=${slug}`)).body.reason).toBe("taken")
  })

  it("lets exactly one of two simultaneous creators have a slug", async () => {
    const [a, b] = await Promise.all([create({ name: "Race A", slug: racedSlug }), create({ name: "Race B", slug: racedSlug })])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(await owner.organization.count({ where: { slug: racedSlug } })).toBe(1)
    expect(await owner.membership.count({ where: { userId } })).toBe(2)
  })

  it("rejects a reserved or malformed slug as validation, before any lookup", async () => {
    const reserved = await create({ name: "Nope", slug: "api" })
    expect(reserved.status).toBe(400)
    expect(reserved.body.errors[0].path).toBe("slug")
  })
})
