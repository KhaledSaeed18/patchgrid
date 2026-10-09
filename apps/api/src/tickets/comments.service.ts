import { Injectable } from "@nestjs/common"
import { COMMENT_EDIT_WINDOW_MINUTES, type Comment, type CommentInput } from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { AuditService, type AuditEntry } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem } from "../common/problems/problem.exception"
import { PrismaService } from "../prisma/prisma.service"
import { SlaPoliciesService } from "../sla/sla-policies.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { onResponded, onResume } from "./domain/sla"
import { type CommentRow, CommentRepository } from "./repositories/comment.repository"
import { type TicketChanges, TicketRepository } from "./repositories/ticket.repository"
import { type LoadedTicket, TicketAccess } from "./ticket-access"

const WINDOW_MS = COMMENT_EDIT_WINDOW_MINUTES * 60_000

/**
 * The thread (DOMAIN.md §7). Internal notes are filtered in the query for
 * anyone who may not read them, so a requester-scoped read cannot return one.
 * A public reply from an agent is the ticket's response; a public reply from
 * its requester resumes a PENDING ticket. Editing never re-triggers either.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly comments: CommentRepository,
    private readonly tickets: TicketRepository,
    private readonly access: TicketAccess,
    private readonly sla: SlaPoliciesService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(ticketId: string): Promise<Comment[]> {
    const { actor, orgId, loaded } = await this.context(ticketId)
    const internal = this.permissions.can(actor, "comment:read_internal", loaded.subject)
    const rows = await this.comments.list(orgId, ticketId, internal)
    return rows.map((row) => this.toComment(actor, loaded, row))
  }

  async add(ticketId: string, input: CommentInput): Promise<Comment> {
    const { actor, orgId } = this.who()
    const row = await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, ticketId, actor, this.visibility())
      this.permissions.assert(
        actor,
        input.visibility === "PUBLIC" ? "comment:create_public" : "comment:create_internal",
        loaded.subject,
      )
      if (loaded.row.status === "CANCELLED") throw new ConflictProblem("A cancelled ticket takes no more comments")
      const now = this.clock.now()
      const created = await this.comments.create(orgId, {
        ticketId,
        authorMembershipId: actor.membershipId,
        authorKind: actor.kind === "service" ? "SERVICE" : "MEMBER",
        body: input.body,
        visibility: input.visibility,
      })
      const entries: AuditEntry[] = [
        { action: "COMMENT_ADDED", entityType: "Ticket", entityId: ticketId, diff: { commentId: created.id, visibility: input.visibility } },
      ]
      const changes: TicketChanges = {}
      if (input.visibility === "PUBLIC" && actor.role !== "REQUESTER") Object.assign(changes, onResponded(loaded.row, now))
      if (input.visibility === "PUBLIC" && loaded.row.status === "PENDING" && loaded.subject.own === true) {
        // The requester answered what the ticket was waiting on (DOMAIN.md §2.1).
        const policy = await this.sla.policyFor(orgId, loaded.row.type, loaded.row.priority)
        Object.assign(changes, { status: "IN_PROGRESS" }, onResume(loaded.row, now, policy))
        entries.push({
          action: "TICKET_TRANSITIONED",
          entityType: "Ticket",
          entityId: ticketId,
          diff: { action: "resume", from: "PENDING", to: "IN_PROGRESS", automatic: true },
        })
      }
      if (Object.keys(changes).length > 0) await this.tickets.update(orgId, ticketId, changes)
      await this.audit.record(orgId, entries)
      return { created, loaded }
    })
    return this.toComment(actor, row.loaded, row.created)
  }

  /** The author, within the window; the previous body goes to the audit trail. */
  async edit(ticketId: string, commentId: string, body: string): Promise<Comment> {
    const { actor, orgId } = this.who()
    const result = await this.prisma.transaction(async () => {
      const { loaded, comment } = await this.visibleComment(orgId, ticketId, commentId, actor)
      const now = this.clock.now()
      this.permissions.assert(actor, "comment:update_own", {
        self: comment.authorMembershipId === actor.membershipId,
        withinEditWindow: now.getTime() - comment.createdAt.getTime() <= WINDOW_MS,
      })
      await this.comments.edit(orgId, commentId, body, now)
      await this.audit.record(orgId, [
        { action: "COMMENT_EDITED", entityType: "Ticket", entityId: ticketId, diff: { commentId, previousBody: comment.body } },
      ])
      return { loaded, comment: { ...comment, body, editedAt: now } }
    })
    return this.toComment(actor, result.loaded, result.comment)
  }

  /** Soft, by an admin; the thread says a comment was removed, the audit trail keeps what it said. */
  async remove(ticketId: string, commentId: string): Promise<void> {
    const { actor, orgId } = this.who()
    await this.prisma.transaction(async () => {
      const { comment } = await this.visibleComment(orgId, ticketId, commentId, actor)
      this.permissions.assert(actor, "comment:delete")
      await this.comments.softDelete(orgId, commentId, actor.membershipId, this.clock.now())
      await this.audit.record(orgId, [
        { action: "COMMENT_DELETED", entityType: "Ticket", entityId: ticketId, diff: { commentId, previousBody: comment.body } },
      ])
    })
  }

  /** A comment the actor can see, on a ticket the actor can see — else 404; deleted ones are gone. */
  private async visibleComment(orgId: string, ticketId: string, commentId: string, actor: TenantActor) {
    const loaded = await this.access.load(orgId, ticketId, actor, this.visibility())
    const comment = await this.comments.find(orgId, ticketId, commentId)
    if (comment === null || comment.deletedAt !== null) throw new NotFoundProblem()
    if (comment.visibility === "INTERNAL") this.permissions.assertVisible(actor, "comment:read_internal", loaded.subject)
    return { loaded, comment }
  }

  private toComment(actor: TenantActor, loaded: LoadedTicket, row: CommentRow): Comment {
    const deleted = row.deletedAt !== null
    const now = this.clock.now()
    return {
      id: row.id,
      author: row.author === null ? null : { membershipId: row.author.id, displayName: row.author.displayName },
      authorKind: row.authorKind,
      body: deleted ? null : row.body,
      visibility: row.visibility,
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      canEdit:
        !deleted &&
        this.permissions.can(actor, "comment:update_own", {
          self: row.authorMembershipId === actor.membershipId,
          withinEditWindow: now.getTime() - row.createdAt.getTime() <= WINDOW_MS,
        }),
      canDelete: !deleted && this.permissions.can(actor, "comment:delete", loaded.subject),
    }
  }

  private who() {
    return { actor: this.actors.requireTenantActor(), orgId: this.tenant.requireOrgId() }
  }

  private async context(ticketId: string) {
    const { actor, orgId } = this.who()
    return { actor, orgId, loaded: await this.access.load(orgId, ticketId, actor, this.visibility()) }
  }

  private visibility() {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }
}
