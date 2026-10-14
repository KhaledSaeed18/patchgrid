import { Injectable } from "@nestjs/common"
import type { AuditAction } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { type Clock, InjectClock } from "../common/clock/clock"
import { AuditLogRepository, type AuditRow } from "./repositories/audit-log.repository"

export type AuditEntry = {
  action: AuditAction
  entityType: "Membership" | "Invitation" | "Team" | "Organization" | "SLAPolicy" | "Ticket" | "Comment" | "Asset" | "KnowledgeArticle" | "SupportSession" | "ApiToken"
  entityId: string
  /** `{ field: { from, to } }` for a change; context for an event. Never a secret. */
  diff?: Record<string, unknown>
}

/** Who did it, when the request's actor is not the right answer — a joiner acts before they are an actor. */
export type AuditActorOverride = { kind: "member"; membershipId: string } | { kind: "system" }

/**
 * Writes audit rows (DOMAIN.md §7). Call it inside the same `transaction()` as
 * the change: the audit write is part of the change, not a side effect of it,
 * so it can never record something that rolled back or miss something that
 * committed. The actor comes from the request unless the caller says otherwise.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditLogRepository,
    private readonly actors: ActorService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async record(orgId: string, entries: readonly AuditEntry[], actor?: AuditActorOverride): Promise<void> {
    const who = this.resolveActor(actor)
    const createdAt = this.clock.now()
    const rows: AuditRow[] = entries.map((entry) => ({
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      diff: entry.diff ?? {},
      ...who,
      createdAt,
    }))
    await this.repository.append(orgId, rows)
  }

  private resolveActor(actor?: AuditActorOverride): Pick<AuditRow, "actorKind" | "actorMembershipId" | "actorPlatformAdminId" | "supportSessionId"> {
    if (actor?.kind === "member") return { actorKind: "MEMBER", actorMembershipId: actor.membershipId }
    if (actor?.kind === "system") return { actorKind: "SYSTEM", actorMembershipId: null }
    const current = this.actors.current()
    if (current?.kind === "member") return { actorKind: "MEMBER", actorMembershipId: current.membershipId }
    if (current?.kind === "service") return { actorKind: "SERVICE", actorMembershipId: current.membershipId }
    // An operator reading inside a support session: named, with the session, in the tenant's own log (ADR-0041).
    if (current?.kind === "support") {
      return { actorKind: "PLATFORM", actorMembershipId: null, actorPlatformAdminId: current.platformAdminId, supportSessionId: current.sessionId }
    }
    // An operator in the back-office: named in the tenant's own log, as RBAC.md §8 requires.
    if (current?.kind === "platform") return { actorKind: "PLATFORM", actorMembershipId: null, actorPlatformAdminId: current.platformAdminId }
    return { actorKind: "SYSTEM", actorMembershipId: null }
  }
}
