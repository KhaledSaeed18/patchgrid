import { Injectable } from "@nestjs/common"
import {
  type AgentVisibility,
  type AssignTicketRequest,
  computePriority,
  type CreateTicketRequest,
  decodeCursor,
  encodeCursor,
  type Ticket,
  type TicketListQuery,
  type TicketPage,
  type TicketSearchQuery,
  type TicketSearchResult,
  type TicketSource,
  type TicketStatus,
  type TransitionRequest,
  type UpdateTicketRequest,
  parseTicketNumber,
} from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { AuditService, type AuditEntry } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import type { ScopeBranch } from "../authz/scope-filter"
import { CategoriesService } from "../categories/categories.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import {
  ConflictProblem,
  InvalidTransitionProblem,
  NotFoundProblem,
  NotPermittedProblem,
  StaleWriteProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { PrismaService } from "../prisma/prisma.service"
import { QuotaService } from "../quota/quota.service"
import { SlaPoliciesService } from "../sla/sla-policies.service"
import { TeamRepository } from "../teams/repositories/team.repository"
import { TenantContextService } from "../tenancy/tenant-context.service"
import {
  onClose,
  onCreate,
  onPause,
  onPolicyChange,
  onReopen,
  onResolve,
  onResponded,
  onResume,
  type SlaState,
} from "./domain/sla"
import { availableActions, checkTransition } from "./domain/transitions"
import { CommentRepository } from "./repositories/comment.repository"
import { type TicketChanges, TicketRepository, type TicketSummaryRow } from "./repositories/ticket.repository"
import { type LoadedTicket, TicketAccess } from "./ticket-access"
import { toSummary, toTicket } from "./ticket-view"

/** Statuses a ticket is still being worked in (DOMAIN.md §2.1). */
export const OPEN_STATUSES: TicketStatus[] = ["NEW", "ASSIGNED", "IN_PROGRESS", "PENDING"]
const TERMINAL: ReadonlySet<TicketStatus> = new Set(["CLOSED", "CANCELLED"])

