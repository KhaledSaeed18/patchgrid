import { Injectable, Logger } from "@nestjs/common"
import type { Request, Response } from "express"

import { AuditLogRepository } from "../../audit/repositories/audit-log.repository"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { runAsTenant } from "../../platform/run-as-tenant"
import { PrismaService } from "../../prisma/prisma.service"
import { SupportSessionRepository } from "../../support/repositories/support-session.repository"
import { SupportMail } from "../../support/support-mail"
import type { SupportActor } from "../actor"
import { RevocationEpochService } from "../revocation/revocation-epoch.service"
import { supportEpochKey } from "./support-token.service"

/** Ids recorded per read, at most — enough to know what was looked at, not a copy of it (ADR-0020). */
const MAX_IDS = 50

/** What a response carried, left on the request by `SupportReadInterceptor` for the record. */
export type SupportReadMarks = { supportIds?: string[] }

/**
 * One `SUPPORT_READ` per request a support session makes (ADR-0020,
 * ADR-0041), into the workspace's own audit log: the route, its status, the
 * ids it returned and the filters asked for. Registered on the response by
 * the auth guard, so it is written whatever the outcome — a refusal by any
 * guard, a 404, a read — and after the answer, outside its transaction: a
 * failed write does not fail the read, but it ends the session. If we cannot
 * record what was looked at, looking stops.
 */
@Injectable()
export class SupportReadLog {
  private readonly logger = new Logger(SupportReadLog.name)
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly auditLog: AuditLogRepository,
    private readonly sessions: SupportSessionRepository,
    private readonly epochs: RevocationEpochService,
    private readonly mail: SupportMail,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  watch(actor: SupportActor, request: Request & SupportReadMarks, response: Response): void {
    response.once("finish", () => {
      const write = this.write(actor, request, response.statusCode).finally(() => this.inFlight.delete(write))
      this.inFlight.add(write)
    })
  }

  /** Every record still being written — for a caller that must see them, such as a spec. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }

  private async write(actor: SupportActor, request: Request & SupportReadMarks, status: number): Promise<void> {
    const ids = request.supportIds ?? []
    const route = typeof request.route?.path === "string" ? request.route.path : request.path
    try {
      await runAsTenant(actor.orgId, { actor: `support:${actor.sessionId}`, reason: "record a support read" }, () =>
        this.prisma.transaction(() =>
          this.auditLog.append(actor.orgId, [
            {
              action: "SUPPORT_READ",
              entityType: "SupportSession",
              entityId: actor.sessionId,
              diff: { endpoint: `${request.method} ${route}`, status, entityIds: ids.slice(0, MAX_IDS), resultCount: ids.length, filters: request.query },
              actorKind: "PLATFORM",
              actorMembershipId: null,
              actorPlatformAdminId: actor.platformAdminId,
              supportSessionId: actor.sessionId,
              createdAt: this.clock.now(),
            },
          ]),
        ),
      )
    } catch (error) {
      this.logger.error({ msg: "support read not recorded: ending the session", orgId: actor.orgId, sessionId: actor.sessionId, error: String(error) })
      await this.endForAudit(actor)
    }
  }

  private async endForAudit(actor: SupportActor): Promise<void> {
    try {
      const ended = await runAsTenant(actor.orgId, { actor: `support:${actor.sessionId}`, reason: "end after a failed audit" }, () =>
        this.sessions.end(actor.orgId, actor.sessionId, "AUDIT_FAILED", this.clock.now()),
      )
      if (!ended) return
      await this.epochs.bump(supportEpochKey(actor.sessionId))
      await runAsTenant(actor.orgId, { actor: `support:${actor.sessionId}`, reason: "tell the owners" }, () =>
        this.mail.tell(actor.orgId, "ended", { id: actor.sessionId, operatorName: "Patchgrid support" }, "It was ended because a read could not be recorded in your audit log."),
      )
    } catch (error) {
      this.logger.error({ msg: "support session could not be ended after an audit failure", sessionId: actor.sessionId, error: String(error) })
    }
  }
}
