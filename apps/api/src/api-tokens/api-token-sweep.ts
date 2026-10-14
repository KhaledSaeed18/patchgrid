import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { PublicUrls } from "../common/urls"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { readTenantSweep } from "../jobs/sweeps"
import { MailService } from "../mail/mail.service"
import { OrganizationRepository } from "../platform/repositories/organization.repository"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { ApiTokenRepository } from "./repositories/api-token.repository"

/** How far ahead a lapsing token is warned about (ADR-0042). */
export const EXPIRY_WARNING_DAYS = 7
const DAY_MS = 24 * 60 * 60_000

/**
 * Hourly, per tenant: a token lapsing within a week, not yet warned about,
 * gets one email — to its creator while they can still act on it, otherwise
 * to the owners (ADR-0042). Marking it warned first is what makes "once" hold
 * when two sweeps overlap; a mail that cannot be queued is logged, and the
 * list in settings still says when the token lapses.
 */
@Injectable()
export class ApiTokenSweepService {
  private readonly logger = new Logger(ApiTokenSweepService.name)

  constructor(
    private readonly tokens: ApiTokenRepository,
    private readonly organizations: OrganizationRepository,
    private readonly mail: MailService,
    private readonly urls: PublicUrls,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async sweep(): Promise<number> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const due = await this.tokens.expiringUnwarned(orgId, now, new Date(now.getTime() + EXPIRY_WARNING_DAYS * DAY_MS))
    if (due.length === 0) return 0
    const org = await this.organizations.findProfileById(orgId)
    if (org === null) return 0
    let warned = 0
    for (const token of due) {
      if (token.expiresAt === null || !(await this.tokens.markWarned(orgId, token.id, now))) continue
      warned += 1
      try {
        const to = await this.tokens.warningAddresses(orgId, token.createdByMembershipId)
        await this.mail.enqueueAll(
          to.map((address, i) => ({
            entityId: `${token.id}.expiring.${String(i)}`,
            job: {
              kind: "api-token-expiring" as const,
              to: address,
              orgId,
              fromName: org.name,
              params: {
                orgName: org.name,
                tokenName: token.name,
                prefix: token.prefix,
                expiresOn: `on ${token.expiresAt?.toUTCString() ?? ""}`,
                settingsUrl: this.urls.workspace(org.slug, "/settings/api-tokens"),
              },
            },
          })),
        )
      } catch (error) {
        this.logger.error({
          msg: "token expiry mail not queued",
          orgId,
          tokenId: token.id,
          error: String(error),
        })
      }
    }
    return warned
  }
}

@Processor("api-token-sweep", { autorun: false })
export class ApiTokenSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: ApiTokenSweepService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:api-token-sweep", "warn about api tokens about to lapse", () => this.service.sweep())
  }
}
