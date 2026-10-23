/**
 * A member's second factor end to end (ADR-0029, ADR-0045), through the booted
 * app: enrolment from the picker, a login that stops at the factor, a code
 * that works once, a recovery code that ends every other session, step-up
 * before an irreversible action, and a workspace that opens for nobody without
 * a confirmed factor — gating the next sign-in, never a session already open.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { codeAt } from "../../src/auth/mfa/totp"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { RedisService } from "../../src/redis/redis.service"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { type Settler, settler } from "../support/queues"
import { browser, jarredBrowser, PASSWORD, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "owner" | "admin" | "agent"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let jobs: Settler
const recorder = new RecordingMailProvider()

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_PROVIDER).useValue(recorder).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "factor", people: { owner: "OWNER", admin: "ADMIN", agent: "AGENT" } })
  jobs = settler(app, [MAIL_QUEUE])
})

afterAll(async () => {
  await db.apiToken.deleteMany({ where: { orgId: ws.orgId } })
  await db.apiTokenIndex.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const jarred = (origin: string, jar?: Map<string, string>) => jarredBrowser(app, origin, jar)

const APP_ORIGIN = "http://app.lvh.me:3001"
const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
/** The picker: `pg_id` only, as the browser on `app.` holds it. */
const picker = (who: Who) => jarred(APP_ORIGIN, new Map([["pg_id", ws.people[who].pgId.split("=")[1] ?? ""]]))
const mailTo = async (who: Who) => {
  await jobs.settle()
  return recorder.sent.filter((m) => m.to === ws.people[who].email).map((m) => m.subject)
}
/** The last accepted step is forgotten, so the next code in this same thirty seconds is not a replay. Tests never sleep. */
const forgetLastStep = (who: Who) => db.userMfaFactor.updateMany({ where: { userId: ws.people[who].userId }, data: { lastUsedStep: null } })

let secret = ""
let recovery: string[] = []

describe("enrolling", () => {
  it("starts from the picker, confirms with one code, and shows ten recovery codes once", async () => {
    const owner = picker("owner")
    expect((await owner.get("/auth/mfa")).body).toEqual({ enrolled: false, confirmedAt: null, methods: [], password: true, recoveryCodesRemaining: 0 })
    expect((await owner.get("/auth/identity")).body.mfa).toEqual({ enrolled: false })
    // The password, not the cookie alone, sets the factor (M9 review).
    expect((await owner.post("/auth/mfa/enrol", { password: "nope-nope-nope" })).status).toBe(400)
    expect((await owner.post("/auth/mfa/enrol")).status).toBe(400)
    const enrol = await owner.post("/auth/mfa/enrol", { password: PASSWORD })
    expect(enrol.status).toBe(200)
    expect(enrol.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Patchgrid:/)
    secret = enrol.body.secret as string
    expect((await owner.post("/auth/mfa/confirm", { code: "000000" })).status).toBe(400)
    const confirm = await owner.post("/auth/mfa/confirm", { code: codeAt(secret, new Date()) })
    expect(confirm.status).toBe(200)
    recovery = confirm.body.recoveryCodes as string[]
    expect(recovery).toHaveLength(10)
    expect((await owner.get("/auth/mfa")).body).toMatchObject({ enrolled: true, recoveryCodesRemaining: 10 })
    expect((await owner.get("/auth/identity")).body.mfa).toEqual({ enrolled: true })
    expect((await owner.post("/auth/mfa/enrol", { password: PASSWORD })).status).toBe(409)
    const stored = await db.userMfaFactor.findFirstOrThrow({ where: { userId: ws.people.owner.userId } })
    expect(stored.secretEncrypted).not.toContain(secret)
    expect(await mailTo("owner")).toEqual([expect.stringMatching(/Two-factor authentication is on/)])
  })

  it("does not touch the session that enrolled: the owner's open workspace carries on", async () => {
    expect((await as("owner").get("/me")).status).toBe(200)
  })
})

