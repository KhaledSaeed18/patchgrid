/**
 * Passkeys end to end (ADR-0053), through the booted app with a software
 * authenticator standing in for the browser: registered from the picker
 * against a fresh proof, signing in alone on a workspace host, completing
 * the second step, proving a step-up, satisfying a workspace's `requireMfa`,
 * and removed — and refused on every host a passkey does not count on.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { type Settler, settler } from "../support/queues"
import { SoftAuthenticator } from "../support/soft-authenticator"
import { browser, jarredBrowser, PASSWORD, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "owner" | "agent"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let jobs: Settler
const recorder = new RecordingMailProvider()
const laptop = new SoftAuthenticator()
const phone = new SoftAuthenticator({ synced: true })

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_PROVIDER).useValue(recorder).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "passkey", people: { owner: "OWNER", agent: "AGENT" } })
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

const APP_ORIGIN = "http://app.lvh.me:3001"
const ADMIN_ORIGIN = "http://admin.lvh.me:3001"
const jarred = (origin: string, jar?: Map<string, string>) => jarredBrowser(app, origin, jar)
const picker = (who: Who) => jarred(APP_ORIGIN, new Map([["pg_id", ws.people[who].pgId.split("=")[1] ?? ""]]))
const subjectsTo = async (who: Who) => {
  await jobs.settle()
  return recorder.sent.filter((m) => m.to === ws.people[who].email).map((m) => m.subject)
}

/** A passkey proof for a `pg_id` holder: options, then the authenticator's answer on `origin`. */
async function proof(holder: ReturnType<typeof picker>, device: SoftAuthenticator, origin = APP_ORIGIN) {
  const options = await holder.post("/auth/passkeys/proof/options")
  expect(options.status).toBe(200)
  return { challengeId: options.body.challengeId as string, credential: device.get(options.body.options, origin) }
}

/** A passwordless sign-in from a fresh browser on `origin`. */
async function passwordless(device: SoftAuthenticator, origin: string, slug?: string) {
  const visitor = jarred(origin)
  const options = await visitor.post("/auth/passkeys/login/options")
  expect(options.status).toBe(200)
  const credential = device.get(options.body.options, origin)
  const signedIn = await visitor.post("/auth/passkeys/login", { challengeId: options.body.challengeId, credential, ...(slug === undefined ? {} : { slug }) })
  return { visitor, signedIn, replay: () => jarred(origin).post("/auth/passkeys/login", { challengeId: options.body.challengeId, credential }) }
}

