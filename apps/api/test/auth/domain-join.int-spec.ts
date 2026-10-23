/**
 * Joining by verified domain (TENANCY.md §5), through the booted app: a
 * person whose verified address is at a workspace's proved domain is offered
 * it in the picker, joins it at the owner's role, and opens it. Nobody else
 * is offered it — another domain, a removed member — and turning it off, or
 * requiring SSO, closes it.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import process from "node:process"
import request from "supertest"
import { afterAll, beforeAll, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { PasswordService } from "../../src/auth/passwords/password.service"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { HEADERS, PASSWORD, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"owner">
const suffix = randomUUID().slice(0, 8)
const domain = `join-${suffix}.test`
const people: { id: string; email: string }[] = []

beforeAll(async () => {
  process.env.WORKER_MODE = "api"
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "domjoin", people: { owner: "OWNER" } })
  await db.organization.update({
    where: { id: ws.orgId },
    data: { domain, domainVerifiedAt: new Date(), allowDomainJoin: true, defaultJoinRole: "REQUESTER" },
  })
})

afterAll(async () => {
  await db.userOrgIndex.deleteMany({ where: { userId: { in: people.map((p) => p.id) } } })
  await ws?.cleanup()
  await db.refreshToken.deleteMany({ where: { userId: { in: people.map((p) => p.id) } } })
  await db.user.deleteMany({ where: { id: { in: people.map((p) => p.id) } } })
  await app?.close()
  await db.$disconnect()
  delete process.env.WORKER_MODE
})

/** A verified account at `at`, signed in with no workspace: its `pg_id`. */
async function person(local: string, at: string): Promise<string> {
  const email = `${local}-${suffix}@${at}`
  const user = await db.user.create({
    data: { email, name: local, passwordHash: await app.get(PasswordService).hash(PASSWORD), emailVerifiedAt: new Date() },
  })
  people.push({ id: user.id, email })
  const login = await request(app.getHttpServer()).post("/api/v1/auth/login").set(HEADERS).send({ email, password: PASSWORD })
  return (login.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("pg_id="))?.split(";")[0] ?? ""
}
const identity = (pgId: string) => request(app.getHttpServer()).get("/api/v1/auth/identity").set(HEADERS).set("Cookie", pgId)
const join = (pgId: string, slug: string) =>
  request(app.getHttpServer()).post("/api/v1/auth/workspaces/join").set(HEADERS).set("Cookie", pgId).send({ slug })

it("offers the workspace to an address at its proved domain, joins it as a requester, and opens it", async () => {
  const pgId = await person("ana", domain)
  expect((await identity(pgId)).body.joinable).toEqual({ slug: ws.slug, name: expect.any(String), role: "REQUESTER" })

  const joined = await join(pgId, ws.slug)
  expect(joined.status).toBe(200)
  expect(joined.body).toEqual({ slug: ws.slug, role: "REQUESTER" })
  const opened = await request(app.getHttpServer()).post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", pgId).send({ slug: ws.slug })
  expect(opened.status).toBe(200)

  const after = (await identity(pgId)).body
  expect(after.joinable).toBeNull()
  expect(after.workspaces.map((w: { slug: string }) => w.slug)).toContain(ws.slug)
  expect((await join(pgId, ws.slug)).status).toBe(404)
  expect(await db.auditLog.count({ where: { orgId: ws.orgId, action: "MEMBER_JOINED" } })).toBeGreaterThanOrEqual(1)
})

it("offers nothing to another domain, and lets no removed member back in", async () => {
  const outsider = await person("otto", "elsewhere.test")
  expect((await identity(outsider)).body.joinable).toBeNull()
  expect((await join(outsider, ws.slug)).status).toBe(404)

  const pgId = await person("rem", domain)
  expect((await join(pgId, ws.slug)).status).toBe(200)
  const userId = people.at(-1)?.id ?? ""
  await db.membership.updateMany({ where: { orgId: ws.orgId, userId }, data: { status: "REMOVED" } })
  await db.userOrgIndex.updateMany({ where: { orgId: ws.orgId, userId }, data: { statusForDisplay: "REMOVED" } })
  expect((await identity(pgId)).body.joinable).toBeNull()
  expect((await join(pgId, ws.slug)).status).toBe(404)
})

it("closes when the owner turns it off", async () => {
  await db.organization.update({ where: { id: ws.orgId }, data: { allowDomainJoin: false } })
  const pgId = await person("late", domain)
  expect((await identity(pgId)).body.joinable).toBeNull()
  expect((await join(pgId, ws.slug)).status).toBe(404)
})
