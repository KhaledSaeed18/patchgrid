/**
 * Per-tenant SSO end to end (ADR-0054), through the booted app, against an
 * OpenID provider in this process: the owner proves nothing by DNS here (the
 * seed's privilege stands in), saves a connection that discovery checks,
 * and people sign in through it. Provisioned, linked, refused, scoped to the
 * one workspace, required of non-owners, and stepped up at the provider.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { decodeJwt } from "jose"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { DOMAIN_RESOLVER } from "../../src/sso/domain-resolver"
import { FakeIdp, type IdpPerson } from "../support/fake-idp"
import { browser, HEADERS, PASSWORD, seedWorkspace, stepUp, type Workspace } from "../support/workspace"

type Who = "owner" | "agent"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let other: Workspace<"owner">
const idp = new FakeIdp()
const suffix = randomUUID().slice(0, 8)
const DOMAIN = `sso-${suffix}.test`
/** What the spec's resolver answers for the proof record. */
const txt = new Map<string, string[]>()
const createdUsers: string[] = []

beforeAll(async () => {
  // The provider is on this machine, over http: what the local Keycloak needs too.
  process.env.SSO_ALLOW_PRIVATE_ISSUERS = "true"
  await idp.start()
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DOMAIN_RESOLVER)
    .useValue({ txt: async (name: string) => txt.get(name) ?? [] })
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "sso", people: { owner: "OWNER", agent: "AGENT" } })
  other = await seedWorkspace(app, db, { prefix: "sso-other", people: { owner: "OWNER" } })
})

afterAll(async () => {
  const users = await db.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } })
  createdUsers.push(...users.map((u) => u.id))
  await db.ssoIdentity.deleteMany({ where: { orgId: { in: [ws.orgId, other.orgId] } } })
  // Audit rows name the memberships the spec provisioned; they go first.
  await db.auditLog.deleteMany({ where: { orgId: { in: [ws.orgId, other.orgId] } } })
  await db.membership.deleteMany({ where: { userId: { in: createdUsers } } })
  await db.userOrgIndex.deleteMany({ where: { userId: { in: createdUsers } } })
  await db.refreshToken.deleteMany({ where: { OR: [{ userId: { in: createdUsers } }, { ssoOrgId: { in: [ws.orgId, other.orgId] } }] } })
  await ws?.cleanup()
  await other?.cleanup()
  await db.user.deleteMany({ where: { id: { in: createdUsers } } })
  await app?.close()
  await idp.stop()
  await db.$disconnect()
  delete process.env.SSO_ALLOW_PRIVATE_ISSUERS
})

const http = () => request(app.getHttpServer())
const cookiesOf = (response: request.Response): Map<string, string> =>
  new Map(
    ((response.headers["set-cookie"] as unknown as string[] | undefined) ?? []).map((line) => {
      const [pair = ""] = line.split(";")
      const at = pair.indexOf("=")
      return [pair.slice(0, at), pair.slice(at + 1)] as [string, string]
    }),
  )
const jar = (cookies: Map<string, string>, ...names: string[]) =>
  names
    .filter((n) => (cookies.get(n) ?? "") !== "")
    .map((n) => `${n}=${cookies.get(n) ?? ""}`)
    .join("; ")
const ownerBrowser = async () => browser(app, ws.origin, await stepUp(app, ws.slug, ws.people.owner))

/** A whole round trip: start, the person at the provider, the callback in the same browser. */
async function signIn(start: string, person: IdpPerson, extra: { pgId?: string; dropState?: boolean } = {}) {
  // What a browser says when the login page on app. navigates to api.: the same site.
  const started = await http().get(`/api/v1/auth/sso/start?${start}`).set("Sec-Fetch-Site", "same-site")
  expect(started.status).toBe(302)
  const state = cookiesOf(started).get("pg_sso") ?? ""
  const callback = idp.authorize(started.headers.location as string, person)
  const cookie = [extra.dropState === true ? "" : `pg_sso=${state}`, extra.pgId === undefined ? "" : `pg_id=${extra.pgId}`].filter((c) => c !== "").join("; ")
  const finished = await http().get(`${callback.pathname}${callback.search}`).set("Cookie", cookie)
  expect(finished.status).toBe(302)
  return { started, finished, callback, location: finished.headers.location as string, cookies: cookiesOf(finished) }
}

