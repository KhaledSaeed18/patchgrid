import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AttachmentsModule } from "../../attachments/attachments.module"
import { ExportsModule } from "../../exports/exports.module"
import { StorageModule } from "../../storage/storage.module"
import { AttachmentSweepProcessor, AttachmentSweepService } from "./attachment-sweep"
import { RetentionRepository } from "./repositories/retention.repository"
import { RetentionSweepProcessor, RetentionSweepService } from "./retention-sweep"

/** Per-tenant housekeeping with no domain module of its own yet; the dispatcher feeds it. */
@Module({
  imports: [
    AttachmentsModule,
    ExportsModule,
    StorageModule,
    BullModule.registerQueue({ name: "attachment-sweep" }, { name: "retention-sweep" }),
  ],
  providers: [AttachmentSweepService, AttachmentSweepProcessor, RetentionRepository, RetentionSweepService, RetentionSweepProcessor],
})
export class MaintenanceModule {}
