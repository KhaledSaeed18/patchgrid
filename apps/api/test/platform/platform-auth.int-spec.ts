/**
 * The platform credential end to end (ADR-0040), through the booted app:
 * a password that leads only to a second factor, enrolment with its recovery
 * codes shown once, a one-hour session that reaches only `/platform`, a code
 * that works once, and a grant whose revocation ends everything.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { codeAt } from "../../src/auth/mfa/totp"
import { PasswordService } from "../../src/auth/passwords/password.service"
import { HEADERS } from "../support/workspace"

const ADMIN_ORIGIN = "http://admin.lvh.me:3001"
const PASSWORD = "operator-password-123"
let db: PrismaClient
let app: INestApplication
const operator = { email: `op-${randomUUID().slice(0, 8)}@patchgrid.test`, userId: "", adminId: "" }
const plain = { email: `plain-${randomUUID().slice(0, 8)}@patchgrid.test` }

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  const passwordHash = await app.get(PasswordService).hash(PASSWORD)
  const user = await db.user.create({ data: { email: operator.email, name: "Olga Operator", passwordHash, emailVerifiedAt: new Date() } })
  operator.userId = user.id
  operator.adminId = (await db.platformAdmin.create({ data: { userId: user.id } })).id
  await db.user.create({ data: { email: plain.email, name: "Plain", passwordHash, emailVerifiedAt: new Date() } })
})

afterAll(async () => {
  await db.platformAuditLog.deleteMany({ where: { platformAdminId: operator.adminId } })
  await db.platformAdmin.deleteMany({ where: { id: operator.adminId } })
  await db.user.deleteMany({ where: { email: { in: [operator.email, plain.email] } } })
  await app?.close()
  await db.$disconnect()
})

/** A browser on admin.: its Origin, the CSRF header, and whatever cookies it holds. */
function admin(jar: Map<string, string> = new Map()) {
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
  const keep = (response: request.Response) => {
    const set = response.headers["set-cookie"] as unknown as string[] | undefined
    for (const line of set ?? []) {
      const [pair] = line.split(";")
      const [name, value] = (pair ?? "").split("=")
      if (name !== undefined) {
        if (value === undefined || value === "") jar.delete(name)
        else jar.set(name, value)
      }
    }
    return response
  }
  const http = () => request(app.getHttpServer())
  return {
    jar,
    post: async (path: string, body: object = {}) =>
      keep(await http().post(`/api/v1/platform${path}`).set(HEADERS).set("Origin", ADMIN_ORIGIN).set("Cookie", cookie()).send(body)),
    get: async (path: string) => keep(await http().get(`/api/v1/platform${path}`).set("Origin", ADMIN_ORIGIN).set("Cookie", cookie())),
  }
}

let secret = ""
let recovery: string[] = []

