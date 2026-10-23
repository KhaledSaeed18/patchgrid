import type { Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor, TenantActor } from "../auth/actor"
import type { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import type { CategoriesService } from "../categories/categories.service"
import { FixedClock } from "../common/clock/clock"
import {
  ChangeWindowEarlyProblem,
  ConflictProblem,
  InvalidTransitionProblem,
  NotFoundProblem,
  NotPermittedProblem,
  StaleWriteProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import type { MembershipRepository } from "../memberships/repositories/membership.repository"
import type { TicketPulse } from "../notifications/live/ticket-pulse"
import type { Outbox } from "../events/outbox"
import type { Notifier } from "../notifications/notify"
import type { PrismaService } from "../prisma/prisma.service"
import type { QuotaService } from "../quota/quota.service"
import type { SlaPoliciesService } from "../sla/sla-policies.service"
import type { TeamRepository } from "../teams/repositories/team.repository"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import type { CommentRepository } from "./repositories/comment.repository"
import type { AssetsService } from "../assets/assets.service"
import type { AssetRepository } from "../assets/repositories/asset.repository"
import type { LinkRepository } from "./repositories/link.repository"
import type { WatcherRepository } from "./repositories/watcher.repository"
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
    requester: { id: "m-req", displayName: "Req", kind: "HUMAN" },
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
    problem: null,
    change: null,
    assets: [],
    ...over,
  }
}