describe("settings", () => {
  it("are the owner's: a domain proved by its TXT record, then a connection discovery accepts", async () => {
    const owner = await ownerBrowser()
    expect((await browser(app, ws.origin, ws.people.agent.access).get("/org/sso")).status).toBe(403)

    const claimed = await owner.put("/org/domain", { domain: DOMAIN })
    expect(claimed.status).toBe(200)
    const record = claimed.body.domain.record as { name: string; value: string }
    expect(record.name).toBe(`_patchgrid-verify.${DOMAIN}`)
    expect((await owner.post("/org/domain/verification")).status).toBe(409)
    txt.set(record.name, [record.value])
    const proved = await owner.post("/org/domain/verification")
    expect(proved.status).toBe(200)
    expect(proved.body.domain.verifiedAt).not.toBeNull()

    // First verified wins: the other workspace cannot prove it too.
    const rival = browser(app, other.origin, await stepUp(app, other.slug, other.people.owner))
    const rivalClaim = await rival.put("/org/domain", { domain: DOMAIN })
    txt.set(rivalClaim.body.domain.record.name as string, [rivalClaim.body.domain.record.value as string])
    expect((await rival.post("/org/domain/verification")).status).toBe(409)
    await rival.put("/org/domain", { domain: null })

    // Without a fresh proof the connection is refused, like minting a token.
    const plain = browser(app, ws.origin, ws.people.owner.access)
    expect((await plain.put("/org/sso/connection", { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, defaultRole: "REQUESTER", enabled: true })).body.type).toMatch(/step-up-required$/)

    idp.claimedIssuer = "http://127.0.0.1:1/realms/impostor"
    expect((await owner.put("/org/sso/connection", { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, defaultRole: "REQUESTER", enabled: true })).status).toBe(400)
    idp.claimedIssuer = null

    const saved = await owner.put("/org/sso/connection", { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, defaultRole: "REQUESTER", enabled: true })
    expect(saved.status).toBe(200)
    expect(saved.body.connection).toMatchObject({ issuer: idp.issuer, clientSecretSet: true, enabled: true })
    expect(JSON.stringify(saved.body)).not.toContain(idp.clientSecret)
    expect(saved.body.redirectUri).toBe("http://api.lvh.me:4000/api/v1/auth/sso/callback")
    const sealed = await db.ssoConnection.findUniqueOrThrow({ where: { orgId: ws.orgId } })
    expect(sealed.clientSecretSealed).not.toContain(idp.clientSecret)
  })
})