describe("signing in", () => {
  it("refuses a wrong password, a non-operator and another surface alike", async () => {
    const browser = admin()
    const wrong = await browser.post("/auth/login", { email: operator.email, password: "nope-nope-nope" })
    const notAdmin = await browser.post("/auth/login", { email: plain.email, password: PASSWORD })
    expect([wrong.status, notAdmin.status]).toEqual([401, 401])
    expect(wrong.body.detail).toBe(notAdmin.body.detail)
    const elsewhere = await request(app.getHttpServer())
      .post("/api/v1/platform/auth/login")
      .set(HEADERS)
      .set("Origin", "http://acme.lvh.me:3001")
      .send({ email: operator.email, password: PASSWORD })
    expect(elsewhere.status).toBe(403)
  })

  it("enrols a factor before any session, and shows the recovery codes once", async () => {
    const browser = admin()
    const login = await browser.post("/auth/login", { email: operator.email, password: PASSWORD })
    expect(login.body).toEqual({ next: "enrol" })
    expect((await browser.get("/auth/me")).status).toBe(401)
    const enrol = await browser.post("/auth/mfa/enrol")
    expect(enrol.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//)
    secret = enrol.body.secret as string
    expect((await browser.post("/auth/mfa/confirm", { code: "000000" })).status).toBe(400)
    const confirm = await browser.post("/auth/mfa/confirm", { code: codeAt(secret, new Date()) })
    expect(confirm.status).toBe(200)
    recovery = confirm.body.recoveryCodes as string[]
    expect(recovery).toHaveLength(10)
    // The session cookie reaches only the platform routes.
    expect(String(confirm.headers["set-cookie"])).toMatch(/pg_pa=[^;]+;.*Path=\/api\/v1\/platform/)
    const me = await browser.get("/auth/me")
    expect(me.body).toMatchObject({ platformAdminId: operator.adminId, email: operator.email })
    const stored = await db.userMfaFactor.findFirstOrThrow({ where: { userId: operator.userId } })
    expect(stored.secretEncrypted).not.toContain(secret)
  })

  it("verifies with a code once, and with a recovery code once", async () => {
    const first = admin()
    expect((await first.post("/auth/login", { email: operator.email, password: PASSWORD })).body).toEqual({ next: "verify" })
    // The code that confirmed enrolment is spent: the same step never works twice.
    const replay = await first.post("/auth/mfa", { code: codeAt(secret, new Date()) })
    expect(replay.status).toBe(400)
    const code = recovery[0] ?? ""
    expect((await first.post("/auth/mfa", { recoveryCode: code.toUpperCase() })).status).toBe(204)
    expect((await first.get("/auth/me")).status).toBe(200)

    const second = admin()
    await second.post("/auth/login", { email: operator.email, password: PASSWORD })
    expect((await second.post("/auth/mfa", { recoveryCode: code })).status).toBe(400)
    const audit = await db.platformAuditLog.findMany({ where: { platformAdminId: operator.adminId }, select: { action: true } })
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["PLATFORM_MFA_ENROLLED", "PLATFORM_SIGNED_IN", "PLATFORM_RECOVERY_CODE_USED"]),
    )
  })

  it("signs out everywhere, and a revoked grant ends logins", async () => {
    // `there` first: a recovery code ends the sessions before it, so the later sign-in is the one kept.
    const there = admin()
    await there.post("/auth/login", { email: operator.email, password: PASSWORD })
    expect((await there.post("/auth/mfa", { recoveryCode: recovery[2] ?? "" })).status).toBe(204)
    const here = admin()
    await here.post("/auth/login", { email: operator.email, password: PASSWORD })
    expect((await here.post("/auth/mfa", { recoveryCode: recovery[1] ?? "" })).status).toBe(204)
    const copied = new Map(here.jar)
    expect((await here.post("/auth/logout")).status).toBe(204)
    // Every session ends: the other browser's, and a copy of the cookie taken before signing out.
    expect((await there.get("/auth/me")).status).toBe(401)
    expect((await admin(copied).get("/auth/me")).status).toBe(401)

    await db.platformAdmin.update({ where: { id: operator.adminId }, data: { revokedAt: new Date() } })
    expect((await admin().post("/auth/login", { email: operator.email, password: PASSWORD })).status).toBe(401)
  })

  it("locks the factor after five wrong codes, whatever address they came from, and says so (ADR-0029)", async () => {
    await db.platformAdmin.update({ where: { id: operator.adminId }, data: { revokedAt: null } })
    const browser = admin()
    await browser.post("/auth/login", { email: operator.email, password: PASSWORD })
    for (let i = 0; i < 5; i += 1) expect((await browser.post("/auth/mfa", { code: "000000" })).status).toBe(400)
    // Even a good recovery code waits out the hour, as would a good TOTP code.
    const locked = await browser.post("/auth/mfa", { recoveryCode: recovery[3] ?? "" })
    expect(locked.status).toBe(429)
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(3000)
    expect(await db.platformAuditLog.count({ where: { platformAdminId: operator.adminId, action: "PLATFORM_MFA_LOCKED" } })).toBe(1)
  })
})
