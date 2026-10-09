/**
 * The tenancy isolation suite (ENGINEERING.md §The tenancy isolation suite) —
 * the release gate, run by `pnpm test:tenancy`.
 *
 * Acme and Globex are seeded by the same `seedLookalikes` the development seed
 * uses — same team names, same display names and roles, the same address
 * invited to both — with a suffix per run, plus Dana, a member of both. Each
 * numbered `describe` below is the assertion of the same number in
 * ENGINEERING.md. Numbers 7, 10 and 11 are catalog assertions on the physical
 * schema and live in `packages/database` (`pnpm test:schema`), which
 * `pnpm test:tenancy` runs first; they are named here so the list is whole.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import {
  createPrismaClient,
  type Lookalikes,
  lookalikeEmails,
  NoTenantContextError,
  type PrismaClient,
  removeLookalikes,
  seedLookalikes,
} from "@patchgrid/database"
import { isTenantOwned } from "@patchgrid/database"
import { DEFAULT_SLA_TARGETS } from "@patchgrid/contracts"
import { type Job, UnrecoverableError } from "bullmq"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { PasswordService } from "../../src/auth/passwords/password.service"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { TenantDispatchService } from "../../src/jobs/dispatcher/tenant-dispatch"
import { MailProcessor } from "../../src/mail/mail.processor"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { PrismaService } from "../../src/prisma/prisma.service"
import { SlaScanProcessor } from "../../src/tickets/sweeps/sla-scan"
import { browser, HEADERS } from "../support/workspace"

const PASSWORD = "isolation suite password"
const suffix = `-${randomUUID().slice(0, 8)}`
const slugs = { acme: `acme${suffix}`, globex: `globex${suffix}` }
const origin = (slug: string) => `http://${slug}.lvh.me:3001`

let owner: PrismaClient
/** The application's role on a client WITHOUT the tenant extension: raw SQL, RLS alone. */
let appRole: PrismaClient
let app: INestApplication
let seed: Lookalikes

type Session = { pgId: string; access: Record<string, string> }
const sessions: Record<string, Session> = {}

const cookiesOf = (response: request.Response): string[] =>
  ((response.headers["set-cookie"] as unknown as string[] | undefined) ?? []).map((c) => c.split(";")[0] ?? "")

async function signIn(person: keyof Lookalikes["people"], slug: string): Promise<Session> {
  const existing = sessions[person]
  if (existing === undefined) {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .set(HEADERS)
      .send({ email: seed.people[person].email, password: PASSWORD, slug })
    const cookies = cookiesOf(response)
    const session = {
      pgId: cookies.find((c) => c.startsWith("pg_id=")) ?? "",
      access: { [slug]: cookies.find((c) => c.startsWith(`pg_at_${slug}=`)) ?? "" },
    }
    sessions[person] = session
    return session
  }
  if (existing.access[slug] === undefined) {
    const opened = await request(app.getHttpServer()).post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", existing.pgId).send({ slug })
    existing.access[slug] = cookiesOf(opened).find((c) => c.startsWith(`pg_at_${slug}=`)) ?? ""
  }
  return existing
}

const as = async (person: keyof Lookalikes["people"], slug: string) =>
  browser(app, origin(slug), (await signIn(person, slug)).access[slug] ?? "")