describe("signing in with a factor", () => {
  it("stops at the password with a challenge cookie that opens nothing, then completes with a code", async () => {
    const browserA = jarred(APP_ORIGIN)
    const login = await browserA.post("/auth/login", { email: ws.people.owner.email, password: PASSWORD, slug: ws.slug })
    expect(login.status).toBe(200)
    expect(login.body).toEqual({ status: "mfa-required", methods: ["totp"] })
    expect([...browserA.jar.keys()]).toEqual(["pg_mc"])
    expect(String(login.headers["set-cookie"])).toMatch(/pg_mc=[^;]+;.*Path=\/api\/v1\/auth/)
    expect((await browserA.get("/auth/identity")).status).toBe(401)

    expect((await browserA.post("/auth/mfa", { code: "000000" })).status).toBe(400)
    await forgetLastStep("owner")
    const done = await browserA.post("/auth/mfa", { code: codeAt(secret, new Date()) })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ status: "signed-in", session: { slug: ws.slug }, user: { email: ws.people.owner.email } })
    expect([...browserA.jar.keys()].sort()).toEqual(["pg_id", "pg_ws", `pg_at_${ws.slug}`, `pg_rt_${ws.slug}`].sort())
    expect((await browserA.get("/auth/identity")).status).toBe(200)
  })

  it("refuses the same code twice, and a challenge without a factor behind it", async () => {
    const code = codeAt(secret, new Date())
    await forgetLastStep("owner")
    const first = jarred(APP_ORIGIN)
    await first.post("/auth/login", { email: ws.people.owner.email, password: PASSWORD })
    expect((await first.post("/auth/mfa", { code })).status).toBe(200)
    const second = jarred(APP_ORIGIN)
    await second.post("/auth/login", { email: ws.people.owner.email, password: PASSWORD })
    expect((await second.post("/auth/mfa", { code })).status).toBe(400)
    // No challenge at all: a 401, not a guess at a code.
    expect((await jarred(APP_ORIGIN).post("/auth/mfa", { code })).status).toBe(401)
  })

  it("a wrong password is the same 401 as before, factor or not", async () => {
    const attempt = await jarred(APP_ORIGIN).post("/auth/login", { email: ws.people.owner.email, password: "nope-nope-nope" })
    expect(attempt.status).toBe(401)
    expect(attempt.headers["set-cookie"]).toBeUndefined()
  })

  it("signs in with a recovery code once, ending every other session and saying so", async () => {
    const before = recorder.sent.length
    const other = jarred(APP_ORIGIN)
    await other.post("/auth/login", { email: ws.people.owner.email, password: PASSWORD })
    await forgetLastStep("owner")
    expect((await other.post("/auth/mfa", { code: codeAt(secret, new Date()) })).status).toBe(200)
    expect((await other.get("/auth/identity")).status).toBe(200)

    const lost = jarred(APP_ORIGIN)
    await lost.post("/auth/login", { email: ws.people.owner.email, password: PASSWORD, slug: ws.slug })
    const code = recovery[0] ?? ""
    const done = await lost.post("/auth/mfa", { recoveryCode: code.toUpperCase() })
    expect(done.status).toBe(200)
    expect(done.body.session).toEqual({ slug: ws.slug })
    // The earlier browser is out, and the owner's membership epoch now refuses every access token minted before this second.
    // (The seed's token may share this very second with the bump — ties go to revocation — so the epoch is read, not raced.)
    expect((await other.get("/auth/identity")).status).toBe(401)
    const epoch = await app.get(RedisService).client.get(`rev:${ws.people.owner.membershipId}`)
    expect(Number(epoch)).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5)
    expect((await jarred(ws.origin, lost.jar).get("/me")).status).toBe(200)
    expect((await picker("owner").get("/auth/mfa")).status).toBe(401)
    const again = jarred(APP_ORIGIN)
    await again.post("/auth/login", { email: ws.people.owner.email, password: PASSWORD })
    expect((await again.post("/auth/mfa", { recoveryCode: code })).status).toBe(400)
    await jobs.settle()
    expect(recorder.sent.slice(before).map((m) => m.subject)).toContainEqual(expect.stringMatching(/recovery code was used/))
    // The rest of the spec speaks for the owner from here.
    ws.people.owner.pgId = `pg_id=${lost.jar.get("pg_id") ?? ""}`
    ws.people.owner.access = `pg_at_${ws.slug}=${lost.jar.get(`pg_at_${ws.slug}`) ?? ""}`
  })
})

