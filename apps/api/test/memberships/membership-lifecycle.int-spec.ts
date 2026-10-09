/**
 * The membership lifecycle through the booted AppModule (ADR-0033): invite →
 * preview → accept (signed in, and with a new account) → role change → disable
 * → enable → remove → invite back, with the real queue and worker carrying the
 * invitation mail, sessions revoked through the epoch, the picker projection
 * kept in step, and two owners demoting each other at once leaving one owner.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { PasswordService } from "../../src/auth/passwords/password.service"
import { CLOCK, FixedClock } from "../../src/common/clock/clock"
import { MAIL_PROVIDER, type OutboundMail } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"

const suffix = randomUUID().slice(0, 8)
const slug = `crew-${suffix}`
const ORIGIN = `http://${slug}.lvh.me:3001`
const password = "correct horse battery staple"
const people = {
  owner: `owner-${suffix}@probe.test`,
  bob: `bob-${suffix}@probe.test`,
  carol: `carol-${suffix}@probe.test`,
}
const HEADERS = { "Content-Type": "application/json", "X-Requested-With": "patchgrid" }

let db: PrismaClient
let app: INestApplication
let orgId = ""
const recorder = new RecordingMailProvider()
/**
 * Token `iat` has second precision and a tie with an epoch bump goes to the
 * revocation (TENANCY.md §6), so a session reopened in the bump's second is
 * refused by design. The spec steps its clock past the second instead of sleeping.
 */
const clock = new FixedClock(new Date())

const http = () => request(app.getHttpServer())
const cookiesOf = (response: request.Response): string[] =>
  ((response.headers["set-cookie"] as unknown as string[] | undefined) ?? []).map((c) => c.split(";")[0] ?? "")
const pick = (cookies: string[], prefix: string) => cookies.find((c) => c.startsWith(prefix)) ?? ""

/** A browser on the workspace: the tenant's access cookie, its Origin, the CSRF header. */
const as = (access: string) => ({
  get: (path: string) => http().get(`/api/v1${path}`).set("Origin", ORIGIN).set("Cookie", access),
  post: (path: string, body: object = {}) =>
    http().post(`/api/v1${path}`).set(HEADERS).set("Origin", ORIGIN).set("Cookie", access).send(body),
  patch: (path: string, body: object) =>
    http().patch(`/api/v1${path}`).set(HEADERS).set("Origin", ORIGIN).set("Cookie", access).send(body),
  delete: (path: string) => http().delete(`/api/v1${path}`).set(HEADERS).set("Origin", ORIGIN).set("Cookie", access),
})

async function login(email: string): Promise<{ pgId: string; access: string }> {
  const response = await http().post("/api/v1/auth/login").set(HEADERS).send({ email, password, slug })
  const cookies = cookiesOf(response)
  return { pgId: pick(cookies, "pg_id="), access: pick(cookies, `pg_at_${slug}=`) }
}

async function inviteMail(address: string, after: number): Promise<OutboundMail> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = recorder.sent.slice(after).find((m) => m.to === address && /invited/.test(m.subject))
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`no invitation reached ${address}`)
}
const tokenIn = (mail: OutboundMail): string => {
  const match = /token=([0-9a-z]+\.[A-Za-z0-9_-]{43})/.exec(mail.text)
  if (match?.[1] === undefined) throw new Error("no invitation token in mail")
  return match[1]
}

async function invite(access: string, email: string, body: object = {}): Promise<{ id: string; token: string }> {
  const mark = recorder.sent.length
  const response = await as(access).post("/invitations", { email, role: "AGENT", ...body })
  expect(response.status).toBe(201)
  return { id: response.body.id as string, token: tokenIn(await inviteMail(email, mark)) }
}

/** The workspace session a `pg_id` holder reopens after their membership changed. */
async function reopen(pgId: string): Promise<string> {
  clock.advance(1_000)
  const response = await http().post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", pgId).send({ slug })
  return pick(cookiesOf(response), `pg_at_${slug}=`)
}

const state = { owner: "", bob: "", bobPgId: "", carol: "", carolPgId: "", networkTeam: "", bobMembership: "", carolMembership: "" }

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(recorder)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.init()

  const passwordHash = await app.get(PasswordService).hash(password)
  for (const [name, email] of [["Olivia Owner", people.owner], ["Bob", people.bob]] as const) {
    await db.user.create({ data: { email, name, passwordHash, emailVerifiedAt: new Date() } })
  }
  const { pgId } = await login(people.owner)
  const created = await http().post("/api/v1/orgs").set(HEADERS).set("Cookie", pgId).send({ name: "Crew", slug })
  expect(created.status).toBe(201)
  orgId = created.body.organization.id as string
  state.owner = pick(cookiesOf(created), `pg_at_${slug}=`)
  state.networkTeam = (await db.team.findFirstOrThrow({ where: { orgId, name: "Network" } })).id
})

