/**
 * The whole session lifecycle through the real AppModule — every guard in its
 * production order, the real pipe and filter, Postgres with RLS and Redis —
 * driven over HTTP exactly as a browser would drive it.
 */
import { requireEnv } from "../support/env"

import { Controller, Get, type INestApplication, Post } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { ActorService } from "../../src/auth/actor"
import { AuthModule } from "../../src/auth/auth.module"
import { PasswordService } from "../../src/auth/passwords/password.service"
import { RedisService } from "../../src/redis/redis.service"

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
}

const suffix = randomUUID().slice(0, 8)
const acme = { id: "", slug: `acme-${suffix}` }
const globex = { id: "", slug: `globex-${suffix}` }
const email = `owner-${suffix}@probe.test`
const password = "correct horse battery staple"
let userId = ""
let acmeMembershipId = ""

let owner: PrismaClient
let app: INestApplication
let redis: RedisService

const JSON_HEADERS = { "Content-Type": "application/json", "X-Requested-With": "patchgrid" }
const fromAcme = { Origin: `http://${acme.slug}.lvh.me:3001` }

type Jar = Record<string, string>
function absorb(jar: Jar, response: request.Response): Jar {
  const raw = response.headers["set-cookie"]
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
  for (const line of list) {
    const [pair = "", ...attributes] = line.split(";")
    const [name = "", value = ""] = pair.split("=")
    const expired = attributes.some((a) => /^\s*Max-Age=0\b/i.test(a) || /Expires=Thu, 01 Jan 1970/i.test(a))
    if (expired || value === "") delete jar[name]
    else jar[name] = value
  }
  return jar
}
const cookieHeader = (jar: Jar, ...names: string[]) =>
  names.filter((n) => jar[n] !== undefined).map((n) => `${n}=${jar[n] ?? ""}`).join("; ")

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })

  const moduleRef = await Test.createTestingModule({
    // AuthModule again so the probe controller can inject ActorService.
    imports: [AppModule, AuthModule],
    controllers: [ProbeController],
  }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.init()
  redis = app.get(RedisService)

  const passwordHash = await app.get(PasswordService).hash(password)
  const user = await owner.user.create({
    data: { email, name: "Probe Owner", passwordHash, emailVerifiedAt: new Date() },
  })
  userId = user.id
  for (const [org, role, status] of [
    [acme, "OWNER", "ACTIVE"],
    [globex, "AGENT", "DISABLED"],
  ] as const) {
    const created = await owner.organization.create({ data: { name: org.slug, slug: org.slug } })
    org.id = created.id
    const membership = await owner.membership.create({
      data: { orgId: created.id, userId, role, status, displayName: "Probe Owner", joinedAt: new Date() },
    })
    if (org === acme) acmeMembershipId = membership.id
    await owner.userOrgIndex.create({
      data: { userId, orgId: created.id, roleForDisplay: role, statusForDisplay: status, orgSlug: org.slug, orgName: org.slug, orgStatus: "ACTIVE" },
    })
  }
})

afterAll(async () => {
  if (userId !== "") {
    await owner.refreshToken.deleteMany({ where: { userId } })
    await owner.userOrgIndex.deleteMany({ where: { userId } })
    await owner.membership.deleteMany({ where: { userId } })
    await owner.user.delete({ where: { id: userId } })
    await owner.organization.deleteMany({ where: { id: { in: [acme.id, globex.id].filter((id) => id !== "") } } })
  }
  if (acmeMembershipId !== "") await redis.client.del(`rev:${acmeMembershipId}`)
  await app.close()
  await owner.$disconnect()
})

const http = () => request(app.getHttpServer())