/** One statement on the app role's raw client, in a transaction scoped as asked. */
async function raw<T>(scope: string | null | "", sql: string): Promise<T[]> {
  return appRole.$transaction(async (tx) => {
    if (scope !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, scope)
    return tx.$queryRawUnsafe<T[]>(sql)
  })
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  appRole = createPrismaClient({ connectionString: requireEnv("DATABASE_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  // Listening on an ephemeral port: supertest then reuses it, rather than binding and closing
  // the shared server per request, which breaks requests made concurrently.
  await app.listen(0)

  seed = await seedLookalikes(owner, {
    slugs,
    emailSuffix: suffix,
    passwordHash: await app.get(PasswordService).hash(PASSWORD),
    slaTargets: DEFAULT_SLA_TARGETS,
  })

  // One audited change in each workspace, so the audit log has rows on both sides.
  for (const [person, slug, team] of [["alice", slugs.acme, seed.acme.teams.Security], ["gus", slugs.globex, seed.globex.teams.Security]] as const) {
    expect((await (await as(person, slug)).patch(`/teams/${team}`, { description: "Firewalls" })).status).toBe(200)
  }
})

afterAll(async () => {
  const users = await owner.user.findMany({ where: { email: { in: lookalikeEmails(suffix) } }, select: { id: true } })
  if (seed !== undefined) await removeLookalikes(owner, { orgIds: [seed.acme.id, seed.globex.id], userIds: users.map((u) => u.id) })
  await app?.close()
  await Promise.all([owner.$disconnect(), appRole.$disconnect()])
})

describe("1 · every list endpoint returns only the caller's org, for every role", () => {
  const lists: { path: string; table: string; ids: (body: unknown) => string[] }[] = [
    { path: "/members?limit=100", table: "Membership", ids: (b) => (b as { items: { id: string }[] }).items.map((m) => m.id) },
    { path: "/teams", table: "Team", ids: (b) => (b as { id: string }[]).map((t) => t.id) },
    { path: "/invitations", table: "Invitation", ids: (b) => (b as { id: string }[]).map((i) => i.id) },
    { path: "/org/audit?limit=100", table: "AuditLog", ids: (b) => (b as { items: { id: string }[] }).items.map((e) => e.id) },
    { path: "/tickets?view=open&limit=100", table: "Ticket", ids: (b) => (b as { items: { id: string }[] }).items.map((t) => t.id) },
    { path: "/categories", table: "Category", ids: (b) => (b as { id: string }[]).map((c) => c.id) },
  ]

  it.each([
    ["alice", "OWNER"],
    ["dana", "ADMIN"],
    ["sam", "AGENT"],
    ["rita", "REQUESTER"],
  ] as const)("as %s (%s at Acme)", async (person, role) => {
    const browserAt = await as(person, slugs.acme)
    let answered = 0
    for (const list of lists) {
      const response = await browserAt.get(list.path)
      if (response.status === 403) continue
      expect(response.status, list.path).toBe(200)
      answered += 1
      const ids = list.ids(response.body)
      expect(ids.length, list.path).toBeGreaterThan(0)
      const orgs = await owner.$queryRawUnsafe<{ orgId: string }[]>(
        `SELECT DISTINCT "orgId"::text AS "orgId" FROM "${list.table}" WHERE id = ANY($1::uuid[])`,
        ids,
      )
      expect(orgs, list.path).toEqual([{ orgId: seed.acme.id }])
    }
    expect(answered).toBeGreaterThan(0)
    expect((await browserAt.get("/me")).body).toMatchObject({ org: { id: seed.acme.id }, membership: { role } })
  })
})

describe("2 · another org's id is a 404, never a 403", () => {
  it("for reads and for every action, as Acme's admin", async () => {
    const dana = await as("dana", slugs.acme)
    const theirs = { member: seed.globex.members.tina ?? "", team: seed.globex.teams.Network, invitation: seed.globex.invitationId }
    const ours = { member: seed.acme.members.sam ?? "", team: seed.acme.teams.Network }
    // One at a time, each named, so a failure says which attempt leaked.
    const attempts: [string, () => Promise<request.Response>][] = [
      ["read a member", () => dana.get(`/members/${theirs.member}`)],
      ["read a team", () => dana.get(`/teams/${theirs.team}`)],
      ["change a role", () => dana.patch(`/members/${theirs.member}/role`, { role: "REQUESTER" })],
      ["disable", () => dana.post(`/members/${theirs.member}/disable`)],
      ["remove", () => dana.delete(`/members/${theirs.member}`)],
      ["revoke an invitation", () => dana.delete(`/invitations/${theirs.invitation}`)],
      ["rename a team", () => dana.patch(`/teams/${theirs.team}`, { name: "Hijacked" })],
      ["join their team", () => dana.put(`/teams/${theirs.team}/members/${ours.member}`)],
      ["pull their member into ours", () => dana.put(`/teams/${ours.team}/members/${theirs.member}`)],
      ["read a ticket", () => dana.get(`/tickets/${seed.globex.ticketId}`)],
      ["read its thread", () => dana.get(`/tickets/${seed.globex.ticketId}/comments`)],
      ["read its trail", () => dana.get(`/tickets/${seed.globex.ticketId}/audit`)],
      ["edit it", () => dana.patch(`/tickets/${seed.globex.ticketId}`, { version: 1, title: "Hijacked" })],
      ["move it on", () => dana.post(`/tickets/${seed.globex.ticketId}/transitions`, { action: "resolve", version: 1, comment: { body: "x", visibility: "PUBLIC" } })],
      ["comment on it", () => dana.post(`/tickets/${seed.globex.ticketId}/comments`, { body: "x", visibility: "PUBLIC" })],
      ["watch it", () => dana.put(`/tickets/${seed.globex.ticketId}/watchers/${ours.member}`)],
      ["file under their category", () => dana.post("/tickets", { type: "INCIDENT", title: "x", description: "y", impact: "LOW", urgency: "LOW", categoryId: seed.globex.categories.laptop })],
    ]
    for (const [what, attempt] of attempts) {
      // Filing under a foreign category is a validation answer about the field, never a write.
      expect((await attempt()).status, what).toBe(what === "file under their category" ? 400 : 404)
    }
    // And nothing moved on the other side.
    expect((await owner.membership.findUniqueOrThrow({ where: { id: theirs.member } })).status).toBe("ACTIVE")
    expect((await owner.team.findUniqueOrThrow({ where: { id: theirs.team } })).name).toBe("Network")
    expect(await owner.ticket.findUniqueOrThrow({ where: { id: seed.globex.ticketId } })).toMatchObject({ title: "VPN drops every hour", status: "IN_PROGRESS" })
    expect(await owner.comment.count({ where: { ticketId: seed.globex.ticketId } })).toBe(2)
  })
})

describe("3 · a token minted for one org, presented on another's subdomain, is a 403", () => {
  it("even tossed under the other workspace's cookie name", async () => {
    const acmeToken = ((await signIn("sam", slugs.acme)).access[slugs.acme] ?? "").split("=")[1] ?? ""
    const tossed = await browser(app, origin(slugs.globex), `pg_at_${slugs.globex}=${acmeToken}`).get("/me")
    expect(tossed.status).toBe(403)
    expect(tossed.body.type).toContain("tenant-mismatch")
  })
})

describe("4 · RLS holds when the repository does not", () => {
  it("an unscoped raw read under the other tenant's context sees none of this tenant's rows, in any tenant-owned table", async () => {
    const tables = (
      await owner.$queryRawUnsafe<{ relname: string }[]>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
      )
    )
      .map((r) => r.relname)
      .filter((t) => t !== "_prisma_migrations" && isTenantOwned(t))
    expect(tables).toEqual(
      expect.arrayContaining([
        "Membership",
        "Team",
        "TeamMembership",
        "Invitation",
        "AuditLog",
        "UsageCounter",
        "Ticket",
        "Comment",
        "TicketWatcher",
        "Category",
        "SLAPolicy",
        "TicketCounter",
      ])
    )

    for (const table of tables) {
      const sql = `SELECT count(*)::int AS n FROM "${table}" WHERE "orgId" = '${seed.acme.id}'`
      const [own] = await raw<{ n: number }>(seed.acme.id, sql)
      const [leaked] = await raw<{ n: number }>(seed.globex.id, sql)
      expect(own?.n, `${table} as Acme`).toBeGreaterThan(0)
      expect(leaked?.n, `${table} as Globex`).toBe(0)
    }
  })
})

describe("5 · WITH CHECK refuses a row written with a foreign orgId", () => {
  it("on the app role, with Globex's context set and Acme's orgId in the row", async () => {
    await expect(
      raw(seed.globex.id, `INSERT INTO "Team" (id, "orgId", name, "updatedAt") VALUES ('${randomUUID()}', '${seed.acme.id}', 'Planted', now())`),
    ).rejects.toThrow(/row-level security/)
  })
})

describe("6 · a tenant-owned model queried with no context throws", () => {
  it("rather than running unscoped", async () => {
    await expect(app.get(PrismaService).db.team.findMany()).rejects.toBeInstanceOf(NoTenantContextError)
  })
})

describe("7 · every tenant-owned table carries forced RLS and the template policy", () => {
  it.skip("asserted from the catalogs by `pnpm test:schema` (packages/database), which `pnpm test:tenancy` runs first", () => undefined)
})

describe("8 · background jobs carry their tenant", () => {
  it("a tenant-queue job whose payload lacks orgId is refused, never run without a tenant", async () => {
    const job = {
      id: "isolation/missing-org",
      data: { kind: "invite", to: "x@patchgrid.test", fromName: "Acme", params: {} },
    } as unknown as Job
    await expect(app.get(MailProcessor).process(job)).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("the dispatcher fans out one job per active org and skips suspended ones", async () => {
    const dispatch = app.get(TenantDispatchService)
    const both = await dispatch.fanOut("auto-close")
    expect(both).toEqual(expect.arrayContaining([seed.acme.id, seed.globex.id]))

    await owner.organization.update({ where: { id: seed.globex.id }, data: { status: "SUSPENDED" } })
    try {
      const fanned = await dispatch.fanOut("auto-close")
      expect(fanned).toContain(seed.acme.id)
      expect(fanned).not.toContain(seed.globex.id)
    } finally {
      await owner.organization.update({ where: { id: seed.globex.id }, data: { status: "ACTIVE" } })
    }
  })

  it("a sweep job without its tenant is refused, never run across tenants", async () => {
    const job = { id: "isolation/sweep-missing-org", data: { tick: 1 } } as unknown as Job
    await expect(app.get(SlaScanProcessor).process(job)).rejects.toBeInstanceOf(UnrecoverableError)
  })
})

describe("9 · quotas are per org, and atomic at the boundary", () => {
  it("one workspace at its seat limit refuses a promotion while the other, with room, accepts one", async () => {
    // Both FREE workspaces hold three seats: an owner, an agent and Dana.
    const alice = await as("alice", slugs.acme)
    const gus = await as("gus", slugs.globex)
    expect((await alice.patch(`/members/${seed.acme.members.rita}/role`, { role: "AGENT" })).status).toBe(402)
    expect((await gus.post(`/members/${seed.globex.members.tina}/disable`)).status).toBe(200)
    expect((await gus.patch(`/members/${seed.globex.members.rosa}/role`, { role: "AGENT" })).status).toBe(200)
    expect((await alice.patch(`/members/${seed.acme.members.rita}/role`, { role: "AGENT" })).status).toBe(402)
  })

  it("two simultaneous claims on the last seat: exactly one wins", async () => {
    const alice = await as("alice", slugs.acme)
    expect((await alice.post(`/members/${seed.acme.members.sam}/disable`)).status).toBe(200)
    const [promote, enable] = await Promise.all([
      alice.patch(`/members/${seed.acme.members.rita}/role`, { role: "AGENT" }),
      alice.post(`/members/${seed.acme.members.sam}/enable`),
    ])
    expect([promote.status, enable.status].toSorted()).toEqual([200, 402])
    const counter = await owner.usageCounter.findUniqueOrThrow({
      where: { orgId_period_metric: { orgId: seed.acme.id, period: "current", metric: "AGENT_SEATS" } },
    })
    expect(counter.value).toBe(3n)
  })
})

describe("10 · every FK between tenant-owned tables is composite on orgId", () => {
  it.skip("asserted from information_schema by `pnpm test:schema` (packages/database)", () => undefined)
})

describe("11 · physical schema: timestamptz, uuid ids, the app role's grants", () => {
  it.skip("asserted from the catalogs by `pnpm test:schema` (packages/database)", () => undefined)
})

describe("12 · with no tenant set, raw SQL sees nothing — and an empty setting is not an error", () => {
  it("no context: zero rows", async () => {
    const [row] = await raw<{ n: number }>(null, `SELECT count(*)::int AS n FROM "Membership"`)
    expect(row?.n).toBe(0)
  })

  it("an empty string: zero rows, not invalid input syntax for type uuid", async () => {
    const [row] = await raw<{ n: number }>("", `SELECT count(*)::int AS n FROM "Membership"`)
    expect(row?.n).toBe(0)
  })
})

describe("13 · one account, two workspaces, both sessions alive", () => {
  it("Dana's two cookies each answer as their own workspace and role", async () => {
    const dana = await signIn("dana", slugs.acme)
    await signIn("dana", slugs.globex)
    const jar = `${dana.access[slugs.acme] ?? ""}; ${dana.access[slugs.globex] ?? ""}`
    const [inAcme, inGlobex] = await Promise.all([
      browser(app, origin(slugs.acme), jar).get("/me"),
      browser(app, origin(slugs.globex), jar).get("/me"),
    ])
    expect(inAcme.body).toMatchObject({ org: { id: seed.acme.id }, membership: { role: "ADMIN" } })
    expect(inGlobex.body).toMatchObject({ org: { id: seed.globex.id }, membership: { role: "AGENT" } })
  })
})
