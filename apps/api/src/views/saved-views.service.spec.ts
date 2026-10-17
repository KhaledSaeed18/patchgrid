import { describe, expect, it, vi } from "vitest"

import type { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem, ValidationProblem } from "../common/problems/problem.exception"
import type { PrismaService } from "../prisma/prisma.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import type { SavedViewRepository, SavedViewRow } from "./repositories/saved-view.repository"
import { SavedViewsService } from "./saved-views.service"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const TEAM = "0190b2f0-0000-7000-8000-0000000000t1"
const OTHER_TEAM = "0190b2f0-0000-7000-8000-0000000000t2"

const row = (over: Partial<SavedViewRow> = {}): SavedViewRow => ({
  id: "v-1",
  name: "Critical open",
  query: { view: "open", priority: "CRITICAL", sort: "newest" },
  teamId: null,
  team: null,
  owner: { id: "m-author", displayName: "Author" },
  ...over,
})

function harness(options: { membershipId?: string; role?: "AGENT" | "ADMIN" | "REQUESTER"; leads?: string[]; stored?: SavedViewRow | null; owned?: number; taken?: boolean } = {}) {
  const actor = {
    kind: "member",
    orgId: ORG,
    membershipId: options.membershipId ?? "m-author",
    userId: "u-1",
    role: options.role ?? "AGENT",
    teamIds: [TEAM],
    leadOfTeamIds: options.leads ?? [],
  }
  const views = {
    listFor: vi.fn(async () => [row(), row({ id: "v-2", query: { view: "nonsense" } })]),
    find: vi.fn(async () => options.stored ?? null),
    lockOwner: vi.fn(async () => undefined),
    countOwned: vi.fn(async () => options.owned ?? 0),
    create: vi.fn(async (_o: string, data: { teamId: string | null; name: string; query: object }) =>
      options.taken === true ? null : row({ name: data.name, teamId: data.teamId, team: data.teamId === null ? null : { id: data.teamId, name: "IT" }, query: data.query }),
    ),
    remove: vi.fn(async () => true),
  }
  const service = new SavedViewsService(
    views as unknown as SavedViewRepository,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
  )
  return { service, views }
}

const request = { name: "Critical open", query: { view: "open" as const, priority: "CRITICAL" as const, sort: "newest" as const } }

describe("SavedViewsService", () => {
  it("saves a query, shared only with a team its author is in", async () => {
    const h = harness()
    expect(await h.service.create({ ...request, teamId: TEAM })).toMatchObject({ team: { id: TEAM }, removable: true })
    await expect(harness().service.create({ ...request, teamId: OTHER_TEAM })).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("refuses a name its author already used, and a twenty-first view", async () => {
    await expect(harness({ taken: true }).service.create(request)).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness({ owned: 20 }).service.create(request)).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("lists what parses, and leaves out a stored query that no longer does", async () => {
    expect((await harness().service.list()).map((v) => v.id)).toEqual(["v-1"])
  })

  it("lets its author remove it; for a shared one, also the team's lead or an admin", async () => {
    const shared = row({ teamId: TEAM, team: { id: TEAM, name: "IT" } })
    await expect(harness({ stored: row() }).service.remove("v-1")).resolves.toBeUndefined()
    await expect(harness({ membershipId: "m-colleague", stored: shared }).service.remove("v-1")).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness({ membershipId: "m-lead", leads: [TEAM], stored: shared }).service.remove("v-1")).resolves.toBeUndefined()
    await expect(harness({ membershipId: "m-admin", role: "ADMIN", stored: shared }).service.remove("v-1")).resolves.toBeUndefined()
  })

  it("answers 404 for a view the reader cannot see: someone else's own, or another team's", async () => {
    await expect(harness({ membershipId: "m-colleague", stored: row() }).service.remove("v-1")).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(harness({ membershipId: "m-colleague", stored: row({ teamId: OTHER_TEAM }) }).service.remove("v-1")).rejects.toBeInstanceOf(NotFoundProblem)
  })

  it("is an agent's", async () => {
    await expect(harness({ role: "REQUESTER" }).service.list()).rejects.toBeInstanceOf(NotPermittedProblem)
  })
})