describe("step-up before an irreversible action", () => {
  it("refuses a plain session, takes the factor when one exists, and stamps the re-issued pair for five minutes", async () => {
    const owner = picker("owner")
    const unproved = await as("owner").post("/org/api-tokens", { name: "Zabbix", role: "AGENT", scopes: ["tickets:read"], expiresInDays: null })
    expect(unproved.status).toBe(403)
    expect(unproved.body.type).toContain("step-up-required")
    // The password cannot stand in for the factor.
    expect((await owner.post("/auth/step-up", { slug: ws.slug, password: PASSWORD })).status).toBe(400)
    await forgetLastStep("owner")
    const proved = await owner.post("/auth/step-up", { slug: ws.slug, code: codeAt(secret, new Date()) })
    expect(proved.status).toBe(200)
    expect(new Date(proved.body.stepUpExpiresAt as string).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)
    const minted = await jarred(ws.origin, owner.jar).post("/org/api-tokens", { name: "Zabbix", role: "AGENT", scopes: ["tickets:read"], expiresInDays: null })
    expect(minted.status, JSON.stringify(minted.body)).toBe(201)
  })

  it("takes the password from someone with no factor, counted against the same lockout", async () => {
    const admin = picker("admin")
    expect((await admin.post("/auth/step-up", { slug: ws.slug, code: "123456" })).status).toBe(400)
    expect((await admin.post("/auth/step-up", { slug: ws.slug, password: "nope-nope-nope" })).status).toBe(400)
    expect((await admin.post("/auth/step-up", { slug: ws.slug, password: PASSWORD })).status).toBe(200)
    const minted = await jarred(ws.origin, admin.jar).post("/org/api-tokens", { name: "Grafana", role: "AGENT", scopes: ["tickets:read"], expiresInDays: null })
    expect(minted.status).toBe(201)
    // A refresh re-mints without the proof: the claim is the step-up's, not the session's.
    const refreshed = await jarred(APP_ORIGIN, admin.jar).post("/auth/refresh", { slug: ws.slug })
    expect(refreshed.status).toBe(204)
    expect((await jarred(ws.origin, admin.jar).post("/org/api-tokens", { name: "Again", role: "AGENT", scopes: ["tickets:read"], expiresInDays: null })).status).toBe(403)
  })
})

describe("a workspace that requires a factor", () => {
  it("is the owner's policy, audited, and gates opening and refreshing — not the sessions already open", async () => {
    expect((await as("admin").patch("/org/settings", { requireMfa: true })).status).toBe(403)
    const set = await as("owner").patch("/org/settings", { requireMfa: true })
    expect(set.status).toBe(200)
    expect(set.body.requireMfa).toBe(true)
    expect(await db.auditLog.count({ where: { orgId: ws.orgId, action: "ORG_MFA_REQUIREMENT_CHANGED" } })).toBe(1)
    expect((await as("agent").get("/me")).body.org.requireMfa).toBe(true)

    // The agent has no factor: still in, until the next sign-in.
    expect((await as("agent").get("/me")).status).toBe(200)
    const open = await picker("agent").post("/auth/sessions", { slug: ws.slug })
    expect(open.status).toBe(403)
    expect(open.body.type).toContain("mfa-required")
    const login = await jarred(APP_ORIGIN).post("/auth/login", { email: ws.people.agent.email, password: PASSWORD, slug: ws.slug })
    expect(login.body.session).toBeNull()
    // The owner, with a factor, opens as before.
    expect((await picker("owner").post("/auth/sessions", { slug: ws.slug })).status).toBe(200)
  })

  it("lets the agent in once they enrol, and back out once they turn it off — never by the password alone", async () => {
    const agent = picker("agent")
    const enrol = await agent.post("/auth/mfa/enrol", { password: PASSWORD })
    const agentSecret = enrol.body.secret as string
    const confirm = await agent.post("/auth/mfa/confirm", { code: codeAt(agentSecret, new Date()) })
    expect(confirm.status).toBe(200)
    expect((await agent.post("/auth/sessions", { slug: ws.slug })).status).toBe(200)

    expect((await agent.post("/auth/mfa/disable", { password: PASSWORD })).status).toBe(400)
    expect((await agent.post("/auth/mfa/disable", { code: "000000" })).status).toBe(400)
    await forgetLastStep("agent")
    expect((await agent.post("/auth/mfa/disable", { code: codeAt(agentSecret, new Date()) })).status).toBe(204)
    expect((await agent.get("/auth/mfa")).body.enrolled).toBe(false)
    expect((await agent.post("/auth/sessions", { slug: ws.slug })).status).toBe(403)
    expect(await mailTo("agent")).toEqual([expect.stringMatching(/is on/), expect.stringMatching(/turned off/)])
  })
})
