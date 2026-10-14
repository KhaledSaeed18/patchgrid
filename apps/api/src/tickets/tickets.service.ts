import { Injectable } from "@nestjs/common"
import {
  type AgentVisibility,
  type AssignTicketRequest,
  type ChangeFieldsInput,
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
  OPEN_TICKET_STATUSES,
  parseTicketNumber,
} from "@patchgrid/contracts"

import { AssetsService } from "../assets/assets.service"
import { AssetRepository } from "../assets/repositories/asset.repository"
import { ActorService, type TenantActor } from "../auth/actor"
import { AuditService, type AuditEntry } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import type { ScopeBranch } from "../authz/scope-filter"
import { CategoriesService } from "../categories/categories.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import {
  ChangeWindowEarlyProblem,
  ConflictProblem,
  InvalidTransitionProblem,
  NotFoundProblem,
  NotPermittedProblem,
  StaleWriteProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { TicketPulse } from "../notifications/live/ticket-pulse"
import { type Notice, Notifier } from "../notifications/notify"
import type { NotifyEvent } from "../notifications/notify-events"
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
import { type ApprovalStanding, availableActions, checkTransition, type TransitionTicket } from "./domain/transitions"
import { CommentRepository } from "./repositories/comment.repository"
import { LinkRepository } from "./repositories/link.repository"
import {
  type ChangeChanges,
  type ChangeRow,
  type ListFilter,
  type TicketChanges,
  TicketRepository,
  type TicketRow,
  type TicketSummaryRow,
} from "./repositories/ticket.repository"
import { type LoadedTicket, TicketAccess } from "./ticket-access"
import { toSummary, toTicket } from "./ticket-view"

