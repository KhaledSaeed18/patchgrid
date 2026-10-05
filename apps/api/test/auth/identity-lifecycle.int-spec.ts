/**
 * Signup → verification link → session → password reset → password change,
 * through the booted AppModule with the real queue and worker, the mail
 * provider swapped for a recorder so the links can be read back out.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER, type OutboundMail } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"

const suffix = randomUUID().slice(0, 8)
const email = `sam-${suffix}@probe.test`
const password = "correct horse battery staple"
const newPassword = "a brand new password, longer"
const HEADERS = { "Content-Type": "application/json", "X-Requested-With": "patchgrid" }

let owner: PrismaClient
let app: INestApplication
const recorder = new RecordingMailProvider()

async function mailTo(address: string, kind: RegExp): Promise<OutboundMail> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = recorder.sent.find((m) => m.to === address && kind.test(m.subject))
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`no mail matching ${String(kind)} reached ${address}`)
}
const tokenIn = (mail: OutboundMail): string => {
  const match = /token=([A-Za-z0-9_-]{43})/.exec(mail.html)
  if (match?.[1] === undefined) throw new Error("no token in mail")
  return match[1]
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(recorder)
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.init()
})

afterAll(async () => {
  const user = await owner.user.findUnique({ where: { email } })
  if (user !== null) {
    await owner.refreshToken.deleteMany({ where: { userId: user.id } })
    await owner.emailVerification.deleteMany({ where: { userId: user.id } })
    await owner.passwordResetToken.deleteMany({ where: { userId: user.id } })
    await owner.user.delete({ where: { id: user.id } })
  }
  await app.close()
  await owner.$disconnect()
})

const http = () => request(app.getHttpServer())
const post = (path: string, body: object, cookie?: string) => {
  const req = http().post(`/api/v1/auth/${path}`).set(HEADERS)
  return (cookie === undefined ? req : req.set("Cookie", cookie)).send(body)
}

describe("identity lifecycle", () => {
  let pgId = ""

  it("signs up with a 202, creating an unverified account and mailing a link", async () => {
    expect((await post("signup", { email: email.toUpperCase(), password, name: "Sam" })).status).toBe(202)
    const account = await owner.user.findUnique({ where: { email } })
    expect(account?.emailVerifiedAt).toBeNull()
    expect(account?.passwordHash?.startsWith("$argon2id$")).toBe(true)
    const mail = await mailTo(email, /Verify/)
    expect(mail.from).toEqual({ name: "Patchgrid", address: "notifications@patchgrid.test" })
    expect(mail.text).toContain("verify-email?token=")
  })

  it("refuses to log in before verification, identically to a wrong password", async () => {
    const before = await post("login", { email, password })
    expect(before.status).toBe(401)
    expect(before.body.detail).toBe("Invalid email or password")
  })

  it("answers a second signup with 202 and re-sends the link, keeping the first password", async () => {
    const sentBefore = recorder.sent.length
    expect((await post("signup", { email, password: "something else entirely", name: "Sam" })).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(recorder.sent.slice(sentBefore).filter((m) => /Verify/.test(m.subject))).toHaveLength(1)
  })

  it("verifies through the latest link, starting the session; the earlier link is void", async () => {
    const links = recorder.sent.filter((m) => m.to === email && /Verify/.test(m.subject))
    const [first, latest] = [links[0], links[links.length - 1]]
    if (first === undefined || latest === undefined) throw new Error("expected two links")

    expect((await post("verify-email", { token: tokenIn(first) })).status).toBe(401)
    const verified = await post("verify-email", { token: tokenIn(latest) })
    expect(verified.status).toBe(200)
    expect(verified.body.user.email).toBe(email)
    expect(verified.body.workspaces).toEqual([])
    const setCookie = (verified.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("pg_id="))
    expect(setCookie).toBeDefined()
    pgId = setCookie?.split(";")[0] ?? ""

    expect((await post("verify-email", { token: tokenIn(latest) })).status).toBe(401)
    expect((await owner.user.findUnique({ where: { email } }))?.emailVerifiedAt).not.toBeNull()
  })

  it("logs in once verified", async () => {
    expect((await post("login", { email, password })).status).toBe(200)
  })

  it("answers a reset request with 202 for anyone, mails only the account, and the link sets the password", async () => {
    expect((await post("password-reset", { email: `nobody-${suffix}@probe.test` })).status).toBe(202)
    expect((await post("password-reset", { email })).status).toBe(202)
    const mail = await mailTo(email, /Reset/)
    const token = tokenIn(mail)

    expect((await post("password-reset/confirm", { token, password: newPassword })).status).toBe(204)
    expect((await post("password-reset/confirm", { token, password: newPassword })).status).toBe(401)
    expect((await post("login", { email, password })).status).toBe(401)
    expect((await post("login", { email, password: newPassword })).status).toBe(200)
    // Every session the account had is gone, the pg_id from verification included.
    expect((await post("sessions", { slug: "nope-nope" }, pgId)).status).toBe(401)
  })

  it("changes the password for a pg_id holder and ends every session", async () => {
    const login = await post("login", { email, password: newPassword })
    const cookie = (login.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("pg_id="))?.split(";")[0] ?? ""
    expect((await post("password", { currentPassword: "wrong wrong wrong", newPassword: password }, cookie)).status).toBe(403)
    const changed = await post("password", { currentPassword: newPassword, newPassword: password }, cookie)
    expect(changed.status).toBe(204)
    expect((await post("sessions", { slug: "nope-nope" }, cookie)).status).toBe(401)
    expect((await post("login", { email, password })).status).toBe(200)
  })

  it("requires the CSRF header on every identity mutation", async () => {
    const response = await http().post("/api/v1/auth/signup").set("Content-Type", "application/json").send({ email, password, name: "x" })
    expect(response.status).toBe(403)
  })
})
