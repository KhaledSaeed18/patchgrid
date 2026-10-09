import type { Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../auth/actor"
import type { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import type { CategoriesService } from "../categories/categories.service"
import { FixedClock } from "../common/clock/clock"
import {
  ConflictProblem,
  InvalidTransitionProblem,
  NotPermittedProblem,
  StaleWriteProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import type { MembershipRepository } from "../memberships/repositories/membership.repository"
import type { PrismaService } from "../prisma/prisma.service"
import type { QuotaService } from "../quota/quota.service"
import type { SlaPoliciesService } from "../sla/sla-policies.service"
import type { TeamRepository } from "../teams/repositories/team.repository"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import type { CommentRepository } from "./repositories/comment.repository"
import type { TicketRepository, TicketRow, TicketSummaryRow } from "./repositories/ticket.repository"
import type { LoadedTicket, TicketAccess } from "./ticket-access"
import { TicketsService } from "./tickets.service"

const NOW = new Date("2026-10-09T12:00:00Z")
const ORG = "o-1"
const POLICY = { id: "p-high", ticketType: "INCIDENT", priority: "HIGH", responseTargetMinutes: 30, resolutionTargetMinutes: 480, responseWarningMinutes: 10, resolutionWarningMinutes: 60 } as const

function row(over: Partial<TicketRow> = {}): TicketRow {
  return {
    id: "t-1",
    orgId: ORG,
    number: 1,
    type: "INCIDENT",
    title: "Laptop",
    description: "Broken",
    status: "IN_PROGRESS",
    version: 3,
    impact: "MEDIUM",
    urgency: "HIGH",
    priority: "HIGH",
    source: "PORTAL",
    categoryId: null,
    requesterMembershipId: "m-req",
    assigneeMembershipId: "m-agent",
    teamId: null,
    slaPolicyId: "p-high",
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    category: null,
    requester: { id: "m-req", displayName: "Req" },
    assignee: { id: "m-agent", displayName: "Agent" },
    team: null,
    responseClockStartedAt: NOW,
    resolutionClockStartedAt: NOW,
    respondedAt: null,
    resolvedAt: null,
    closedAt: null,
    pausedAt: null,
    pausedMinutes: 0,
    respondBy: null,
    resolveBy: null,
    responseBreached: false,
    resolutionBreached: false,
    responseWarningSentAt: null,
    resolutionWarningSentAt: null,
    reopenCount: 0,
    ...over,
  }
}

function harness(
  role: Role,
  ticket: TicketRow = row(),
  options: { versionMatches?: boolean; branches?: TicketSummaryRow[][]; ownTeamOnly?: boolean; teamIds?: string[]; byNumber?: TicketSummaryRow[] } = {},
) {
  const calls: string[] = []
  const actor: MemberActor = { kind: "member", userId: "u", orgId: ORG, membershipId: role === "REQUESTER" ? "m-req" : "m-agent", role, teamIds: options.teamIds ?? ["team-a"], leadOfTeamIds: [] }
  const permissions = new PermissionService()
  const loaded = (): LoadedTicket => ({
    row: ticket,
    subject: { own: ticket.requesterMembershipId === actor.membershipId, watch: false, scope: role !== "REQUESTER", ticketType: ticket.type, ticketStatus: ticket.status },
    relation: { role, isRequester: ticket.requesterMembershipId === actor.membershipId, isAssignee: ticket.assigneeMembershipId === actor.membershipId, ticketHasAssignee: ticket.assigneeMembershipId !== null },
  })
  const branchResults = [...(options.branches ?? [])]
  const tickets = {
    nextNumber: vi.fn(async () => {
      calls.push("number")
      return 42
    }),
    create: vi.fn(async () => "t-new"),
    updateVersioned: vi.fn(async () => options.versionMatches ?? true),
    listBranch: vi.fn(async () => branchResults.shift() ?? []),
    findByNumber: vi.fn(async () => options.byNumber ?? []),
    search: vi.fn(async () => [row({ id: "t-text" })]),
  }
  const service = new TicketsService(
    tickets as unknown as TicketRepository,
    { create: vi.fn(async () => ({ id: "c-1", visibility: "PUBLIC" })) } as unknown as CommentRepository,
    { load: vi.fn(async () => loaded()) } as unknown as TicketAccess,
    { findById: async (_o: string, id: string) => (id === "m-ghost" ? null : { id, status: "ACTIVE", role: id === "m-req" ? "REQUESTER" : "AGENT" }) } as unknown as MembershipRepository,
    { findById: async (_o: string, id: string) => ({ id, isActive: id !== "team-dead" }) } as unknown as TeamRepository,
    { routeTeam: async () => "team-a", list: async () => [{ id: "cat-1" }] } as unknown as CategoriesService,
    {
      policyFor: async () => {
        calls.push("policy")
        return POLICY
      },
    } as unknown as SlaPoliciesService,
    permissions,
    { requireTenantActor: () => actor } as unknown as ActorService,
    {
      requireOrgId: () => ORG,
      organization: () => ({ agentVisibility: options.ownTeamOnly === true ? "OWN_TEAM_ONLY" : "ALL_TICKETS" }),
    } as unknown as TenantContextService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    { record: async () => undefined } as unknown as AuditService,
    {
      consume: async () => {
        calls.push("quota")
      },
    } as unknown as QuotaService,
    new FixedClock(NOW),
  )
  // `get` re-reads through the access layer; the spec only cares that it is reached.
  vi.spyOn(service, "get").mockResolvedValue({} as never)
  return { service, tickets, calls }
}

const create = { type: "INCIDENT" as const, title: "Laptop", description: "Broken", impact: "MEDIUM" as const, urgency: "HIGH" as const }

describe("TicketsService.create", () => {
  it("computes the priority, routes the team, and takes the number last", async () => {
    const h = harness("REQUESTER")
    await h.service.create({ ...create, categoryId: "cat-1" })
    expect(h.calls).toEqual(["quota", "policy", "number"])
    expect(h.tickets.create).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ number: 42, priority: "HIGH", teamId: "team-a", slaPolicyId: "p-high", source: "PORTAL", status: "NEW" }),
    )
  })

  it("lets only agents raise a ticket for someone else, and only for an active member", async () => {
    await expect(harness("REQUESTER").service.create({ ...create, requesterMembershipId: "m-other" })).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness("AGENT").service.create({ ...create, requesterMembershipId: "m-ghost" })).rejects.toBeInstanceOf(ValidationProblem)
    await expect(harness("AGENT").service.create({ ...create, requesterMembershipId: "m-req" })).resolves.toBeDefined()
  })

  it("refuses a category the picker would not offer", async () => {
    await expect(harness("REQUESTER").service.create({ ...create, categoryId: "cat-gone" })).rejects.toBeInstanceOf(ValidationProblem)
  })
})