describe("signing in", () => {
  it("discovers the workspace by the address's domain, and nothing for another", async () => {
    const found = await http().post("/api/v1/auth/sso/discover").set(HEADERS).send({ email: `kim@${DOMAIN}` })
    expect(found.body).toEqual({ sso: { slug: ws.slug, name: expect.any(String) } })
    expect((await http().post("/api/v1/auth/sso/discover").set(HEADERS).send({ email: "kim@elsewhere.test" })).body).toEqual({ sso: null })
  })

  it("provisions a new person on first sign-in: verified, no password, a requester, scoped to this workspace", async () => {
    const { started, location, cookies } = await signIn(`email=kim@${DOMAIN}&next=/queues`, { sub: "kim-sub", email: `kim@${DOMAIN}`, name: "Kim Lee" })
    const authorize = new URL(started.headers.location as string)
    expect(authorize.searchParams.get("login_hint")).toBe(`kim@${DOMAIN}`)
    expect(authorize.searchParams.get("scope")).toBe("openid email profile")
    expect(location).toBe(`http://${ws.slug}.lvh.me:3001/queues`)

    const user = await db.user.findUniqueOrThrow({ where: { email: `kim@${DOMAIN}` } })
    expect(user.passwordHash).toBeNull()
    expect(user.emailVerifiedAt).not.toBeNull()
    const membership = await db.membership.findUniqueOrThrow({ where: { orgId_userId: { orgId: ws.orgId, userId: user.id } } })
    expect(membership.role).toBe("REQUESTER")
    expect(membership.displayName).toBe("Kim Lee")
    expect(await db.ssoIdentity.count({ where: { orgId: ws.orgId, subject: "kim-sub", membershipId: membership.id } })).toBe(1)
    const joined = await db.auditLog.findFirstOrThrow({ where: { orgId: ws.orgId, action: "MEMBER_JOINED", entityId: membership.id } })
    expect(joined.diff).toMatchObject({ via: "sso", role: "REQUESTER", newAccount: true })

    const access = cookies.get(`pg_at_${ws.slug}`) ?? ""
    expect(decodeJwt(access).sso).toBe(true)
    expect((await db.refreshToken.findMany({ where: { userId: user.id, revokedAt: null } })).every((t) => t.ssoOrgId === ws.orgId)).toBe(true)
    const me = await browser(app, ws.origin, `pg_at_${ws.slug}=${access}`).get("/me")
    expect(me.status).toBe(200)

    // Signing in again is the same membership, by its subject.
    await signIn(`slug=${ws.slug}`, { sub: "kim-sub", email: `kim@${DOMAIN}` })
    expect(await db.membership.count({ where: { userId: user.id } })).toBe(1)
  })

  it("links an existing member by address, and the session it starts opens that workspace and no other", async () => {
    const lee = await db.user.create({ data: { email: `lee@${DOMAIN}`, name: "Lee", passwordHash: "$argon2id$not-a-real-hash", emailVerifiedAt: new Date() } })
    createdUsers.push(lee.id)
    for (const [orgId, slug] of [[ws.orgId, ws.slug], [other.orgId, other.slug]] as const) {
      await db.membership.create({ data: { orgId, userId: lee.id, role: "AGENT", displayName: "Lee", joinedAt: new Date() } })
      await db.userOrgIndex.create({ data: { userId: lee.id, orgId, roleForDisplay: "AGENT", statusForDisplay: "ACTIVE", orgSlug: slug, orgName: slug, orgStatus: "ACTIVE" } })
    }
    const { cookies } = await signIn(`email=lee@${DOMAIN}`, { sub: "lee-sub", email: `lee@${DOMAIN}` })
    const linked = await db.auditLog.findFirst({ where: { orgId: ws.orgId, action: "SSO_IDENTITY_LINKED" } })
    expect(linked).not.toBeNull()

    const pgId = `pg_id=${cookies.get("pg_id") ?? ""}`
    const identity = await http().get("/api/v1/auth/identity").set("Cookie", pgId)
    expect(identity.body.sso).toEqual({ slug: ws.slug })
    // Acme's provider learns nothing of the person's other workspaces (M13 review).
    expect(identity.body.workspaces.map((w: { slug: string }) => w.slug)).toEqual([ws.slug])
    const elsewhere = await http().post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", pgId).send({ slug: other.slug })
    expect(elsewhere.status).toBe(403)
    expect(elsewhere.body.type).toMatch(/sso-session-scoped$/)
    expect((await http().post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", pgId).send({ slug: ws.slug })).status).toBe(200)

    // Nothing account-wide: an identity provider vouched for one workspace, not for the account.
    for (const [path, body] of [
      ["/api/v1/auth/passkeys/registration/options", { password: PASSWORD }],
      // Its own factors are not the provider's to try: a wrong code would lock them everywhere.
      ["/api/v1/auth/step-up", { slug: ws.slug, password: PASSWORD }],
      ["/api/v1/auth/passkeys/proof/options", {}],
      ["/api/v1/auth/mfa/enrol", { password: PASSWORD }],
      ["/api/v1/auth/password", { currentPassword: PASSWORD, newPassword: "a brand new passphrase" }],
      ["/api/v1/orgs", { name: "Mine", slug: `mine-${suffix}` }],
    ] as const) {
      const refused = await http().post(path).set(HEADERS).set("Cookie", pgId).send(body)
      expect(refused.status, path).toBe(403)
      expect(refused.body.type, path).toMatch(/sso-session-scoped$/)
    }
  })

  it("refuses an unverified address, one at another domain, and a callback from another browser or twice", async () => {
    expect((await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: `kim@${DOMAIN}`, emailVerified: false })).location).toMatch(/\/login\?sso=email$/)
    expect((await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: "kim@elsewhere.test" })).location).toMatch(/\/login\?sso=email$/)
    const stolen = await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: `kim@${DOMAIN}` }, { dropState: true })
    expect(stolen.location).toMatch(/\/login\?sso=expired$/)
    expect(stolen.cookies.has("pg_id")).toBe(false)

    const once = await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: `kim@${DOMAIN}` })
    const replay = await http().get(`${once.callback.pathname}${once.callback.search}`).set("Cookie", `pg_sso=${new URL(once.started.headers.location as string).searchParams.get("state") ?? ""}`)
    expect(replay.headers.location).toMatch(/\/login\?sso=expired$/)
  })

  it("refuses an ID token the provider's keys did not sign, or one for another client", async () => {
    idp.forge = { rogueKey: true }
    try {
      expect((await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: `kim@${DOMAIN}` })).location).toMatch(/\/login\?sso=denied$/)
    } finally {
      idp.forge = {}
    }
    idp.forge = { audience: "someone-else" }
    try {
      expect((await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: `kim@${DOMAIN}` })).location).toMatch(/\/login\?sso=denied$/)
    } finally {
      idp.forge = {}
    }
  })

  it("refuses a round trip another site started", async () => {
    const started = await http().get(`/api/v1/auth/sso/start?email=kim@${DOMAIN}`).set("Sec-Fetch-Site", "cross-site")
    expect(started.status).toBe(302)
    expect(started.headers.location).toMatch(/\/login\?sso=foreign$/)
    expect(cookiesOf(started).has("pg_sso")).toBe(false)
  })

  it("never revives a removed or disabled member", async () => {
    const kim = await db.user.findUniqueOrThrow({ where: { email: `kim@${DOMAIN}` } })
    await db.membership.update({ where: { orgId_userId: { orgId: ws.orgId, userId: kim.id } }, data: { status: "DISABLED" } })
    expect((await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: `kim@${DOMAIN}` })).location).toMatch(/\/login\?sso=inactive$/)
    await db.membership.update({ where: { orgId_userId: { orgId: ws.orgId, userId: kim.id } }, data: { status: "ACTIVE" } })
  })

  it("takes an unverified account's password before the provider's person gets it", async () => {
    const squatter = await db.user.create({ data: { email: `max@${DOMAIN}`, name: "Max", passwordHash: "$argon2id$squatter", emailVerifiedAt: null } })
    createdUsers.push(squatter.id)
    await signIn(`email=max@${DOMAIN}`, { sub: "max-sub", email: `max@${DOMAIN}` })
    const claimed = await db.user.findUniqueOrThrow({ where: { id: squatter.id } })
    expect(claimed.passwordHash).toBeNull()
    expect(claimed.emailVerifiedAt).not.toBeNull()
  })
})