describe("session lifecycle", () => {
  const jar: Jar = {}

  it("refuses a cookie-borne login without the CSRF header", async () => {
    const response = await http().post("/api/v1/auth/login").set("Content-Type", "application/json").send({ email, password })
    expect(response.status).toBe(403)
    expect(response.body.type).toContain("not-permitted")
  })

  it("answers an unknown address and a wrong password identically", async () => {
    const unknown = await http().post("/api/v1/auth/login").set(JSON_HEADERS).send({ email: `nobody-${suffix}@probe.test`, password })
    const wrong = await http().post("/api/v1/auth/login").set(JSON_HEADERS).send({ email, password: "not the password" })
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect({ ...unknown.body, instance: "" }).toEqual({ ...wrong.body, instance: "" })
  })

  it("logs in: pg_id plus the requested workspace's pair, and the picker's list", async () => {
    const response = await http().post("/api/v1/auth/login").set(JSON_HEADERS).send({ email: email.toUpperCase(), password, slug: acme.slug })
    expect(response.status).toBe(200)
    absorb(jar, response)
    expect(Object.keys(jar).sort()).toEqual(["pg_id", `pg_at_${acme.slug}`, `pg_rt_${acme.slug}`].sort())
    expect(response.body.session).toEqual({ slug: acme.slug })
    expect(response.body.workspaces.map((w: { slug: string }) => w.slug).sort()).toEqual([acme.slug, globex.slug].sort())
    const refreshCookie = (response.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("pg_rt_"))
    expect(refreshCookie).toMatch(/Path=\/api\/v1\/auth/)
    expect(refreshCookie).toMatch(/HttpOnly/)
  })

  it("admits the session on a tenant-bound route as a member actor", async () => {
    const response = await http().get("/api/v1/probe").set(fromAcme).set("Cookie", cookieHeader(jar, `pg_at_${acme.slug}`))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ kind: "member", userId, orgId: acme.id, membershipId: acmeMembershipId, role: "OWNER" })
  })

  it("refuses a mutation without the CSRF header and admits it with", async () => {
    const cookie = cookieHeader(jar, `pg_at_${acme.slug}`)
    expect((await http().post("/api/v1/probe").set(fromAcme).set("Cookie", cookie)).status).toBe(403)
    const ok = await http().post("/api/v1/probe").set(fromAcme).set(JSON_HEADERS).set("Cookie", cookie)
    expect(ok.status).toBe(201)
    expect(ok.body).toEqual({ actor: acmeMembershipId })
  })

  it("refuses the acme session presented on globex's subdomain", async () => {
    const response = await http()
      .get("/api/v1/probe")
      .set("Origin", `http://${globex.slug}.lvh.me:3001`)
      .set("Cookie", `pg_at_${globex.slug}=${jar[`pg_at_${acme.slug}`] ?? ""}`)
    expect(response.status).toBe(403)
    expect(response.body.type).toContain("tenant-mismatch")
  })

  it("rotates on refresh and revokes the chain when the old token is replayed", async () => {
    const before = jar[`pg_rt_${acme.slug}`] ?? ""
    const rotated = await http().post("/api/v1/auth/refresh").set(JSON_HEADERS).set("Cookie", cookieHeader(jar, `pg_rt_${acme.slug}`)).send({ slug: acme.slug })
    expect(rotated.status).toBe(204)
    absorb(jar, rotated)
    expect(jar[`pg_rt_${acme.slug}`]).not.toBe(before)

    const replay = await http().post("/api/v1/auth/refresh").set(JSON_HEADERS).set("Cookie", `pg_rt_${acme.slug}=${before}`).send({ slug: acme.slug })
    expect(replay.status).toBe(401)
    const newest = await http().post("/api/v1/auth/refresh").set(JSON_HEADERS).set("Cookie", cookieHeader(jar, `pg_rt_${acme.slug}`)).send({ slug: acme.slug })
    expect(newest.status).toBe(401)
    // The access token minted by the rotation is still valid until it expires or the epoch moves.
    expect((await http().get("/api/v1/probe").set(fromAcme).set("Cookie", cookieHeader(jar, `pg_at_${acme.slug}`))).status).toBe(200)
  })

  it("opens a workspace from pg_id, and refuses one where the membership is disabled", async () => {
    const denied = await http().post("/api/v1/auth/sessions").set(JSON_HEADERS).set("Cookie", cookieHeader(jar, "pg_id")).send({ slug: globex.slug })
    expect(denied.status).toBe(403)
    expect(denied.body.type).toContain("not-permitted")

    const opened = await http().post("/api/v1/auth/sessions").set(JSON_HEADERS).set("Cookie", cookieHeader(jar, "pg_id")).send({ slug: acme.slug })
    expect(opened.status).toBe(200)
    absorb(jar, opened)
    expect(opened.body).toEqual({ session: { slug: acme.slug } })
  })

  it("ends a disabled member's session on the next request, before any epoch", async () => {
    await owner.membership.update({ where: { id: acmeMembershipId }, data: { status: "DISABLED" } })
    expect((await http().get("/api/v1/probe").set(fromAcme).set("Cookie", cookieHeader(jar, `pg_at_${acme.slug}`))).status).toBe(401)
    await owner.membership.update({ where: { id: acmeMembershipId }, data: { status: "ACTIVE" } })
    expect((await http().get("/api/v1/probe").set(fromAcme).set("Cookie", cookieHeader(jar, `pg_at_${acme.slug}`))).status).toBe(200)
  })

  it("logs out everywhere: tokens revoked, epoch bumped, the live access token refused", async () => {
    const access = jar[`pg_at_${acme.slug}`] ?? ""
    const response = await http()
      .post("/api/v1/auth/logout")
      .set(JSON_HEADERS)
      .set("Cookie", cookieHeader(jar, "pg_id", `pg_rt_${acme.slug}`))
      .send({ slug: acme.slug, everywhere: true })
    expect(response.status).toBe(204)
    absorb(jar, response)
    expect(jar).toEqual({})

    expect(await redis.client.get(`rev:${acmeMembershipId}`)).not.toBeNull()
    expect(await owner.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0)
    // Still unexpired, but minted before the epoch.
    const refused = await http().get("/api/v1/probe").set(fromAcme).set("Cookie", `pg_at_${acme.slug}=${access}`)
    expect(refused.status).toBe(401)
    expect((await http().post("/api/v1/auth/sessions").set(JSON_HEADERS).send({ slug: acme.slug })).status).toBe(401)
  })
})
