import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { MailModule } from "../mail/mail.module"
import { MembershipRepositoryModule } from "../memberships/membership-repository.module"
import { PlatformModule } from "../platform/platform.module"
import { StorageModule } from "../storage/storage.module"
import { ExportBuilder } from "./export-builder"
import { ExportProcessor, ExportRunner } from "./export.processor"
import { EXPORT_QUEUE, ExportsService } from "./exports.service"
import { ExportsController } from "./exports.controller"
import { ExportReaderRepository } from "./repositories/export-reader.repository"
import { OrgExportRepository } from "./repositories/org-export.repository"

/** Workspace export (M8, ADR-0028, ADR-0044): the owner's routes and the job that builds the zip. */
@Module({
  imports: [AuthModule, PlatformModule, MailModule, StorageModule, MembershipRepositoryModule, BullModule.registerQueue({ name: EXPORT_QUEUE })],
  controllers: [ExportsController],
  providers: [OrgExportRepository, ExportReaderRepository, ExportBuilder, ExportsService, ExportRunner, ExportProcessor],
  exports: [OrgExportRepository],
})
export class ExportsModule {}
