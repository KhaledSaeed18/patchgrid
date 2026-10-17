import { Injectable } from "@nestjs/common"
import { type BulkProgressEvent, idSchema, type NotificationEvent, type TicketUpdatedEvent } from "@patchgrid/contracts"
import { concat, from, Observable, Subject } from "rxjs"

import { ActorService, type MemberActor } from "../../auth/actor"
import { StandingService } from "../../auth/sessions/standing.service"
import { PermissionService } from "../../authz/permission.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { NotAuthenticatedProblem, NotPermittedProblem } from "../../common/problems/problem.exception"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { type Reader, TicketAudience } from "../audience"
import { NotificationRepository } from "../repositories/notification.repository"
import { StreamBus, type StreamMessage } from "./stream-bus"

/** One server-sent event, or a comment line that keeps proxies from closing an idle stream. */
export type StreamFrame =
  | { event: "notification"; id: string; data: NotificationEvent }
  | { event: "ticket-updated"; data: TicketUpdatedEvent }
  | { event: "bulk-progress"; data: BulkProgressEvent }
  | { comment: string }

export const HEARTBEAT_MS = 25_000
/** Streams end routinely so reconnection is exercised, not discovered (ARCHITECTURE.md §Frontend). */
export const MAX_STREAM_MS = 30 * 60_000
/** A reconnect replays at most this many rows; the client reads the inbox for the rest. */
export const REPLAY_LIMIT = 50
/** Open streams per member on one instance; a new one past this ends the oldest — a leaked tab, not a feature. */
export const MAX_STREAMS_PER_MEMBER = 5

/**
 * The live stream for one member in one workspace (ADR-0008, ADR-0018).
 *
 * - **Tenant**: the channel is the org the credential named — the request's
 *   tenant — and nothing in the request can choose another.
 * - **Notifications** go to their one recipient, who was checked against the
 *   ticket when the row was written.
 * - **`ticket-updated`** goes to every stream whose member may read the
 *   ticket, decided by `TicketAudience` — the same `scopeFor()` branches as a
 *   list query — over facts the event carries, so the fan-out does no I/O.
 * - **Lifetime**: no longer than the access token that opened it, nor than
 *   30 minutes. Every heartbeat asks `StandingService` whether the session
 *   still stands and re-reads the member's role and teams: a member who loses
 *   access stops hearing within one heartbeat, and nobody is heard on facts
 *   older than that (ADR-0036).
 */
@Injectable()
export class NotificationStreamService {
  constructor(
    private readonly bus: StreamBus,
    private readonly audience: TicketAudience,
    private readonly notifications: NotificationRepository,
    private readonly standing: StandingService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async open(lastEventId: string | undefined): Promise<Observable<StreamFrame>> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "notification:read", { self: true })
    if (actor.kind !== "member") throw new NotPermittedProblem()
    const credential = this.actors.credential()
    if (credential === undefined) throw new NotAuthenticatedProblem()
    const orgId = this.tenant.requireOrgId()
    let reader = readerOf(actor)

    // Subscribe before reading the replay, so nothing lands in the gap; an
    // event in both is harmless — the client treats every one as "refetch".
    const live = new Subject<StreamFrame>()
    const unsubscribe = await this.bus.subscribe(orgId, (message) => {
      const frame = this.frameFor(orgId, reader, message)
      if (frame !== null) live.next(frame)
    })
    let replay: StreamFrame[]
    try {
      replay = await this.replay(orgId, actor.userId, lastEventId)
    } catch (error) {
      unsubscribe()
      throw error
    }

    const lifetime = Math.max(0, Math.min(MAX_STREAM_MS, credential.expiresAt * 1000 - this.clock.now().getTime()))
    return new Observable<StreamFrame>((subscriber) => {
      const inner = concat(from(replay), live).subscribe(subscriber)
      const heartbeat = setInterval(() => {
        void this.standing.check(actor, credential.issuedAt).then(
          (current) => {
            if (current === null) return subscriber.complete()
            reader = readerOf(current)
            subscriber.next({ comment: "heartbeat" })
          },
          // The database is unreachable: end, and let the client's reconnect decide afresh.
          () => subscriber.complete(),
        )
      }, HEARTBEAT_MS)
      const expiry = setTimeout(() => subscriber.complete(), lifetime)
      const evict = this.register(actor.membershipId, () => subscriber.complete())
      return () => {
        clearInterval(heartbeat)
        clearTimeout(expiry)
        evict()
        inner.unsubscribe()
        live.complete()
        unsubscribe()
      }
    })
  }

  private readonly streams = new Map<string, Set<() => void>>()

  /** Tracks a member's streams on this instance, ending the oldest past the cap; returns the deregistration. */
  private register(membershipId: string, end: () => void): () => void {
    const mine = this.streams.get(membershipId) ?? new Set<() => void>()
    this.streams.set(membershipId, mine)
    mine.add(end)
    if (mine.size > MAX_STREAMS_PER_MEMBER) {
      const [oldest] = mine
      oldest?.()
    }
    return () => {
      mine.delete(end)
      if (mine.size === 0 && this.streams.get(membershipId) === mine) this.streams.delete(membershipId)
    }
  }

  /** Pure: what, if anything, this member's stream says about one bus message. */
  frameFor(orgId: string, reader: Reader, message: StreamMessage): StreamFrame | null {
    switch (message.kind) {
      case "notification":
        return message.membershipId === reader.membershipId ? { event: "notification", id: message.event.id, data: message.event } : null
      case "bulk-progress":
        return message.membershipId === reader.membershipId ? { event: "bulk-progress", data: message.event } : null
      case "ticket-updated": {
        const ticket = { ...message.ticket, watcherMembershipIds: new Set(message.ticket.watcherMembershipIds) }
        return this.audience.mayRead(orgId, reader, ticket, message.visibility, message.content)
          ? { event: "ticket-updated", data: message.event }
          : null
      }
    }
  }

  private async replay(orgId: string, userId: string, lastEventId: string | undefined): Promise<StreamFrame[]> {
    const after = idSchema.safeParse(lastEventId)
    if (!after.success) return []
    const rows = await this.notifications.since(orgId, userId, after.data, REPLAY_LIMIT)
    return rows.map((row) => ({
      event: "notification",
      id: row.id,
      data: { id: row.id, type: row.type, title: row.title, ticketId: row.ticketId },
    }))
  }
}

export function readerOf(actor: MemberActor): Reader {
  return {
    membershipId: actor.membershipId,
    userId: actor.userId,
    role: actor.role,
    teamIds: actor.teamIds,
    leadOfTeamIds: actor.leadOfTeamIds,
  }
}