describe("registering", () => {
  it("takes the password from someone with no factor, then shows ten recovery codes with the first passkey", async () => {
    const owner = picker("owner")
    // A pg_id alone does not add a passkey.
    expect((await owner.post("/auth/passkeys/registration/options")).status).toBe(400)
    expect((await owner.post("/auth/passkeys/registration/options", { password: "nope-nope-nope" })).status).toBe(400)
    const options = await owner.post("/auth/passkeys/registration/options", { password: PASSWORD })
    expect(options.status).toBe(200)
    expect(options.body.options.rp).toEqual({ id: "lvh.me", name: "Patchgrid" })

    const added = await owner.post("/auth/passkeys", { challengeId: options.body.challengeId, credential: laptop.create(options.body.options, APP_ORIGIN), label: "Laptop" })
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    expect(added.body.recoveryCodes).toHaveLength(10)
    expect(added.body.passkey).toMatchObject({ label: "Laptop", synced: false, lastUsedAt: null })

    expect((await owner.get("/auth/passkeys")).body).toHaveLength(1)
    expect((await owner.get("/auth/mfa")).body).toEqual({ enrolled: false, confirmedAt: null, methods: ["passkey"], password: true, recoveryCodesRemaining: 10 })
    expect((await owner.get("/auth/identity")).body.mfa).toEqual({ enrolled: true })
    expect(await subjectsTo("owner")).toContainEqual(expect.stringMatching(/A passkey was added/))
  })

  it("refuses a challenge answered twice, and one answered from the back-office", async () => {
    const owner = picker("owner")
    const options = await owner.post("/auth/passkeys/registration/options", { passkey: await proof(owner, laptop) })
    expect(options.status).toBe(200)
    expect((await owner.post("/auth/passkeys", { challengeId: options.body.challengeId, credential: phone.create(options.body.options, ADMIN_ORIGIN), label: "Phone" })).status).toBe(400)
    // Spent by the refusal: a second answer to the same challenge is refused too.
    expect((await owner.post("/auth/passkeys", { challengeId: options.body.challengeId, credential: phone.create(options.body.options, APP_ORIGIN), label: "Phone" })).status).toBe(400)
  })

  it("takes a factor, not the password, for the second passkey — and keeps the codes the person has", async () => {
    const owner = picker("owner")
    const refused = await owner.post("/auth/passkeys/registration/options", { password: PASSWORD })
    expect(refused.status).toBe(400)
    expect(refused.body.errors).toContainEqual(expect.objectContaining({ code: "factor_required" }))

    const options = await owner.post("/auth/passkeys/registration/options", { passkey: await proof(owner, laptop) })
    const added = await owner.post("/auth/passkeys", { challengeId: options.body.challengeId, credential: phone.create(options.body.options, APP_ORIGIN), label: "Phone" })
    expect(added.status).toBe(201)
    expect(added.body.recoveryCodes).toBeNull()
    expect(added.body.passkey.synced).toBe(true)
    expect((await owner.get("/auth/mfa")).body.recoveryCodesRemaining).toBe(10)
  })

  it("does not let a password beside a passkey set up an authenticator app of its own", async () => {
    expect((await picker("owner").post("/auth/mfa/enrol", { password: PASSWORD })).status).toBe(400)
  })
})

describe("signing in", () => {
  it("signs in alone on a workspace host, opening the workspace it named, with nothing typed", async () => {
    const { visitor, signedIn, replay } = await passwordless(laptop, ws.origin, ws.slug)
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
    expect(signedIn.body).toMatchObject({ status: "signed-in", session: { slug: ws.slug }, user: { email: ws.people.owner.email } })
    expect([...visitor.jar.keys()].sort()).toEqual(["pg_id", "pg_ws", `pg_at_${ws.slug}`, `pg_rt_${ws.slug}`].sort())
    expect((await jarred(ws.origin, visitor.jar).get("/me")).status).toBe(200)
    // The challenge is spent: the same assertion signs no one in again.
    expect((await replay()).status).toBe(401)
    const listed = (await picker("owner").get("/auth/passkeys")).body as { label: string; lastUsedAt: string | null }[]
    expect(listed.find((p) => p.label === "Laptop")?.lastUsedAt).not.toBeNull()
  })

  it("is one 401 on the back-office host, and for a credential nobody registered", async () => {
    expect((await passwordless(laptop, ADMIN_ORIGIN)).signedIn.status).toBe(401)
    const stranger = new SoftAuthenticator()
    const unused = await jarred(APP_ORIGIN).post("/auth/passkeys/registration/options")
    expect(unused.status).toBe(401)
    const options = await jarred(APP_ORIGIN).post("/auth/passkeys/login/options")
    stranger.create({ ...options.body.options, rp: { id: "lvh.me", name: "Patchgrid" }, user: { id: "AAAA", name: "x", displayName: "x" }, pubKeyCredParams: [{ alg: -7, type: "public-key" }] }, APP_ORIGIN)
    const unknown = await jarred(APP_ORIGIN).post("/auth/passkeys/login", { challengeId: options.body.challengeId, credential: stranger.get(options.body.options, APP_ORIGIN) })
    expect(unknown.status).toBe(401)
  })

  it("names the kinds after the password, and completes the second step with a passkey", async () => {
    const visitor = jarred(APP_ORIGIN)
    const login = await visitor.post("/auth/login", { email: ws.people.owner.email, password: PASSWORD, slug: ws.slug })
    expect(login.body).toEqual({ status: "mfa-required", methods: ["passkey"] })
    // No challenge cookie, no passkey challenge.
    expect((await jarred(APP_ORIGIN).post("/auth/mfa/passkey/options")).status).toBe(401)
    const options = await visitor.post("/auth/mfa/passkey/options")
    expect(options.status).toBe(200)
    const done = await visitor.post("/auth/mfa", { passkey: { challengeId: options.body.challengeId, credential: phone.get(options.body.options, APP_ORIGIN) } })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.session).toEqual({ slug: ws.slug })
  })
})