describe("SSO required", () => {
  it("is refused before the domain and connection allow it, then admits non-owners only through the provider", async () => {
    const owner = await ownerBrowser()
    // The seeded agent's address is not at the domain: the provider can never sign them in, so it asks first.
    const asked = await owner.put("/org/sso/requirement", { required: true })
    expect(asked.status).toBe(409)
    expect(asked.body.type).toMatch(/sso-members-outside$/)
    const required = await owner.put("/org/sso/requirement", { required: true, confirm: true })
    expect(required.status).toBe(200)
    expect(required.body.required).toBe(true)
    // The domain cannot move from under it, nor the connection be turned off.
    expect((await owner.put("/org/domain", { domain: "moved.test" })).status).toBe(409)

    // The agent's password still signs them in, but opens nothing here.
    const login = await http().post("/api/v1/auth/login").set(HEADERS).send({ email: ws.people.agent.email, password: PASSWORD, slug: ws.slug })
    expect(login.body.session).toBeNull()
    const opened = await http().post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", ws.people.agent.pgId).send({ slug: ws.slug })
    expect(opened.status).toBe(403)
    expect(opened.body.type).toMatch(/sso-required$/)

    // The owner keeps their own credentials: the way back in when the provider is down.
    expect((await http().post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", ws.people.owner.pgId).send({ slug: ws.slug })).status).toBe(200)

    // Through the provider, the requester opens it.
    const { location } = await signIn(`slug=${ws.slug}`, { sub: "kim-sub", email: `kim@${DOMAIN}` })
    expect(location).toBe(`http://${ws.slug}.lvh.me:3001/`)

    expect((await owner.put("/org/sso/requirement", { required: false })).status).toBe(200)
  })
})

describe("step-up at the provider", () => {
  it("asks for a fresh login and stamps the pair, for the signed-in person only", async () => {
    const first = await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: `kim@${DOMAIN}` })
    const pgId = first.cookies.get("pg_id") ?? ""

    const proved = await signIn(`slug=${ws.slug}&intent=step-up&next=/settings`, { sub: "kim-sub", email: `kim@${DOMAIN}` }, { pgId })
    const authorize = new URL(proved.started.headers.location as string)
    expect(authorize.searchParams.get("prompt")).toBe("login")
    expect(authorize.searchParams.get("max_age")).toBe("0")
    expect(proved.location).toBe(`http://${ws.slug}.lvh.me:3001/settings`)
    const access = decodeJwt(proved.cookies.get(`pg_at_${ws.slug}`) ?? "")
    expect(typeof access.sua).toBe("number")
    expect(access.sso).toBe(true)

    // An old authentication at the provider is no proof.
    const stale = await signIn(`slug=${ws.slug}&intent=step-up`, { sub: "kim-sub", email: `kim@${DOMAIN}`, authTime: Math.floor(Date.now() / 1000) - 3600 }, { pgId })
    expect(stale.location).toBe(`http://${ws.slug}.lvh.me:3001/?sso=stale`)

    // Someone else at the provider cannot step up Kim's session.
    const lee = await signIn(`slug=${ws.slug}&intent=step-up`, { sub: "lee-sub", email: `lee@${DOMAIN}` }, { pgId })
    expect(lee.location).toBe(`http://${ws.slug}.lvh.me:3001/?sso=mismatch`)
    expect(lee.cookies.has(`pg_at_${ws.slug}`)).toBe(false)
  })
})