function harness(
  role: Role,
  ticket: TicketRow = row(),
  options: {
    versionMatches?: boolean
    branches?: TicketSummaryRow[][]
    ownTeamOnly?: boolean
    teamIds?: string[]
    leadOfTeamIds?: string[]
    byNumber?: TicketSummaryRow[]
    membershipId?: string
    otherApprover?: boolean
    approvers?: { membershipId: string; role: Role }[]
    visible?: TicketRow[]
    /** The asset ids this actor can open. */
    visibleAssets?: string[]
    /** Act as an API token with every scope rather than a person. */
    service?: boolean
    /** Act as a read-only support session (ADR-0041). */
    support?: boolean
  } = {},
) {
  const calls: string[] = []
  const member: MemberActor = {
    kind: "member",
    userId: "u",
    orgId: ORG,
    membershipId: options.membershipId ?? (role === "REQUESTER" ? "m-req" : "m-agent"),
    role,
    teamIds: options.teamIds ?? ["team-a"],
    leadOfTeamIds: options.leadOfTeamIds ?? [],
  }
  const actor: TenantActor =
    options.service === true
      ? { kind: "service", orgId: ORG, membershipId: member.membershipId, role, scopes: ["tickets:read", "tickets:write", "comments:internal"], tokenId: "tok-1" }
      : options.support === true
        ? { kind: "support", orgId: ORG, sessionId: "s-1", platformAdminId: "pa-1", userId: "u-op", role: "ADMIN", membershipId: "s-1" }
        : member
  const permissions = new PermissionService()
  const loaded = (): LoadedTicket => ({
    row: ticket,
    subject: { own: ticket.requesterMembershipId === actor.membershipId, watch: false, scope: role !== "REQUESTER", ticketType: ticket.type, ticketStatus: ticket.status },
    relation: { role, isRequester: ticket.requesterMembershipId === actor.membershipId, isAssignee: ticket.assigneeMembershipId === actor.membershipId, ticketHasAssignee: ticket.assigneeMembershipId !== null },
  })
  const branchResults = [...(options.branches ?? [])]
  // Whether each event was written inside the change's transaction (ADR-0049).
  let open = false
  const written: { event: object; inTransaction: boolean }[] = []
  const notifier = {
    notify: vi.fn(async (_o: string, event: object) => void written.push({ event, inTransaction: open })),
    notifyAll: vi.fn(async (_o: string, events: object[]) => void written.push(...events.map((event) => ({ event, inTransaction: open })))),
  }
  const pulse = { changed: vi.fn(async () => undefined) }
  const outbox = { append: vi.fn(async (_o: string, events: object[]) => void written.push(...events.map((event) => ({ event, inTransaction: open })))) }
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
    updateDetails: vi.fn(async () => undefined),
    addApproval: vi.fn(async () => undefined),
    // Rule 3's question, as the repository answers it: nobody else, or another admin besides the owner.
    approverCandidates: vi.fn(async () =>
      options.approvers ??
      (options.otherApprover === false
        ? [{ membershipId: options.membershipId ?? "m-owner", role: "OWNER" }]
        : [{ membershipId: options.membershipId ?? "m-owner", role: "OWNER" }, { membershipId: "m-other-admin", role: "ADMIN" }]),
    ),
  }
  const links = { createMany: vi.fn(async () => undefined) }
  const assetLinks = { linkMany: vi.fn(async () => undefined), lockMany: vi.fn(async () => undefined) }
  const audit = { record: vi.fn(async () => undefined) }
  const watchers = { add: vi.fn(async () => true) }
  const service = new TicketsService(
    tickets as unknown as TicketRepository,
    { create: vi.fn(async () => ({ id: "c-1", visibility: "PUBLIC" })) } as unknown as CommentRepository,
    links as unknown as LinkRepository,
    assetLinks as unknown as AssetRepository,
    {
      visible: async (_o: string, _a: unknown, ids: string[]) =>
        ids.filter((id) => (options.visibleAssets ?? []).includes(id)).map((id) => ({ id, name: id, type: "LAPTOP", status: "IN_USE" })),
    } as unknown as AssetsService,
    {
      load: vi.fn(async () => loaded()),
      loadVisible: vi.fn(async (_o: string, ids: string[]) =>
        (options.visible ?? [])
          .filter((r) => ids.includes(r.id))
          .map((r) => ({ row: r, subject: { scope: true, own: false, watch: false, ticketType: r.type, ticketStatus: r.status }, relation: { role, isRequester: false, isAssignee: false, ticketHasAssignee: false } })),
      ),
    } as unknown as TicketAccess,
    { findById: async (_o: string, id: string) => (id === "m-ghost" ? null : { id, status: "ACTIVE", kind: "HUMAN", role: id === "m-req" ? "REQUESTER" : "AGENT" }) } as unknown as MembershipRepository,
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
    {
      transaction: async (fn: () => Promise<unknown>) => {
        open = true
        try {
          return await fn()
        } finally {
          open = false
        }
      },
    } as unknown as PrismaService,
    audit as unknown as AuditService,
    {
      consume: async () => {
        calls.push("quota")
      },
    } as unknown as QuotaService,
    notifier as unknown as Notifier,
    outbox as unknown as Outbox,
    pulse as unknown as TicketPulse,
    watchers as unknown as WatcherRepository,
    new FixedClock(NOW),
  )
  // `get` re-reads through the access layer; the spec only cares that it is reached.
  vi.spyOn(service, "get").mockResolvedValue({} as never)
  return { service, tickets, calls, notifier, written, pulse, links, assetLinks, audit, watchers }
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
      {},
    )
  })

  it("names only assets the actor can open, and links and audits each once", async () => {
    await expect(harness("REQUESTER").service.create({ ...create, assetIds: ["a-theirs"] })).rejects.toBeInstanceOf(ValidationProblem)
    const h = harness("REQUESTER", row(), { visibleAssets: ["a-mine"] })
    await h.service.create({ ...create, assetIds: ["a-mine", "a-mine"] })
    expect(h.assetLinks.linkMany).toHaveBeenCalledWith(ORG, "t-new", ["a-mine"])
    expect(h.audit.record).toHaveBeenCalledWith(ORG, expect.arrayContaining([expect.objectContaining({ action: "TICKET_ASSET_LINKED", diff: { assetId: "a-mine" } })]))
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

describe("TicketsService.get", () => {
  it("offers an admin the table's actions, and a read-only support session none of them", async () => {
    const admin = harness("ADMIN")
    vi.mocked(admin.service.get).mockRestore()
    expect((await admin.service.get("t-1")).availableActions).toContain("cancel")
    const support = harness("ADMIN", row(), { support: true })
    vi.mocked(support.service.get).mockRestore()
    expect((await support.service.get("t-1")).availableActions).toEqual([])
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

  it("lets the outgoing assignee keep watching what they hand on, as an explicit watcher, audited", async () => {
    const h = harness("AGENT", row({ status: "IN_PROGRESS", assigneeMembershipId: "m-me" }), { membershipId: "m-me" })
    await h.service.assign("t-1", { version: 3, assigneeMembershipId: "m-agent", keepWatching: true })
    expect(h.watchers.add).toHaveBeenCalledWith(ORG, "t-1", "m-me", "m-me")
    expect(h.audit.record).toHaveBeenCalledWith(ORG, [expect.objectContaining({ action: "TICKET_ASSIGNED" }), { action: "WATCHER_ADDED", entityType: "Ticket", entityId: "t-1", diff: { membershipId: "m-me" } }])
  })

  it("refuses keepWatching from anyone but the assignee handing the ticket on", async () => {
    const notMine = harness("AGENT", row({ status: "IN_PROGRESS", assigneeMembershipId: "m-other" }), { membershipId: "m-me" })
    await expect(notMine.service.assign("t-1", { version: 3, assigneeMembershipId: "m-agent", keepWatching: true })).rejects.toBeInstanceOf(ValidationProblem)
    const stillMine = harness("AGENT", row({ status: "IN_PROGRESS", assigneeMembershipId: "m-me" }), { membershipId: "m-me" })
    await expect(stillMine.service.assign("t-1", { version: 3, teamId: "team-a", keepWatching: true })).rejects.toBeInstanceOf(ValidationProblem)
    expect(stillMine.tickets.updateVersioned).not.toHaveBeenCalled()
  })
})

describe("TicketsService notifications", () => {
  it("writes each event inside the change's own transaction, never after it", async () => {
    const assign = harness("AGENT", row({ status: "NEW", assigneeMembershipId: null }))
    await assign.service.assign("t-1", { version: 3, assigneeMembershipId: "m-agent" })
    expect(assign.written).toEqual([
      { event: { kind: "ticket-assigned", ticketId: "t-1", actorMembershipId: "m-agent", assigneeMembershipId: "m-agent" }, inTransaction: true },
    ])
    expect(assign.pulse.changed).toHaveBeenCalledWith(ORG, "t-1")

    const resolve = harness("AGENT")
    await resolve.service.transition("t-1", { action: "resolve", version: 3, comment: { body: "Done", visibility: "PUBLIC" } })
    expect(resolve.written).toEqual([
      { event: { kind: "status-changed", ticketId: "t-1", actorMembershipId: "m-agent", to: "RESOLVED", comment: "PUBLIC" }, inTransaction: true },
    ])

    const created = harness("AGENT")
    await created.service.create(create)
    expect(created.written).toEqual([{ event: { kind: "ticket-created", ticketId: "t-new", actorMembershipId: "m-agent" }, inTransaction: true }])
  })

  it("tells nobody of an edit, but writes it to the log in its transaction, for reporting", async () => {
    const h = harness("AGENT")
    await h.service.update("t-1", { version: 3, title: "Renamed" })
    expect(h.written).toEqual([{ event: { type: "ticket-changed", payload: { ticketId: "t-1" } }, inTransaction: true }])
    expect(h.notifier.notifyAll).not.toHaveBeenCalled()
    expect(h.notifier.notify).not.toHaveBeenCalled()
  })

  it("writes nothing when the change fails, so a stale write tells nobody", async () => {
    const h = harness("AGENT", row(), { versionMatches: false })
    await expect(h.service.transition("t-1", { action: "resolve", version: 3, comment: { body: "Done", visibility: "PUBLIC" } })).rejects.toBeInstanceOf(StaleWriteProblem)
    expect(h.written).toEqual([])
    expect(h.pulse.changed).not.toHaveBeenCalled()
  })

  it("pulses before reading back, so a read-back the caller may not make loses nothing", async () => {
    const h = harness("AGENT", row({ status: "NEW", assigneeMembershipId: null }))
    vi.spyOn(h.service, "get").mockRejectedValue(new NotFoundProblem())
    await expect(h.service.assign("t-1", { version: 3, assigneeMembershipId: "m-agent" })).rejects.toBeInstanceOf(NotFoundProblem)
    expect(h.written).toHaveLength(1)
    expect(h.pulse.changed).toHaveBeenCalledTimes(1)
  })
})

describe("TicketsService notification choices", () => {
  it("tells nobody when an assignment names the current assignee, but still writes the change to the log", async () => {
    const h = harness("AGENT", row({ assigneeMembershipId: "m-agent" }))
    await h.service.assign("t-1", { version: 3, assigneeMembershipId: "m-agent" })
    expect(h.notifier.notify).not.toHaveBeenCalled()
    expect(h.written).toEqual([{ event: { type: "ticket-changed", payload: { ticketId: "t-1" } }, inTransaction: true }])
  })

  it("reports a reopen as a reopen, not as a status change", async () => {
    const h = harness("REQUESTER", row({ status: "RESOLVED", resolvedAt: NOW }))
    await h.service.transition("t-1", { action: "reopen", version: 3, comment: { body: "Still broken", visibility: "PUBLIC" } })
    expect(h.written.map((w) => w.event)).toEqual([{ kind: "ticket-reopened", ticketId: "t-1", actorMembershipId: "m-req", comment: "PUBLIC" }])
  })
})

const change = (over: Partial<TicketRow> = {}, plan: Partial<NonNullable<TicketRow["change"]>> = {}): TicketRow =>
  row({
    type: "CHANGE",
    status: "AWAITING_APPROVAL",
    slaPolicyId: null,
    requesterMembershipId: "m-requester",
    assigneeMembershipId: null,
    teamId: "team-net",
    change: {
      plannedStart: new Date(NOW.getTime() + 3 * 3_600_000),
      plannedEnd: new Date(NOW.getTime() + 4 * 3_600_000),
      risk: "LOW",
      implementationPlan: "Swap",
      rollbackPlan: "Swap back",
      outcomeNotes: null,
      approvals: [],
      ...plan,
    },
    ...over,
  })

describe("TicketsService — problems and changes", () => {
  const problemRequest = { type: "PROBLEM" as const, title: "Leases", description: "Root cause hunt", impact: "MEDIUM" as const, urgency: "MEDIUM" as const }

  it("raises a Problem from incidents the agent can see, linking each CAUSED_BY it, with no SLA policy", async () => {
    const incident = row({ id: "inc-1", type: "INCIDENT" })
    const h = harness("AGENT", row(), { visible: [incident] })
    await h.service.create({ ...problemRequest, causedIncidentIds: ["inc-1"], problem: { workaround: "Reconnect" } })
    expect(h.calls).toEqual(["quota", "number"])
    expect(h.tickets.create).toHaveBeenCalledWith(ORG, expect.objectContaining({ type: "PROBLEM", status: "NEW", slaPolicyId: null }), { problem: { workaround: "Reconnect" } })
    expect(h.links.createMany).toHaveBeenCalledWith(ORG, [{ fromTicketId: "inc-1", toTicketId: "t-new", relation: "CAUSED_BY" }], "m-agent")
  })

  it("refuses a Problem from a ticket it cannot see or that is not an incident, and a requester's Problem outright", async () => {
    await expect(harness("AGENT", row(), { visible: [] }).service.create({ ...problemRequest, causedIncidentIds: ["inc-x"] })).rejects.toBeInstanceOf(ValidationProblem)
    const req = row({ id: "sr-1", type: "SERVICE_REQUEST" })
    await expect(harness("AGENT", row(), { visible: [req] }).service.create({ ...problemRequest, causedIncidentIds: ["sr-1"] })).rejects.toBeInstanceOf(ValidationProblem)
    await expect(harness("REQUESTER").service.create(problemRequest)).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness("AGENT").service.create({ ...create, problem: { rootCause: "x" } })).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("starts a Change as a DRAFT and refuses a window that ends before it starts", async () => {
    const h = harness("AGENT")
    await h.service.create({ ...problemRequest, type: "CHANGE", change: { risk: "LOW" } })
    expect(h.tickets.create).toHaveBeenCalledWith(ORG, expect.objectContaining({ type: "CHANGE", status: "DRAFT" }), { change: { risk: "LOW" } })
    await expect(
      harness("AGENT").service.create({ ...problemRequest, type: "CHANGE", change: { plannedStart: "2026-10-20T10:00:00.000Z", plannedEnd: "2026-10-20T09:00:00.000Z" } }),
    ).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("lets an admin approve someone else's change, recording the decision and auditing it", async () => {
    const h = harness("ADMIN", change(), { membershipId: "m-admin" })
    await h.service.transition("t-1", { action: "approve", version: 3 })
    expect(h.tickets.addApproval).toHaveBeenCalledWith(ORG, expect.objectContaining({ decision: "APPROVED", selfApproved: false, approverMembershipId: "m-admin" }))
    expect(h.audit.record).toHaveBeenCalledWith(ORG, expect.arrayContaining([expect.objectContaining({ action: "CHANGE_APPROVED" })]))
    expect(h.written.map((w) => w.event)).toEqual([expect.objectContaining({ kind: "change-decided", decision: "APPROVED" })])
  })

  it("lets a lead of the change's team decide, but never on a change they raised", async () => {
    const lead = harness("AGENT", change(), { membershipId: "m-lead", leadOfTeamIds: ["team-net"] })
    await lead.service.transition("t-1", { action: "reject", version: 3, comment: { body: "Needs a rollback test", visibility: "PUBLIC" } })
    expect(lead.tickets.addApproval).toHaveBeenCalledWith(ORG, expect.objectContaining({ decision: "REJECTED", reason: "Needs a rollback test" }))
    const own = harness("AGENT", change({ requesterMembershipId: "m-lead" }), { membershipId: "m-lead", leadOfTeamIds: ["team-net"] })
    await expect(own.service.transition("t-1", { action: "approve", version: 3 })).rejects.toBeInstanceOf(NotPermittedProblem)
    const other = harness("AGENT", change(), { membershipId: "m-agent", leadOfTeamIds: ["team-other"] })
    await expect(other.service.transition("t-1", { action: "approve", version: 3 })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("lets an owner approve their own change only when nobody else could — and says so", async () => {
    const alone = harness("OWNER", change({ requesterMembershipId: "m-owner" }), { membershipId: "m-owner", otherApprover: false })
    await alone.service.transition("t-1", { action: "approve", version: 3 })
    expect(alone.tickets.addApproval).toHaveBeenCalledWith(ORG, expect.objectContaining({ selfApproved: true }))
    expect(alone.audit.record).toHaveBeenCalledWith(ORG, expect.arrayContaining([expect.objectContaining({ action: "CHANGE_SELF_APPROVED" })]))
    const notAlone = harness("OWNER", change({ requesterMembershipId: "m-owner" }), { membershipId: "m-owner", otherApprover: true })
    await expect(notAlone.service.transition("t-1", { action: "approve", version: 3 })).rejects.toBeInstanceOf(NotPermittedProblem)
    // A rejection is never one's own.
    await expect(alone.service.transition("t-1", { action: "reject", version: 3, comment: { body: "x", visibility: "PUBLIC" } })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("never lets an owner self-approve by making the only other admin the assignee", async () => {
    const approvers = [{ membershipId: "m-owner", role: "OWNER" as const }, { membershipId: "m-admin", role: "ADMIN" as const }]
    const engineered = harness("OWNER", change({ requesterMembershipId: "m-owner", assigneeMembershipId: "m-admin" }), { membershipId: "m-owner", approvers })
    await expect(engineered.service.transition("t-1", { action: "approve", version: 3 })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("refuses to submit a change nobody could decide, and submits one somebody could", async () => {
    const approvers = [{ membershipId: "m-owner", role: "OWNER" as const }, { membershipId: "m-admin", role: "ADMIN" as const }]
    const draft = (assignee: string | null) =>
      change({ status: "DRAFT", requesterMembershipId: "m-owner", assigneeMembershipId: assignee }, { plannedStart: NOW, plannedEnd: new Date(NOW.getTime() + 3_600_000), implementationPlan: "Swap it", rollbackPlan: "Swap back", risk: "LOW" })
    const stuck = harness("OWNER", draft("m-admin"), { membershipId: "m-owner", approvers })
    await expect(stuck.service.transition("t-1", { action: "submit", version: 3 })).rejects.toBeInstanceOf(ConflictProblem)
    expect(stuck.tickets.updateVersioned).not.toHaveBeenCalled()
    const fine = harness("OWNER", draft(null), { membershipId: "m-owner", approvers })
    await fine.service.transition("t-1", { action: "submit", version: 3 })
    expect(fine.tickets.updateVersioned).toHaveBeenCalledWith(ORG, "t-1", 3, expect.objectContaining({ status: "AWAITING_APPROVAL" }))
  })

  it("asks before starting a change more than an hour early, then starts it", async () => {
    const approved = change({ status: "APPROVED", assigneeMembershipId: "m-agent" })
    await expect(harness("AGENT", approved).service.transition("t-1", { action: "start", version: 3 })).rejects.toBeInstanceOf(ChangeWindowEarlyProblem)
    const h = harness("AGENT", approved)
    await h.service.transition("t-1", { action: "start", version: 3, confirm: true })
    expect(h.tickets.updateVersioned).toHaveBeenCalledWith(ORG, "t-1", 3, expect.objectContaining({ status: "IN_PROGRESS" }))
  })

  it("marks the work done when it completes, for auto-close to count from", async () => {
    const h = harness("AGENT", change({ status: "IN_PROGRESS", assigneeMembershipId: "m-agent" }, { outcomeNotes: "Swapped" }))
    await h.service.transition("t-1", { action: "complete", version: 3 })
    expect(h.tickets.updateVersioned).toHaveBeenCalledWith(ORG, "t-1", 3, expect.objectContaining({ status: "IMPLEMENTED", resolvedAt: NOW }))
  })

  it("edits a change's plan while DRAFT and its outcome once approved — never the other way round", async () => {
    const draft = harness("AGENT", change({ status: "DRAFT", requesterMembershipId: "m-agent" }))
    await draft.service.update("t-1", { version: 3, change: { rollbackPlan: "Restore from backup" } })
    expect(draft.tickets.updateDetails).toHaveBeenCalledWith(ORG, "t-1", { problem: {}, change: { rollbackPlan: "Restore from backup" } })
    await expect(harness("AGENT", change({ status: "DRAFT" })).service.update("t-1", { version: 3, change: { outcomeNotes: "Done" } })).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness("AGENT", change({ status: "APPROVED" })).service.update("t-1", { version: 3, change: { risk: "HIGH" } })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("keeps a known error's workaround, and a change's outcome off its draft", async () => {
    const known = harness("AGENT", row({ type: "PROBLEM", status: "KNOWN_ERROR", slaPolicyId: null, problem: { rootCause: null, workaround: "Reconnect", knownErrorAt: NOW } }))
    await expect(known.service.update("t-1", { version: 3, problem: { workaround: null } })).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness("AGENT").service.create({ ...problemRequest, type: "CHANGE", change: { outcomeNotes: "Done already" } })).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("raises a problem or change on behalf of an agent only", async () => {
    await expect(harness("AGENT").service.create({ ...problemRequest, requesterMembershipId: "m-req" })).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("holds a change's assignee and team still while a decision is pending", async () => {
    await expect(harness("ADMIN", change(), { membershipId: "m-admin" }).service.assign("t-1", { version: 3, assigneeMembershipId: "m-agent" })).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("lets only the assignee or an admin start an approved change — approving it is not a claim on it", async () => {
    const lead = harness("AGENT", change({ status: "APPROVED", assigneeMembershipId: null }), { membershipId: "m-lead", leadOfTeamIds: ["team-net"] })
    await expect(lead.service.transition("t-1", { action: "start", version: 3, confirm: true })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("never lets an owner's API token self-approve", async () => {
    const h = harness("OWNER", change({ requesterMembershipId: "m-owner" }), { membershipId: "m-owner", otherApprover: false, service: true })
    await expect(h.service.transition("t-1", { action: "approve", version: 3 })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("files a Problem as a known error with the time it became one", async () => {
    const h = harness("AGENT", row({ type: "PROBLEM", status: "IN_PROGRESS", slaPolicyId: null, problem: { rootCause: null, workaround: "Reconnect", knownErrorAt: null } }))
    await h.service.transition("t-1", { action: "workaround", version: 3 })
    expect(h.tickets.updateDetails).toHaveBeenCalledWith(ORG, "t-1", { problem: { knownErrorAt: NOW } })
  })

  it("shows the approval inbox only to those who could decide, never their own changes", async () => {
    const plain = harness("AGENT")
    expect(await plain.service.list({ view: "approvals", sort: "newest", limit: 25 })).toEqual({ items: [], nextCursor: null })
    const lead = harness("AGENT", row(), { leadOfTeamIds: ["team-net"] })
    await lead.service.list({ view: "approvals", sort: "newest", limit: 25 })
    expect(lead.tickets.listBranch).toHaveBeenCalledWith(
      ORG,
      null,
      expect.objectContaining({
        where: {
          type: "CHANGE",
          status: "AWAITING_APPROVAL",
          teamId: { in: ["team-net"] },
          requesterMembershipId: { not: "m-agent" },
          OR: [{ assigneeMembershipId: null }, { assigneeMembershipId: { not: "m-agent" } }],
        },
      }),
    )
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
    // OWN_TEAM_ONLY: five branches — my teams, no team, assigned to me, raised by me, watched by me.
    const h = harness("AGENT", row(), {
      ownTeamOnly: true,
      branches: [[summary("a", 1), summary("c", 3)], [summary("b", 2), summary("a", 1)], [], [], []],
    })
    const page = await h.service.list({ view: "open", sort: "newest", limit: 2 })
    expect(h.tickets.listBranch).toHaveBeenCalledTimes(5)
    expect(page.items.map((t) => t.id)).toEqual(["a", "b"])
    expect(page.nextCursor).not.toBeNull()
  })

  it("merges oldest first when asked, and asks each branch for the same direction", async () => {
    const h = harness("AGENT", row(), {
      ownTeamOnly: true,
      branches: [[summary("c", 3), summary("a", 1)], [summary("b", 2)], [], [], []],
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