/**
 * Tickets (DOMAIN.md §1–5, RBAC.md §6–7). Every write is one transaction
 * holding the ticket's version check, its clock effects and its audit rows;
 * the status moves only through `transition` and the table in `domain/`.
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly comments: CommentRepository,
    private readonly access: TicketAccess,
    private readonly memberships: MembershipRepository,
    private readonly teams: TeamRepository,
    private readonly categories: CategoriesService,
    private readonly sla: SlaPoliciesService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async get(id: string): Promise<Ticket> {
    const actor = this.actors.requireTenantActor()
    const loaded = await this.access.load(this.tenant.requireOrgId(), id, actor, this.visibility())
    return this.view(actor, loaded)
  }

  /**
   * Raising a ticket: the priority from the matrix, the team from the
   * category's routing, the clocks from the policy, the month's quota — and,
   * LAST, the number, whose counter row lock serialises creation per type.
   */
  async create(request: CreateTicketRequest): Promise<Ticket> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    this.permissions.assert(actor, "ticket:create", { ticketType: request.type })

    const requesterId = request.requesterMembershipId ?? actor.membershipId
    if (requesterId !== actor.membershipId) {
      this.permissions.assert(actor, "ticket:create_on_behalf")
      const requester = await this.memberships.findById(orgId, requesterId)
      if (requester === null || requester.status !== "ACTIVE") {
        throw fieldError("requesterMembershipId", "is not an active member of this workspace")
      }
    }

    const categoryId = request.categoryId ?? null
    if (categoryId !== null && !(await this.isPickable(categoryId))) {
      throw fieldError("categoryId", "is not an active category")
    }
    const teamId = categoryId === null ? null : await this.categories.routeTeam(orgId, categoryId)
    const priority = computePriority(request.impact, request.urgency)
    const now = this.clock.now()

    const id = await this.prisma.transaction(async () => {
      await this.quota.consume(orgId, "TICKETS_CREATED")
      const policy = await this.sla.policyFor(orgId, request.type, priority)
      const number = await this.tickets.nextNumber(orgId, request.type)
      const created = await this.tickets.create(orgId, {
        number,
        type: request.type,
        title: request.title,
        description: request.description,
        status: "NEW",
        impact: request.impact,
        urgency: request.urgency,
        priority,
        source: sourceOf(actor),
        categoryId,
        requesterMembershipId: requesterId,
        assigneeMembershipId: null,
        teamId,
        slaPolicyId: policy?.id ?? null,
        ...onCreate(now, policy),
        respondedAt: null,
        resolvedAt: null,
        closedAt: null,
        cancelledAt: null,
        pausedAt: null,
        responseBreached: false,
        resolutionBreached: false,
        responseWarningSentAt: null,
        resolutionWarningSentAt: null,
        reopenCount: 0,
      })
      await this.audit.record(orgId, [
        {
          action: "TICKET_CREATED",
          entityType: "Ticket",
          entityId: created,
          diff: { type: request.type, priority, teamId, onBehalfOf: requesterId === actor.membershipId ? null : requesterId },
        },
      ])
      return created
    })
    return this.get(id)
  }

  /** Field-level rules are RBAC.md §6's table, read through `capabilitiesFor`. */
  async update(id: string, request: UpdateTicketRequest): Promise<Ticket> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, id, actor, this.visibility())
      const { row } = loaded
      const editable = new Set(this.permissions.capabilitiesFor(actor, loaded.subject).editableFields)
      const { version, ...fields } = request
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter(
        (field) => fields[field] !== undefined && fields[field] !== row[field],
      )
      const refused = changed.filter((field) => !editable.has(field))
      if (refused.length > 0) throw new NotPermittedProblem(`You can't change ${refused.join(", ")} on this ticket`)
      if (changed.length === 0) return

      const changes: TicketChanges = {}
      for (const field of changed) Object.assign(changes, { [field]: fields[field] })
      if (fields.categoryId !== undefined && fields.categoryId !== null && !(await this.isPickable(fields.categoryId))) {
        throw fieldError("categoryId", "is not an active category")
      }
      if (changes.impact !== undefined || changes.urgency !== undefined) {
        const priority = computePriority(changes.impact ?? row.impact, changes.urgency ?? row.urgency)
        if (priority !== row.priority) {
          // A new priority may mean a new policy: deadlines from the stored origins (DOMAIN.md §4.2).
          const policy = await this.sla.policyFor(orgId, row.type, priority)
          Object.assign(changes, { priority, slaPolicyId: policy?.id ?? null }, onPolicyChange(row, policy))
        }
      }

      if (!(await this.tickets.updateVersioned(orgId, id, version, changes))) throw new StaleWriteProblem()
      await this.audit.record(orgId, [{ action: "TICKET_UPDATED", entityType: "Ticket", entityId: id, diff: diffOf(row, changes) }])
    })
    return this.get(id)
  }

  /**
   * Reassignment (DOMAIN.md §5): always allowed to agents, always audited. A
   * NEW ticket that gains an assignee or a team is ASSIGNED — the same move
   * as the `assign` transition.
   */
  async assign(id: string, request: AssignTicketRequest): Promise<Ticket> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, id, actor, this.visibility())
      this.permissions.assert(actor, "ticket:assign", loaded.subject)
      if (TERMINAL.has(loaded.row.status)) throw new ConflictProblem("A closed or cancelled ticket can't be reassigned")
      const changes = await this.assignment(orgId, request.assigneeMembershipId, request.teamId)
      const touched = changes.assigneeMembershipId ?? changes.teamId ?? null
      if (loaded.row.status === "NEW" && touched !== null) changes.status = "ASSIGNED"
      if (!(await this.tickets.updateVersioned(orgId, id, request.version, changes))) throw new StaleWriteProblem()
      await this.audit.record(orgId, [{ action: "TICKET_ASSIGNED", entityType: "Ticket", entityId: id, diff: diffOf(loaded.row, changes) }])
    })
    return this.get(id)
  }

  /**
   * The one way a status changes (ADR-0006). The table decides whether the
   * move exists, who may make it and what must be said; the clock effects
   * follow DOMAIN.md §4.2; a required comment is written in the same
   * transaction, and a public one from an agent is the response.
   */
  async transition(id: string, request: TransitionRequest): Promise<Ticket> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, id, actor, this.visibility())
      const { row, relation } = loaded
      this.permissions.assert(actor, "ticket:transition", loaded.subject)
      const now = this.clock.now()
      const check = checkTransition({
        type: row.type,
        ticket: row,
        action: request.action,
        actor: relation,
        comment: request.comment ?? null,
        now,
      })
      if (!check.ok) {
        switch (check.problem) {
          case "invalid-transition":
            throw new InvalidTransitionProblem(row.status, request.action)
          case "not-permitted":
            throw new NotPermittedProblem(`You can't ${request.action} this ticket`)
          case "guard":
            throw new ConflictProblem(check.reason)
          case "comment-required":
            throw new ValidationProblem([{ path: "comment", message: check.reason, code: "comment_required" }])
        }
      }
      if (request.comment?.visibility === "INTERNAL") {
        this.permissions.assert(actor, "comment:create_internal", loaded.subject)
      }

      const changes: TicketChanges = { status: check.row.to }
      const policy = row.slaPolicyId === null ? null : await this.sla.policyFor(orgId, row.type, row.priority)
      let state: SlaState = row
      const apply = (patch: Partial<SlaState>) => {
        Object.assign(changes, patch)
        state = { ...state, ...patch }
      }
      if (request.comment?.visibility === "PUBLIC" && actor.role !== "REQUESTER") apply(onResponded(state, now))
      switch (request.action) {
        case "assign":
          Object.assign(changes, await this.assignment(orgId, request.assigneeMembershipId, request.teamId, true))
          break
        case "start":
          if (row.assigneeMembershipId === null) changes.assigneeMembershipId = actor.membershipId
          break
        case "wait":
          apply(onPause(state, now))
          break
        case "resume":
          apply(onResume(state, now, policy))
          break
        case "resolve":
          apply(onResolve(state, now))
          break
        case "close":
          apply(onClose(now))
          break
        case "reopen":
          apply(onReopen(state, now, policy))
          break
        case "cancel":
          changes.cancelledAt = now
          break
        default:
          throw new InvalidTransitionProblem(row.status, request.action)
      }

      if (!(await this.tickets.updateVersioned(orgId, id, request.version, changes))) throw new StaleWriteProblem()
      const entries: AuditEntry[] = [
        {
          action: "TICKET_TRANSITIONED",
          entityType: "Ticket",
          entityId: id,
          diff: { action: request.action, from: row.status, to: check.row.to },
        },
      ]
      if (request.comment !== undefined) {
        const comment = await this.comments.create(orgId, {
          ticketId: id,
          authorMembershipId: actor.membershipId,
          authorKind: actor.kind === "service" ? "SERVICE" : "MEMBER",
          body: request.comment.body,
          visibility: request.comment.visibility,
        })
        entries.push({
          action: "COMMENT_ADDED",
          entityType: "Ticket",
          entityId: id,
          diff: { commentId: comment.id, visibility: comment.visibility, viaAction: request.action },
        })
      }
      await this.audit.record(orgId, entries)
    })
    return this.get(id)
  }

  /**
   * A view, scoped (RBAC.md §4): one index-friendly query per scope branch,
   * merged on (createdAt, id) in the asked direction and de-duplicated — the UNION ALL ADR-0025 asks
   * for, without raw SQL. `mine` needs no scope: your own tickets are yours.
   */
  async list(query: TicketListQuery): Promise<TicketPage> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    this.permissions.assert(actor, "ticket:read", { own: true, watch: true, scope: true })

    let after: { createdAt: Date; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      const createdAt = parts === null ? null : new Date(parts.sortValue)
      if (parts === null || createdAt === null || Number.isNaN(createdAt.getTime())) {
        throw fieldError("cursor", "is not a cursor this endpoint issued")
      }
      after = { createdAt, id: parts.id }
    }

    const where = this.viewWhere(actor, query)
    if (where === null) return { items: [], nextCursor: null }
    const branches = this.branchesFor(actor, query.view)
    const limit = query.limit + 1
    const direction = query.sort === "oldest" ? "asc" : "desc"
    const results = await Promise.all(
      branches.map((b) => this.tickets.listBranch(orgId, b, { where, after, direction, limit })),
    )

    const merged = new Map<string, TicketSummaryRow>()
    for (const row of results.flat()) merged.set(row.id, row)
    const sign = direction === "desc" ? 1 : -1
    const ordered = [...merged.values()].sort(
      (a, b) =>
        sign * (b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    )
    const page = ordered.slice(0, query.limit)
    const last = page.at(-1)
    const now = this.clock.now()
    return {
      items: page.map((row) => toSummary(row, now)),
      nextCursor:
        ordered.length > query.limit && last !== undefined
          ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  }

  /**
   * Search (DOMAIN.md §9.1), through the same scope as a list — the classic
   * agent-visibility leak is a search that forgets it. A query that reads as
   * a ticket number is a direct hit first; only when none is visible does it
   * fall through to full text (a bare `404` may well be in a title).
   */
  async search(query: TicketSearchQuery): Promise<TicketSearchResult> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    this.permissions.assert(actor, "ticket:read", { own: true, watch: true, scope: true })

    const filter = this.permissions.scopeFor(actor, "ticket", { agentVisibility: this.visibility() })
    if (filter.kind === "none") return { items: [] }
    const narrowing = {
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
      scope: filter.kind === "all" ? null : filter.branches,
    }

    const number = parseTicketNumber(query.q)
    const rows = await this.prisma.transaction(async () => {
      if (number !== null && (number.type === null || query.type === undefined || number.type === query.type)) {
        const hits = await this.tickets.findByNumber(orgId, number.number, {
          ...narrowing,
          ...(number.type === null ? {} : { type: number.type }),
        })
        if (hits.length > 0) return hits.slice(0, query.limit)
      }
      return this.tickets.search(orgId, query.q, narrowing, query.limit)
    })
    const now = this.clock.now()
    return { items: rows.map((row) => toSummary(row, now)) }
  }

  /** The view's own narrowing, before scope; `null` for a view this actor has nothing in. */
  private viewWhere(actor: TenantActor, query: TicketListQuery) {
    const status = query.status ?? { in: OPEN_STATUSES }
    switch (query.view) {
      case "mine":
        return { requesterMembershipId: actor.membershipId, ...(query.status === undefined ? {} : { status: query.status }) }
      case "assigned":
        return { assigneeMembershipId: actor.membershipId, status }
      case "teams": {
        const teamIds = actor.kind === "member" ? actor.teamIds : []
        return teamIds.length === 0 ? null : { teamId: { in: teamIds }, status }
      }
      case "open":
        return { status }
      case "unassigned":
        return { teamId: null, assigneeMembershipId: null, status }
    }
  }

  private branchesFor(actor: TenantActor, view: TicketListQuery["view"]): (ScopeBranch | null)[] {
    if (view === "mine") return [null]
    const filter = this.permissions.scopeFor(actor, "ticket", { agentVisibility: this.visibility() })
    if (filter.kind === "none") return []
    return filter.kind === "all" ? [null] : [...filter.branches]
  }

  /** Validates and returns an assignee and team change; `requireOne` for the `assign` action. */
  private async assignment(
    orgId: string,
    assigneeId: string | null | undefined,
    teamId: string | null | undefined,
    requireOne = false,
  ): Promise<TicketChanges> {
    if (requireOne && (assigneeId ?? null) === null && (teamId ?? null) === null) {
      throw fieldError("assigneeMembershipId", "assign needs an assignee, a team, or both")
    }
    const changes: TicketChanges = {}
    if (assigneeId !== undefined) {
      if (assigneeId !== null) {
        const assignee = await this.memberships.findById(orgId, assigneeId)
        if (assignee === null || assignee.status !== "ACTIVE" || assignee.role === "REQUESTER") {
          throw fieldError("assigneeMembershipId", "is not an active agent in this workspace")
        }
      }
      changes.assigneeMembershipId = assigneeId
    }
    if (teamId !== undefined) {
      if (teamId !== null) {
        const team = await this.teams.findById(orgId, teamId)
        if (team === null || !team.isActive) throw fieldError("teamId", "is not an active team")
      }
      changes.teamId = teamId
    }
    return changes
  }

  private async isPickable(categoryId: string): Promise<boolean> {
    return (await this.categories.list(false)).some((c) => c.id === categoryId)
  }

  private view(actor: TenantActor, loaded: LoadedTicket): Ticket {
    const now = this.clock.now()
    return toTicket(
      loaded.row,
      now,
      availableActions({ type: loaded.row.type, ticket: loaded.row, actor: loaded.relation, now }),
      this.permissions.capabilitiesFor(actor, loaded.subject),
    )
  }

  private visibility(): AgentVisibility {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }
}

function sourceOf(actor: TenantActor): TicketSource {
  if (actor.kind === "service") return "API"
  return actor.role === "REQUESTER" ? "PORTAL" : "CONSOLE"
}

function fieldError(path: string, message: string): ValidationProblem {
  return new ValidationProblem([{ path, message, code: "invalid_ticket" }])
}

/** `{ field: { from, to } }` for the fields that moved (DOMAIN.md §7). */
function diffOf(row: Record<string, unknown>, changes: TicketChanges): Record<string, { from: unknown; to: unknown }> {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v)
  return Object.fromEntries(
    Object.entries(changes).map(([field, to]) => [field, { from: iso(row[field] ?? null), to: iso(to ?? null) }]),
  )
}