afterAll(async () => {
  const users = await db.user.findMany({ where: { email: { in: Object.values(people) } }, select: { id: true } })
  const userIds = users.map((u) => u.id)
  if (orgId !== "") {
    await db.auditLog.deleteMany({ where: { orgId } })
    await db.invitation.deleteMany({ where: { orgId } })
    await db.teamMembership.deleteMany({ where: { orgId } })
    await db.membership.updateMany({ where: { orgId }, data: { invitedByMembershipId: null } })
    await db.membership.deleteMany({ where: { orgId } })
    await db.userOrgIndex.deleteMany({ where: { orgId } })
    await db.team.deleteMany({ where: { orgId } })
    await db.usageCounter.deleteMany({ where: { orgId } })
    await db.refreshToken.deleteMany({ where: { userId: { in: userIds } } })
    await db.organization.delete({ where: { id: orgId } })
  }
  await db.refreshToken.deleteMany({ where: { userId: { in: userIds } } })
  await db.user.deleteMany({ where: { id: { in: userIds } } })
  await app?.close()
  await db.$disconnect()
})

describe("membership lifecycle", () => {
  it("invites an existing account into a team; the mail carries an org-bearing token", async () => {
    const { token } = await invite(state.owner, people.bob, { teamId: state.networkTeam })
    const pending = await as(state.owner).get("/invitations")
    expect(pending.body).toHaveLength(1)
    expect(pending.body[0]).toMatchObject({ email: people.bob, role: "AGENT", teamId: state.networkTeam })
    expect(JSON.stringify(pending.body)).not.toContain(token.split(".")[1])

    const preview = await http().get(`/api/v1/invitations/preview?token=${token}`)
    expect(preview.body).toEqual({ organization: { name: "Crew", slug }, role: "AGENT", accountExists: true })

    // Re-inviting supersedes: the first link is dead, only the second works.
    const again = await invite(state.owner, people.bob, { teamId: state.networkTeam })
    expect((await http().get(`/api/v1/invitations/preview?token=${token}`)).status).toBe(404)

    const { pgId } = await login(people.bob)
    state.bobPgId = pgId
    const accepted = await http().post("/api/v1/invitations/accept").set(HEADERS).set("Cookie", pgId).send({ token: again.token })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ organization: { id: orgId, slug }, session: { slug } })
    state.bob = pick(cookiesOf(accepted), `pg_at_${slug}=`)
    state.bobMembership = accepted.body.membershipId as string

    const bob = await as(state.bob).get(`/members/${state.bobMembership}`)
    expect(bob.body).toMatchObject({ role: "AGENT", status: "ACTIVE", teams: [{ id: state.networkTeam, name: "Network", isLead: false }] })
    expect(bob.body.contact.email).toBe(people.bob)
    expect((await as(state.owner).get("/invitations")).body).toEqual([])
  })

  it("is the generic 404 for a used token, and refuses a link sent to someone else", async () => {
    const { token } = await invite(state.owner, people.carol)
    const wrongPerson = await http().post("/api/v1/invitations/accept").set(HEADERS).set("Cookie", state.bobPgId).send({ token })
    expect(wrongPerson.status).toBe(404)
    expect(wrongPerson.body.detail).toBe("This invitation was sent to a different address")
    expect(JSON.stringify(wrongPerson.body)).not.toContain(people.carol)

    expect((await http().get(`/api/v1/invitations/preview?token=${token}`)).body.accountExists).toBe(false)
    const created = await http()
      .post("/api/v1/invitations/accept-new")
      .set(HEADERS)
      .send({ token, name: "Carol", password })
    expect(created.status).toBe(201)
    const cookies = cookiesOf(created)
    state.carol = pick(cookies, `pg_at_${slug}=`)
    state.carolPgId = pick(cookies, "pg_id=")
    state.carolMembership = created.body.membershipId as string
    expect((await db.user.findUniqueOrThrow({ where: { email: people.carol } })).emailVerifiedAt).not.toBeNull()

    const reused = await http().post("/api/v1/invitations/accept-new").set(HEADERS).send({ token, name: "Carol", password })
    expect(reused.status).toBe(404)
    expect(reused.body.detail).toBe("This invitation is invalid or has expired")
  })

  it("keeps member administration to admins, and contact details from requesters", async () => {
    expect((await as(state.bob).post("/invitations", { email: `x-${suffix}@probe.test`, role: "AGENT" })).status).toBe(403)
    expect((await as(state.bob).post(`/members/${state.carolMembership}/disable`)).status).toBe(403)

    const toRequester = await as(state.owner).patch(`/members/${state.carolMembership}/role`, { role: "REQUESTER" })
    expect(toRequester.status).toBe(200)
    // The epoch killed Carol's token; her next session sees her new role.
    expect((await as(state.carol).get("/members")).status).toBe(401)
    state.carol = await reopen(state.carolPgId)
    const seen = await as(state.carol).get("/members")
    expect(seen.status).toBe(200)
    expect(seen.body.items.every((m: { contact: unknown }) => m.contact === null)).toBe(true)
  })

  it("lets an admin act below admin, never above, never on themselves", async () => {
    expect((await as(state.owner).patch(`/members/${state.bobMembership}/role`, { role: "ADMIN" })).status).toBe(200)
    state.bob = await reopen(state.bobPgId)

    const ownerId = (await db.membership.findFirstOrThrow({ where: { orgId, role: "OWNER" } })).id
    expect((await as(state.bob).patch(`/members/${state.carolMembership}/role`, { role: "ADMIN" })).status).toBe(403)
    expect((await as(state.bob).post(`/members/${ownerId}/disable`)).status).toBe(403)
    expect((await as(state.bob).patch(`/members/${state.bobMembership}/role`, { role: "AGENT" })).status).toBe(403)
    expect((await as(state.bob).post("/invitations", { email: `y-${suffix}@probe.test`, role: "ADMIN" })).status).toBe(403)
  })

  it("disables and enables, mirroring the picker; a disabled member is out on the next request", async () => {
    const disabled = await as(state.bob).post(`/members/${state.carolMembership}/disable`)
    expect(disabled.status).toBe(200)
    expect(disabled.body.status).toBe("DISABLED")
    expect((await as(state.carol).get("/members")).status).toBe(401)
    const opened = await http().post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", state.carolPgId).send({ slug })
    expect(opened.status).toBe(403)
    const carol = await db.user.findUniqueOrThrow({ where: { email: people.carol } })
    expect((await db.userOrgIndex.findUniqueOrThrow({ where: { userId_orgId: { userId: carol.id, orgId } } })).statusForDisplay).toBe("DISABLED")

    expect((await as(state.bob).post(`/members/${state.carolMembership}/disable`)).status).toBe(409)
    expect((await as(state.bob).post(`/members/${state.carolMembership}/enable`)).body.status).toBe("ACTIVE")
  })

  it("removes: gone from the list and the picker, kept for history, and invitable back as the same row", async () => {
    expect((await as(state.bob).delete(`/members/${state.carolMembership}`)).status).toBe(204)
    const carol = await db.user.findUniqueOrThrow({ where: { email: people.carol } })
    expect(await db.userOrgIndex.findUnique({ where: { userId_orgId: { userId: carol.id, orgId } } })).toBeNull()
    expect((await as(state.bob).get("/members")).body.items.map((m: { id: string }) => m.id)).not.toContain(state.carolMembership)
    expect((await as(state.bob).get(`/members/${state.carolMembership}`)).status).toBe(200)
    const withRemoved = await as(state.owner).get("/members?includeRemoved=true")
    expect(withRemoved.body.items.find((m: { id: string }) => m.id === state.carolMembership)?.status).toBe("REMOVED")

    const { token } = await invite(state.owner, people.carol)
    const back = await http().post("/api/v1/invitations/accept").set(HEADERS).set("Cookie", state.carolPgId).send({ token })
    expect(back.status).toBe(200)
    expect(back.body.membershipId).toBe(state.carolMembership)
  })

  it("never leaves an organization without an owner, even when two owners demote each other at once", async () => {
    const ownerId = (await db.membership.findFirstOrThrow({ where: { orgId, role: "OWNER" } })).id
    expect((await as(state.owner).patch(`/members/${ownerId}/role`, { role: "ADMIN" })).status).toBe(409)

    expect((await as(state.owner).patch(`/members/${state.bobMembership}/role`, { role: "OWNER" })).status).toBe(200)
    const bobAsOwner = await reopen(state.bobPgId)
    const ownerAgain = await reopen((await login(people.owner)).pgId)

    const [a, b] = await Promise.all([
      as(ownerAgain).patch(`/members/${state.bobMembership}/role`, { role: "ADMIN" }),
      as(bobAsOwner).patch(`/members/${ownerId}/role`, { role: "ADMIN" }),
    ])
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1)
    expect(await db.membership.count({ where: { orgId, role: "OWNER", status: "ACTIVE" } })).toBe(1)
  })

  it("audited every step, each attributed", async () => {
    const actions = (await db.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: "asc" }, select: { action: true, actorKind: true } }))
    const names = actions.map((a) => a.action)
    for (const action of ["MEMBER_INVITED", "MEMBER_JOINED", "MEMBER_ROLE_CHANGED", "MEMBER_DISABLED", "MEMBER_ENABLED", "MEMBER_REMOVED"]) {
      expect(names).toContain(action)
    }
    expect(actions.every((a) => a.actorKind === "MEMBER")).toBe(true)
  })
})
