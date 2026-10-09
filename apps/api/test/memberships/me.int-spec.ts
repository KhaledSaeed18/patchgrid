/**
 * `GET /me` through the booted app, and the M1 exit criterion it makes
 * visible: one account holding two workspaces open at once, each answering as
 * its own tenant with its own role, neither cookie usable on the other.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, HEADERS, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let acme: Workspace<"dana" | "requester">
let globex: Workspace<"owner">

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  // Listening on an ephemeral port: supertest then reuses it, rather than binding and closing
  // the shared server per request, which breaks requests made concurrently.
  await app.listen(0)

  acme = await seedWorkspace(app, db, { prefix: "acme", people: { dana: "ADMIN", requester: "REQUESTER" }, teams: ["Network"] })
  globex = await seedWorkspace(app, db, { prefix: "globex", people: { owner: "OWNER" } })
  await db.teamMembership.create({
    data: { orgId: acme.orgId, teamId: acme.teams.Network ?? "", membershipId: acme.people.dana.membershipId, isLead: true },
  })
  // Dana also works at Globex, as an agent.
  const dana = acme.people.dana
  await db.membership.create({ data: { orgId: globex.orgId, userId: dana.userId, role: "AGENT", displayName: "dana", joinedAt: new Date() } })
  await db.userOrgIndex.create({
    data: { userId: dana.userId, orgId: globex.orgId, roleForDisplay: "AGENT", statusForDisplay: "ACTIVE", orgSlug: globex.slug, orgName: "Globex", orgStatus: "ACTIVE" },
  })
})

afterAll(async () => {
  await db.membership.deleteMany({ where: { orgId: globex.orgId, userId: acme.people.dana.userId } })
  await db.userOrgIndex.deleteMany({ where: { orgId: globex.orgId, userId: acme.people.dana.userId } })
  await globex?.cleanup()
  await acme?.cleanup()
  await app?.close()
  await db.$disconnect()
})

describe("GET /me", () => {
  it("answers as the member of this workspace, with teams and role-level permissions", async () => {
    const me = await browser(app, acme.origin, acme.people.dana.access).get("/me")
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({
      user: { email: acme.people.dana.email },
      membership: { id: acme.people.dana.membershipId, role: "ADMIN" },
      org: { id: acme.orgId, slug: acme.slug, plan: "FREE", agentVisibility: "ALL_TICKETS" },
      teams: [{ name: "Network", isLead: true }],
    })
    expect(me.body.permissions).toContain("member:invite")
    expect(me.body.permissions).not.toContain("org:delete")

    const requester = await browser(app, acme.origin, acme.people.requester.access).get("/me")
    expect(requester.body.permissions).not.toContain("team:read")
    expect(requester.body.teams).toEqual([])
  })

  it("lists both workspaces for the picker, from the identity cookie alone", async () => {
    const identity = await request(app.getHttpServer()).get("/api/v1/auth/identity").set("Cookie", acme.people.dana.pgId)
    expect(identity.status).toBe(200)
    expect(identity.body.user.email).toBe(acme.people.dana.email)
    expect(identity.body.workspaces.map((w: { slug: string; role: string }) => [w.slug, w.role]).toSorted()).toEqual(
      [[acme.slug, "ADMIN"], [globex.slug, "AGENT"]].toSorted(),
    )
    expect((await request(app.getHttpServer()).get("/api/v1/auth/identity")).status).toBe(401)
  })

  it("holds two workspaces open at once: one account, two cookies, two answers", async () => {
    const opened = await request(app.getHttpServer())
      .post("/api/v1/auth/sessions")
      .set(HEADERS)
      .set("Cookie", acme.people.dana.pgId)
      .send({ slug: globex.slug })
    const globexAccess = ((opened.headers["set-cookie"] as unknown as string[]) ?? [])
      .map((c) => c.split(";")[0] ?? "")
      .find((c) => c.startsWith(`pg_at_${globex.slug}=`)) ?? ""

    // Both tabs, both cookies in the jar, each request naming its workspace by Origin.
    const jar = `${acme.people.dana.access}; ${globexAccess}`
    const [inAcme, inGlobex] = await Promise.all([
      browser(app, acme.origin, jar).get("/me"),
      browser(app, globex.origin, jar).get("/me"),
    ])
    expect(inAcme.body).toMatchObject({ org: { id: acme.orgId }, membership: { role: "ADMIN" } })
    expect(inGlobex.body).toMatchObject({ org: { id: globex.orgId }, membership: { role: "AGENT" }, teams: [] })
    expect(inGlobex.body.permissions).not.toContain("member:invite")

    // Neither workspace's cookie opens the other.
    expect((await browser(app, globex.origin, acme.people.dana.access).get("/me")).status).toBe(401)
  })

  it("is a session error, not data, without a membership", async () => {
    expect((await browser(app, acme.origin, "").get("/me")).status).toBe(401)
  })
})