/** Statuses a ticket of any type is still being worked in (DOMAIN.md §2). */
export const OPEN_STATUSES: TicketStatus[] = [...OPEN_TICKET_STATUSES]
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
    private readonly links: LinkRepository,
    private readonly assetLinks: AssetRepository,
    private readonly assets: AssetsService,
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
    private readonly notifier: Notifier,
    private readonly pulse: TicketPulse,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** One logical read, one transaction: the row, the actor's watch, and who else could approve. */
  async get(id: string): Promise<Ticket> {
    const actor = this.actors.requireTenantActor()
    return this.prisma.transaction(async () => {
      const loaded = await this.access.load(this.tenant.requireOrgId(), id, actor, this.visibility())
      return this.view(actor, loaded)
    })
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
      // Problems and Changes belong to agents (DOMAIN.md §2.2, §2.3), on whosever behalf they are raised.
      if (requester.role === "REQUESTER" && (request.type === "PROBLEM" || request.type === "CHANGE")) {
        throw fieldError("requesterMembershipId", "must be an agent for a problem or a change")
      }
    }

    if (request.problem !== undefined && request.type !== "PROBLEM") throw fieldError("problem", "is only for a problem")
    if (request.change !== undefined && request.type !== "CHANGE") throw fieldError("change", "is only for a change")
    if (request.causedIncidentIds !== undefined && request.type !== "PROBLEM") {
      throw fieldError("causedIncidentIds", "only a problem is created from incidents")
    }
    if (request.resolvesProblemId !== undefined && request.type !== "CHANGE") {
      throw fieldError("resolvesProblemId", "only a change is created from a problem")
    }
    // The outcome is written once the change is carried out, never with the draft.
    if (request.change?.outcomeNotes !== undefined) throw fieldError("change.outcomeNotes", "is recorded once the change is carried out")
    const change = request.change === undefined ? undefined : changeFields(request.change, null)

    const categoryId = request.categoryId ?? null
    if (categoryId !== null && !(await this.isPickable(categoryId))) {
      throw fieldError("categoryId", "is not an active category")
    }
    const teamId = categoryId === null ? null : await this.categories.routeTeam(orgId, categoryId)
    const priority = computePriority(request.impact, request.urgency)
    const now = this.clock.now()
    const clocked = request.type === "INCIDENT" || request.type === "SERVICE_REQUEST"

    const id = await this.prisma.transaction(async () => {
      await this.quota.consume(orgId, "TICKETS_CREATED")
      // Only the clocked types have a policy (DOMAIN.md §4.1); Problems and Changes never run a clock.
      const policy = clocked ? await this.sla.policyFor(orgId, request.type, priority) : null
      // The tickets a create links to are checked first, as the actor sees them (a 400 names the field).
      const linked = await this.linkTargets(orgId, actor, request)
      const assetIds = await this.assetTargets(orgId, actor, request.assetIds ?? [])
      const number = await this.tickets.nextNumber(orgId, request.type)
      const created = await this.tickets.create(
        orgId,
        {
        number,
        type: request.type,
        title: request.title,
        description: request.description,
        status: request.type === "CHANGE" ? "DRAFT" : "NEW",
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
        },
        { ...(request.problem === undefined ? {} : { problem: defined(request.problem) }), ...(change === undefined ? {} : { change }) },
      )
      const links = linked.map((target) =>
        request.type === "PROBLEM"
          ? { fromTicketId: target.id, toTicketId: created, relation: "CAUSED_BY" as const }
          : { fromTicketId: target.id, toTicketId: created, relation: "RESOLVED_BY" as const },
      )
      await this.links.createMany(orgId, links, actor.membershipId)
      await this.assetLinks.linkMany(orgId, created, assetIds)
      await this.audit.record(orgId, [
        {
          action: "TICKET_CREATED",
          entityType: "Ticket",
          entityId: created,
          diff: { type: request.type, priority, teamId, onBehalfOf: requesterId === actor.membershipId ? null : requesterId },
        },
        ...links.map((link): AuditEntry => ({ action: "TICKET_LINKED", entityType: "Ticket", entityId: created, diff: { ...link } })),
        ...assetIds.map((assetId): AuditEntry => ({ action: "TICKET_ASSET_LINKED", entityType: "Ticket", entityId: created, diff: { assetId } })),
      ])
      return created
    })
    await this.announce(orgId, id, [
      { event: { kind: "ticket-created", ticketId: id, actorMembershipId: actor.membershipId }, entityId: id, discriminator: "created" },
    ])
    return this.get(id)
  }

  /** Field-level rules are RBAC.md §6's table, read through `capabilitiesFor`. */
  async update(id: string, request: UpdateTicketRequest): Promise<Ticket> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const saved = await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, id, actor, this.visibility())
      const { row } = loaded
      const editable = new Set<string>(this.permissions.capabilitiesFor(actor, loaded.subject).editableFields)
      const { version, problem, change, ...fields } = request
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter(
        (field) => fields[field] !== undefined && fields[field] !== row[field],
      )
      // A Problem's or Change's own fields, compared with what is stored; the same capability list decides.
      const problemChanges = problem === undefined ? {} : changedOnly(defined(problem), row.problem)
      const changeChanges = change === undefined ? {} : changedOnly(changeFields(change, row.change), row.change)
      if (problem !== undefined && row.type !== "PROBLEM") throw fieldError("problem", "is only for a problem")
      // A known error IS its workaround (DOMAIN.md §2.2): it can be rewritten, never taken away.
      if (row.status === "KNOWN_ERROR" && problemChanges.workaround === null) {
        throw new ConflictProblem("A known error keeps its workaround; change it rather than clearing it")
      }
      if (change !== undefined && row.type !== "CHANGE") throw fieldError("change", "is only for a change")
      const refused = [...changed, ...Object.keys(problemChanges), ...Object.keys(changeChanges)].filter((field) => !editable.has(field))
      if (refused.length > 0) throw new NotPermittedProblem(`You can't change ${refused.join(", ")} on this ticket`)
      if (changed.length === 0 && Object.keys(problemChanges).length === 0 && Object.keys(changeChanges).length === 0) return false

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
      await this.tickets.updateDetails(orgId, id, { problem: problemChanges, change: changeChanges })
      const diff = {
        ...diffOf(row, changes),
        ...diffOf(row.problem ?? {}, problemChanges),
        ...diffOf(row.change ?? {}, changeChanges),
      }
      await this.audit.record(orgId, [{ action: "TICKET_UPDATED", entityType: "Ticket", entityId: id, diff }])
      return true
    })
    // An edit tells nobody (DOMAIN.md §8), but the pages showing the ticket refetch.
    if (saved === true) await this.announce(orgId, id, [])
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
    const assignee = await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, id, actor, this.visibility())
      this.permissions.assert(actor, "ticket:assign", loaded.subject)
      if (TERMINAL.has(loaded.row.status)) throw new ConflictProblem("A closed or cancelled ticket can't be reassigned")
      // Who may decide depends on the assignee and the team (DOMAIN.md §2.3): they hold still while a decision is pending.
      if (loaded.row.status === "AWAITING_APPROVAL") throw new ConflictProblem("A change awaiting a decision keeps its assignee and team")
      const changes = await this.assignment(orgId, request.assigneeMembershipId, request.teamId)
      const touched = changes.assigneeMembershipId ?? changes.teamId ?? null
      if (loaded.row.status === "NEW" && touched !== null) changes.status = "ASSIGNED"
      if (!(await this.tickets.updateVersioned(orgId, id, request.version, changes))) throw new StaleWriteProblem()
      await this.audit.record(orgId, [{ action: "TICKET_ASSIGNED", entityType: "Ticket", entityId: id, diff: diffOf(loaded.row, changes) }])
      return changes.assigneeMembershipId !== undefined && changes.assigneeMembershipId !== loaded.row.assigneeMembershipId
        ? changes.assigneeMembershipId
        : null
    })
    await this.announce(
      orgId,
      id,
      assignee === null
        ? []
        : [
            {
              event: { kind: "ticket-assigned", ticketId: id, actorMembershipId: actor.membershipId, assigneeMembershipId: assignee },
              entityId: id,
              // The version this write made: only one write can succeed from
              // `request.version`, so the job id is unique to it — unlike a
              // version read back after commit, which a concurrent write may
              // have moved.
              discriminator: `v${String(request.version + 1)}`,
            },
          ],
    )
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
    const moved = await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, id, actor, this.visibility())
      const { row } = loaded
      this.permissions.assert(actor, "ticket:transition", loaded.subject)
      const relation = { ...loaded.relation, approval: await this.approvalStanding(orgId, actor, row) }
      const now = this.clock.now()
      const check = checkTransition({
        type: row.type,
        ticket: transitionFacts(row),
        action: request.action,
        actor: relation,
        comment: request.comment ?? null,
        now,
        confirm: request.confirm === true,
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
          case "confirm-required":
            throw new ChangeWindowEarlyProblem(check.reason)
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
        case "workaround":
        case "submit":
        case "approve":
        case "reject":
          // Their effects are on the Problem's or Change's own rows, below.
          break
        case "complete":
        case "rollback":
          // The work is over, either way: auto-close counts seven days from here.
          changes.resolvedAt = now
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
      if (request.action === "workaround") await this.tickets.updateDetails(orgId, id, { problem: { knownErrorAt: now } })
      if (request.action === "approve" || request.action === "reject") {
        const selfApproved = request.action === "approve" && relation.approval === "self"
        const decision = request.action === "approve" ? "APPROVED" : "REJECTED"
        const reason = request.action === "reject" ? (request.comment?.body ?? null) : null
        await this.tickets.addApproval(orgId, { ticketId: id, approverMembershipId: actor.membershipId, decision, selfApproved, reason, decidedAt: now })
        entries.push({
          action: selfApproved ? "CHANGE_SELF_APPROVED" : decision === "APPROVED" ? "CHANGE_APPROVED" : "CHANGE_REJECTED",
          entityType: "Ticket",
          entityId: id,
          diff: { decision, ...(reason === null ? {} : { reason }) },
        })
      }
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
      return { to: check.row.to, assigned: changes.assigneeMembershipId ?? null, previousAssignee: row.assigneeMembershipId }
    })
    // One notification per person per move: a comment written with it rides
    // along, reaching whoever the move itself does not tell.
    const by = actor.membershipId
    const at = `v${String(request.version + 1)}`
    const comment = request.comment?.visibility ?? null
    const event: NotifyEvent =
      request.action === "reopen"
        ? { kind: "ticket-reopened", ticketId: id, actorMembershipId: by, comment }
        : request.action === "submit"
          ? { kind: "change-submitted", ticketId: id, actorMembershipId: by }
          : request.action === "approve" || request.action === "reject"
            ? { kind: "change-decided", ticketId: id, actorMembershipId: by, decision: request.action === "approve" ? "APPROVED" : "REJECTED", comment }
            : { kind: "status-changed", ticketId: id, actorMembershipId: by, to: moved.to, comment }
    const notices: Notice[] = [{ event, entityId: id, discriminator: at }]
    if (moved.assigned !== null && moved.assigned !== moved.previousAssignee) {
      notices.push({
        event: { kind: "ticket-assigned", ticketId: id, actorMembershipId: by, assigneeMembershipId: moved.assigned },
        entityId: id,
        discriminator: `${at}-assigned`,
      })
    }
    await this.announce(orgId, id, notices)
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
  private viewWhere(actor: TenantActor, query: TicketListQuery): ListFilter["where"] | null {
    const where = this.queueWhere(actor, query)
    return where === null || query.assetId === undefined ? where : { ...where, assets: { some: { assetId: query.assetId } } }
  }

  private queueWhere(actor: TenantActor, query: TicketListQuery): ListFilter["where"] | null {
    const status = query.status ?? { in: OPEN_STATUSES }
    const type = query.type === undefined ? {} : { type: query.type }
    switch (query.view) {
      case "all":
        return { ...type, ...(query.status === undefined ? {} : { status: query.status }) }
      case "mine":
        return { ...type, requesterMembershipId: actor.membershipId, ...(query.status === undefined ? {} : { status: query.status }) }
      case "assigned":
        return { ...type, assigneeMembershipId: actor.membershipId, status }
      case "teams": {
        const teamIds = actor.kind === "member" ? actor.teamIds : []
        return teamIds.length === 0 ? null : { ...type, teamId: { in: teamIds }, status }
      }
      case "open":
        return { ...type, status }
      case "unassigned":
        return { ...type, teamId: null, assigneeMembershipId: null, status }
      case "approvals": {
        // Changes awaiting a decision this actor may make (DOMAIN.md §2.3, rules 1 and 2):
        // an admin's are all of them, a lead's their teams'; never one's own.
        const awaiting: ListFilter["where"] = {
          type: "CHANGE",
          status: "AWAITING_APPROVAL",
          requesterMembershipId: { not: actor.membershipId },
          OR: [{ assigneeMembershipId: null }, { assigneeMembershipId: { not: actor.membershipId } }],
        }
        if (actor.role === "ADMIN" || actor.role === "OWNER") return awaiting
        const leads = actor.kind === "member" ? actor.leadOfTeamIds : []
        return leads.length === 0 ? null : { ...awaiting, teamId: { in: leads } }
      }
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

  /**
   * The tickets a create names to link: each must be one this actor can read
   * and may link, and of the type the relation joins — incidents for a new
   * Problem, a Problem for a new Change. Loaded in one go.
   */
  private async linkTargets(orgId: string, actor: TenantActor, request: CreateTicketRequest): Promise<TicketRow[]> {
    const [path, ids, type] =
      request.causedIncidentIds !== undefined
        ? (["causedIncidentIds", [...new Set(request.causedIncidentIds)], "INCIDENT"] as const)
        : request.resolvesProblemId !== undefined
          ? (["resolvesProblemId", [request.resolvesProblemId], "PROBLEM"] as const)
          : (["", [], "INCIDENT"] as const)
    if (ids.length === 0) return []
    const visible = await this.access.loadVisible(orgId, ids, actor, this.visibility())
    if (visible.length !== ids.length) throw fieldError(path, "names a ticket that does not exist")
    for (const target of visible) {
      if (target.row.type !== type) throw fieldError(path, `must name ${type === "INCIDENT" ? "incidents" : "a problem"}`)
      if (!this.permissions.can(actor, "ticket:link", target.subject)) throw new NotPermittedProblem("You can't link that ticket")
    }
    return visible.map((t) => t.row)
  }

  /**
   * The assets a new ticket is about (DOMAIN.md §9.3): each one the actor can
   * open — a requester's own — or the create is a 400 naming the field.
   */
  private async assetTargets(orgId: string, actor: TenantActor, requested: readonly string[]): Promise<string[]> {
    const ids = [...new Set(requested)]
    if (ids.length === 0) return []
    // Locked first, so an asset deleted mid-create is a 400 here rather than a foreign-key failure later.
    await this.assetLinks.lockMany(orgId, ids)
    const visible = await this.assets.visible(orgId, actor, ids)
    if (visible.length !== ids.length) throw fieldError("assetIds", "names an asset that does not exist")
    return ids
  }

  /**
   * May this actor decide on this Change (DOMAIN.md §2.3)? Rules 1 and 2 are
   * the `ticket:approve_change` grant — an admin, or a lead of the change's
   * team, never the change's own requester or assignee. Rule 3 is for an
   * owner who is one of those, and only when nobody else could decide: the
   * one-admin workspace still ships its changes, and the row says so.
   */
  private async approvalStanding(orgId: string, actor: TenantActor, row: TicketRow): Promise<ApprovalStanding> {
    if (row.type !== "CHANGE" || row.status !== "AWAITING_APPROVAL") return "none"
    const own = row.requesterMembershipId === actor.membershipId || row.assigneeMembershipId === actor.membershipId
    const lead = actor.kind === "member" && row.teamId !== null && actor.leadOfTeamIds.includes(row.teamId)
    if (this.permissions.can(actor, "ticket:approve_change", { lead, own })) return "eligible"
    // Rule 3 is a person's, never a token's: an API token is no one's last resort.
    if (!own || actor.role !== "OWNER" || actor.kind !== "member") return "none"
    const involved = [row.requesterMembershipId, ...(row.assigneeMembershipId === null ? [] : [row.assigneeMembershipId])]
    return (await this.tickets.hasOtherApprover(orgId, { teamId: row.teamId, involved })) ? "none" : "self"
  }

  private async isPickable(categoryId: string): Promise<boolean> {
    return (await this.categories.list(false)).some((c) => c.id === categoryId)
  }

  private async view(actor: TenantActor, loaded: LoadedTicket): Promise<Ticket> {
    const now = this.clock.now()
    const relation = { ...loaded.relation, approval: await this.approvalStanding(this.tenant.requireOrgId(), actor, loaded.row) }
    return toTicket(
      loaded.row,
      now,
      availableActions({ type: loaded.row.type, ticket: transitionFacts(loaded.row), actor: relation, now }),
      this.permissions.capabilitiesFor(actor, loaded.subject),
    )
  }

  /**
   * After commit, and before anything that could fail for the caller — the
   * read-back is a 404 for an agent who just moved a ticket out of their own
   * scope: tell the people concerned, and the streams showing the ticket.
   */
  private async announce(orgId: string, ticketId: string, notices: Notice[]): Promise<void> {
    await this.notifier.notifyAll(orgId, notices)
    await this.pulse.changed(orgId, ticketId)
  }

  private visibility(): AgentVisibility {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }
}

/** What the transition table's guards read off a ticket. */
function transitionFacts(row: TicketRow): TransitionTicket {
  return { status: row.status, closedAt: row.closedAt, problem: row.problem, change: row.change }
}

function sourceOf(actor: TenantActor): TicketSource {
  if (actor.kind === "service") return "API"
  return actor.role === "REQUESTER" ? "PORTAL" : "CONSOLE"
}

/**
 * A Change's fields from the wire: dates parsed, and the window checked
 * against what is stored for whichever end the request leaves alone — a
 * window ends after it starts (the database says so too).
 */
function changeFields(input: ChangeFieldsInput, stored: ChangeRow | null): ChangeChanges {
  const date = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v))
  const out: ChangeChanges = {}
  const start = date(input.plannedStart)
  const end = date(input.plannedEnd)
  if (start !== undefined) out.plannedStart = start
  if (end !== undefined) out.plannedEnd = end
  if (input.risk !== undefined) out.risk = input.risk
  if (input.implementationPlan !== undefined) out.implementationPlan = input.implementationPlan
  if (input.rollbackPlan !== undefined) out.rollbackPlan = input.rollbackPlan
  if (input.outcomeNotes !== undefined) out.outcomeNotes = input.outcomeNotes
  const from = start === undefined ? (stored?.plannedStart ?? null) : start
  const to = end === undefined ? (stored?.plannedEnd ?? null) : end
  if (from !== null && to !== null && to.getTime() <= from.getTime()) throw fieldError("change.plannedEnd", "must be after the planned start")
  return out
}

/** The entries of `next` that differ from `stored` — dates by instant. */
function changedOnly<T extends Record<string, unknown>>(next: T, stored: Record<string, unknown> | null): Partial<T> {
  const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)
  return Object.fromEntries(
    Object.entries(next).filter(([key, value]) => value !== undefined && !same(value, stored?.[key] ?? null)),
  ) as Partial<T>
}

function fieldError(path: string, message: string): ValidationProblem {
  return new ValidationProblem([{ path, message, code: "invalid_ticket" }])
}

/** An input with its absent keys gone — what `exactOptionalPropertyTypes` asks of a write. */
function defined<T extends Record<string, unknown>>(input: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> }
}

/** `{ field: { from, to } }` for the fields that moved (DOMAIN.md §7). */
function diffOf(row: Record<string, unknown>, changes: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v)
  return Object.fromEntries(
    Object.entries(changes).map(([field, to]) => [field, { from: iso(row[field] ?? null), to: iso(to ?? null) }]),
  )
}