describe("TicketsService.update", () => {
  it("refuses a field the actor may not edit, with a 403 naming it", async () => {
    const h = harness("REQUESTER", row({ status: "IN_PROGRESS" }))
    await expect(h.service.update("t-1", { version: 3, title: "New" })).rejects.toThrow(/title/)
  })

  it("recomputes the priority when impact or urgency moves, and reports a stale version as 409", async () => {
    const h = harness("AGENT")
    await h.service.update("t-1", { version: 3, urgency: "LOW" })
    expect(h.tickets.updateVersioned).toHaveBeenCalledWith(ORG, "t-1", 3, expect.objectContaining({ urgency: "LOW", priority: "LOW" }))
    await expect(harness("AGENT", row(), { versionMatches: false }).service.update("t-1", { version: 2, title: "x" })).rejects.toBeInstanceOf(StaleWriteProblem)
  })

  it("writes nothing when nothing changed", async () => {
    const h = harness("AGENT")
    await h.service.update("t-1", { version: 3, title: "Laptop" })
    expect(h.tickets.updateVersioned).not.toHaveBeenCalled()
  })
})

describe("TicketsService.assign", () => {
  it("makes a new ticket assigned, refuses a requester as assignee, and a closed ticket outright", async () => {
    const h = harness("AGENT", row({ status: "NEW", assigneeMembershipId: null }))
    await h.service.assign("t-1", { version: 3, assigneeMembershipId: "m-agent" })
    expect(h.tickets.updateVersioned).toHaveBeenCalledWith(ORG, "t-1", 3, expect.objectContaining({ status: "ASSIGNED" }))
    await expect(harness("AGENT").service.assign("t-1", { version: 3, assigneeMembershipId: "m-req" })).rejects.toBeInstanceOf(ValidationProblem)
    await expect(harness("AGENT", row({ status: "CLOSED" })).service.assign("t-1", { version: 3, teamId: "team-a" })).rejects.toBeInstanceOf(ConflictProblem)
  })
})

