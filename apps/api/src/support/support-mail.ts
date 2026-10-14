import { createHash } from "node:crypto"

import { Injectable, Logger } from "@nestjs/common"

import { PublicUrls } from "../common/urls"
import { MailService } from "../mail/mail.service"
import type { SupportEvent } from "../mail/templates/support-access"
import { OrganizationRepository } from "../platform/repositories/organization.repository"
import { SupportSessionRepository } from "./repositories/support-session.repository"

/**
 * Tells every owner about a turn in a support session (ADR-0020): asked,
 * granted, first used, ended. After the change has committed, never inside
 * it; a mail that cannot be queued is logged, and the session goes on — the
 * banner and the audit log say the same thing.
 */
@Injectable()
export class SupportMail {
  private readonly logger = new Logger(SupportMail.name)

  constructor(
    private readonly sessions: SupportSessionRepository,
    private readonly organizations: OrganizationRepository,
    private readonly mail: MailService,
    private readonly urls: PublicUrls,
  ) {}

  /** Inside the tenant's context: the owners are read there. */
  async tell(orgId: string, event: SupportEvent, session: { id: string; operatorName: string }, detail: string): Promise<void> {
    try {
      const [org, owners] = [await this.organizations.findProfileById(orgId), await this.sessions.ownerAddresses(orgId)]
      if (org === null) return
      await this.mail.enqueueAll(
        owners.map((owner) => ({
          entityId: `${session.id}.${event}.${createHash("sha256").update(owner.email).digest("hex").slice(0, 12)}`,
          job: {
            kind: "support-access" as const,
            to: owner.email,
            orgId,
            fromName: org.name,
            params: {
              orgName: org.name,
              operatorName: session.operatorName,
              event,
              detail,
              settingsUrl: this.urls.workspace(org.slug, "/settings/support"),
            },
          },
        })),
      )
    } catch (error) {
      this.logger.error({ msg: "support mail not queued", orgId, sessionId: session.id, event, error: String(error) })
    }
  }
}