describe("withdrawing the provider", () => {
  it("ends every session it started when the connection is switched off", async () => {
    const { cookies } = await signIn(`email=kim@${DOMAIN}`, { sub: "kim-sub", email: `kim@${DOMAIN}` })
    const refresh = `pg_rt_${ws.slug}=${cookies.get(`pg_rt_${ws.slug}`) ?? ""}`
    const owner = await ownerBrowser()
    expect((await owner.put("/org/sso/connection", { issuer: idp.issuer, clientId: idp.clientId, defaultRole: "REQUESTER", enabled: false })).status).toBe(200)
    const renewed = await http().post("/api/v1/auth/refresh").set(HEADERS).set("Cookie", refresh).send({ slug: ws.slug })
    expect(renewed.status).toBe(401)
    // The old secret stands for the same issuer and client.
    expect((await owner.put("/org/sso/connection", { issuer: idp.issuer, clientId: idp.clientId, defaultRole: "REQUESTER", enabled: true })).status).toBe(200)
  })

  it("will not send the stored secret to a new issuer", async () => {
    const owner = await ownerBrowser()
    const refused = await owner.put("/org/sso/connection", { issuer: "http://127.0.0.1:1/realms/elsewhere", clientId: idp.clientId, defaultRole: "REQUESTER", enabled: true })
    expect(refused.status).toBe(400)
    expect(refused.body.errors[0].path).toBe("clientSecret")
  })
})

describe("a new issuer", () => {
  it("unlinks every identity, so the old provider's subjects mean nothing", async () => {
    const replacement = new FakeIdp()
    await replacement.start()
    try {
      const owner = await ownerBrowser()
      expect(await db.ssoIdentity.count({ where: { orgId: ws.orgId } })).toBeGreaterThan(0)
      const saved = await owner.put("/org/sso/connection", { issuer: replacement.issuer, clientId: replacement.clientId, clientSecret: replacement.clientSecret, defaultRole: "REQUESTER", enabled: true })
      expect(saved.status).toBe(200)
      expect(await db.ssoIdentity.count({ where: { orgId: ws.orgId } })).toBe(0)
      const audit = await db.auditLog.findFirstOrThrow({ where: { orgId: ws.orgId, action: "SSO_CONNECTION_SAVED" }, orderBy: { createdAt: "desc" } })
      expect(audit.diff).toMatchObject({ identitiesUnlinked: true })
    } finally {
      await replacement.stop()
    }
  })
})