describe("TicketsService.transition", () => {
  it("maps each refusal to its problem", async () => {
    await expect(harness("AGENT").service.transition("t-1", { action: "close", version: 3 })).rejects.toBeInstanceOf(InvalidTransitionProblem)
    await expect(harness("AGENT", row({ assigneeMembershipId: "m-x" })).service.transition("t-1", { action: "resolve", version: 3 })).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness("AGENT").service.transition("t-1", { action: "resolve", version: 3 })).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("start makes an unassigned actor the assignee; resolve stops the clocks", async () => {
    const start = harness("AGENT", row({ status: "NEW", assigneeMembershipId: null }))
    await start.service.transition("t-1", { action: "start", version: 3 })
    expect(start.tickets.updateVersioned).toHaveBeenCalledWith(ORG, "t-1", 3, expect.objectContaining({ status: "IN_PROGRESS", assigneeMembershipId: "m-agent" }))
    const resolve = harness("AGENT")
    await resolve.service.transition("t-1", { action: "resolve", version: 3, comment: { body: "Done", visibility: "PUBLIC" } })
    expect(resolve.tickets.updateVersioned).toHaveBeenCalledWith(ORG, "t-1", 3, expect.objectContaining({ status: "RESOLVED", resolvedAt: NOW, respondedAt: NOW }))
  })
})

describe("TicketsService.list", () => {
  const summary = (id: string, minute: number): TicketSummaryRow => ({
    ...row({ id, createdAt: new Date(NOW.getTime() - minute * 60_000) }),
  })

  it("merges the scope branches newest first, without duplicates, and pages with a cursor", async () => {
    // OWN_TEAM_ONLY: four branches — my teams, no team, assigned to me, watched by me.
    const h = harness("AGENT", row(), {
      ownTeamOnly: true,
      branches: [[summary("a", 1), summary("c", 3)], [summary("b", 2), summary("a", 1)], [], []],
    })
    const page = await h.service.list({ view: "open", sort: "newest", limit: 2 })
    expect(h.tickets.listBranch).toHaveBeenCalledTimes(4)
    expect(page.items.map((t) => t.id)).toEqual(["a", "b"])
    expect(page.nextCursor).not.toBeNull()
  })

  it("merges oldest first when asked, and asks each branch for the same direction", async () => {
    const h = harness("AGENT", row(), {
      ownTeamOnly: true,
      branches: [[summary("c", 3), summary("a", 1)], [summary("b", 2)], [], []],
    })
    const page = await h.service.list({ view: "open", sort: "oldest", limit: 25 })
    expect(page.items.map((t) => t.id)).toEqual(["c", "b", "a"])
    expect(h.tickets.listBranch).toHaveBeenCalledWith(ORG, expect.anything(), expect.objectContaining({ direction: "asc" }))
  })

  it("has nothing in a teams view for an agent in no team, without asking the database", async () => {
    const h = harness("AGENT", row(), { teamIds: [] })
    expect(await h.service.list({ view: "teams", sort: "newest", limit: 25 })).toEqual({ items: [], nextCursor: null })
    expect(h.tickets.listBranch).not.toHaveBeenCalled()
  })
})

describe("TicketsService.search", () => {
  it("takes a visible ticket number as a direct hit, without full text", async () => {
    const h = harness("AGENT", row(), { byNumber: [row({ id: "t-7" })] })
    expect((await h.service.search({ q: "INC-7", limit: 25 })).items.map((t) => t.id)).toEqual(["t-7"])
    expect(h.tickets.findByNumber).toHaveBeenCalledWith(ORG, 7, { type: "INCIDENT", scope: null })
    expect(h.tickets.search).not.toHaveBeenCalled()
  })

  it("falls through to full text when no visible ticket has the number, or the type filter rules it out", async () => {
    const missing = harness("AGENT")
    expect((await missing.service.search({ q: "503", limit: 25 })).items.map((t) => t.id)).toEqual(["t-text"])
    const otherType = harness("AGENT", row(), { byNumber: [row({ id: "t-7" })] })
    await otherType.service.search({ q: "REQ-7", type: "INCIDENT", limit: 25 })
    expect(otherType.tickets.findByNumber).not.toHaveBeenCalled()
  })

  it("hands the repository the actor's scope branches", async () => {
    const h = harness("AGENT", row(), { ownTeamOnly: true })
    await h.service.search({ q: "printer", limit: 25 })
    expect(h.tickets.search).toHaveBeenCalledWith(ORG, "printer", { scope: expect.arrayContaining([{ kind: "no-team" }]) }, 25)
  })
})