describe("step-up and policy", () => {
  it("proves a step-up with a passkey; the password cannot stand in for it", async () => {
    const owner = picker("owner")
    expect((await owner.post("/auth/step-up", { slug: ws.slug, password: PASSWORD })).status).toBe(400)
    const proved = await owner.post("/auth/step-up", { slug: ws.slug, passkey: await proof(owner, laptop) })
    expect(proved.status, JSON.stringify(proved.body)).toBe(200)
    const minted = await jarred(ws.origin, owner.jar).post("/org/api-tokens", { name: "Zabbix", role: "AGENT", scopes: ["tickets:read"], expiresInDays: null })
    expect(minted.status, JSON.stringify(minted.body)).toBe(201)
  })

  it("satisfies a workspace that requires a second factor, where the password alone does not", async () => {
    expect((await browser(app, ws.origin, ws.people.owner.access).patch("/org/settings", { requireMfa: true })).status).toBe(200)
    expect((await passwordless(laptop, ws.origin, ws.slug)).signedIn.body.session).toEqual({ slug: ws.slug })
    const agent = await jarred(APP_ORIGIN).post("/auth/login", { email: ws.people.agent.email, password: PASSWORD, slug: ws.slug })
    expect(agent.body.session).toBeNull()
    expect((await browser(app, ws.origin, ws.people.owner.access).patch("/org/settings", { requireMfa: false })).status).toBe(200)
  })
})

describe("managing", () => {
  it("renames on the session alone; another person's passkey is not there to rename", async () => {
    const owner = picker("owner")
    const [first] = (await owner.get("/auth/passkeys")).body as { id: string }[]
    const renamed = await owner.patch(`/auth/passkeys/${first?.id ?? ""}`, { label: "Work laptop" })
    expect(renamed.status).toBe(200)
    expect(renamed.body.label).toBe("Work laptop")
    expect((await picker("agent").patch(`/auth/passkeys/${first?.id ?? ""}`, { label: "Mine now" })).status).toBe(404)
  })

  it("removes with a factor; the last one takes the recovery codes with it, and each is mailed", async () => {
    const owner = picker("owner")
    const keys = (await owner.get("/auth/passkeys")).body as { id: string; label: string }[]
    const phoneKey = keys.find((k) => k.label === "Phone")
    const laptopKey = keys.find((k) => k.label !== "Phone")
    // Not by the session alone.
    expect((await owner.post(`/auth/passkeys/${phoneKey?.id ?? ""}/remove`)).status).toBe(400)
    expect((await owner.post(`/auth/passkeys/${phoneKey?.id ?? ""}/remove`, { passkey: await proof(owner, phone) })).status).toBe(204)
    expect((await owner.get("/auth/mfa")).body.recoveryCodesRemaining).toBe(10)

    // A passkey may prove its own removal; it was the last factor, so the codes go too.
    expect((await owner.post(`/auth/passkeys/${laptopKey?.id ?? ""}/remove`, { passkey: await proof(owner, laptop) })).status).toBe(204)
    expect((await owner.get("/auth/mfa")).body).toEqual({ enrolled: false, confirmedAt: null, methods: [], password: true, recoveryCodesRemaining: 0 })
    expect(await db.userMfaRecovery.count({ where: { userId: ws.people.owner.userId } })).toBe(0)
    expect((await subjectsTo("owner")).filter((s) => /passkey was removed/.test(s))).toHaveLength(2)
    // Gone: it signs no one in.
    expect((await passwordless(laptop, ws.origin)).signedIn.status).toBe(401)
  })
})
