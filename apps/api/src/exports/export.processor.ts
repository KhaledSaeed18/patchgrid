import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { EXPORT_LINK_HOURS } from "@patchgrid/contracts"
import { type Job, UnrecoverableError } from "bullmq"
import { z } from "zod"

import { type Clock, InjectClock } from "../common/clock/clock"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { PublicUrls } from "../common/urls"
import { MailService } from "../mail/mail.service"
import { OrganizationRepository } from "../platform/repositories/organization.repository"
import { PrismaService } from "../prisma/prisma.service"
import { StorageService } from "../storage/storage.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { sizeLabel } from "./domain"
import { ExportBuilder } from "./export-builder"
import { EXPORT_QUEUE } from "./exports.service"
import { OrgExportRepository } from "./repositories/org-export.repository"

const HOUR_MS = 60 * 60_000
const exportJobSchema = z.object({ orgId: z.uuid(), exportId: z.uuid() })

/**
 * Builds one export, inside its tenant (ADR-0044). One attempt: a failed
 * export is marked so, does not count against the owner's daily allowance,
 * and can simply be asked for again — a retry here would only race that.
 */
@Injectable()
export class ExportRunner {
  private readonly logger = new Logger(ExportRunner.name)

  constructor(
    private readonly exports: OrgExportRepository,
    private readonly builder: ExportBuilder,
    private readonly organizations: OrganizationRepository,
    private readonly storage: StorageService,
    private readonly urls: PublicUrls,
    private readonly mail: MailService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async run(exportId: string): Promise<boolean> {
    const orgId = this.tenant.requireOrgId()
    if (!(await this.prisma.transaction(() => this.exports.start(orgId, exportId)))) return false
    const org = await this.organizations.findProfileById(orgId)
    if (org === null) return false
    try {
      const takenAt = this.clock.now()
      const built = await this.builder.build(orgId, exportId, { name: org.name, slug: org.slug }, takenAt)
      const readyAt = this.clock.now()
      const expiresAt = new Date(readyAt.getTime() + EXPORT_LINK_HOURS * HOUR_MS)
      await this.prisma.transaction(() => this.exports.ready(orgId, exportId, { ...built, readyAt, expiresAt }))
      await this.tell(orgId, exportId, org.name, built, expiresAt)
      return true
    } catch (error) {
      this.logger.error({ msg: "export failed", orgId, exportId, error: String(error) })
      await this.prisma.transaction(() => this.exports.fail(orgId, exportId, "The export could not be built; ask for another"))
      throw new UnrecoverableError(`export ${exportId} failed`)
    }
  }

  /** After the row says ready: the link is the archive, valid as long as it is. */
  private async tell(orgId: string, exportId: string, orgName: string, built: { storageKey: string; sizeBytes: number }, expiresAt: Date): Promise<void> {
    try {
      const row = await this.prisma.transaction(() => this.exports.find(orgId, exportId))
      // Whoever asked may have lost the right to the whole workspace while it was made: Settings still has it for owners.
      if (row?.requestedBy.role !== "OWNER" || row.requestedBy.status !== "ACTIVE") return
      const to = row.requestedBy.user?.email
      if (to === undefined) return
      // The mail names where the export is, never the archive itself: a presigned link in an inbox
      // is a bearer capability to the whole workspace for a day (M9 review). Settings signs the
      // owner in and issues a short link on the click.
      const slug = (await this.organizations.findProfileById(orgId))?.slug
      if (slug === undefined) return
      const downloadUrl = this.urls.workspace(slug, "/settings")
      await this.mail.enqueueAll([
        {
          entityId: `${exportId}.ready`,
          job: {
            kind: "export-ready" as const,
            to,
            orgId,
            fromName: orgName,
            params: { orgName, downloadUrl, expiresOn: expiresAt.toUTCString(), sizeLabel: sizeLabel(built.sizeBytes) },
          },
        },
      ])
    } catch (error) {
      this.logger.error({ msg: "export mail not queued", orgId, exportId, error: String(error) })
    }
  }
}

@Processor(EXPORT_QUEUE, { autorun: false })
export class ExportProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly runner: ExportRunner,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<boolean> {
    const parsed = exportJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`export job ${String(job.id)} does not name its tenant`)
    const { orgId, exportId } = parsed.data
    return runJob({ orgId }, "job:org-export", "build a workspace export", () => this.runner.run(exportId))
  }
}
