import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AttachmentSweepProcessor, AttachmentSweepService } from "./attachment-sweep"

/** Per-tenant housekeeping with no domain module of its own yet; the dispatcher feeds it. */
@Module({
  imports: [BullModule.registerQueue({ name: "attachment-sweep" })],
  providers: [AttachmentSweepService, AttachmentSweepProcessor],
})
export class MaintenanceModule {}
