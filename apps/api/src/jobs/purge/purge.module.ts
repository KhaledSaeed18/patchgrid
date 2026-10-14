import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { PlatformModule } from "../../platform/platform.module"
import { StorageModule } from "../../storage/storage.module"
import { OrgPurgeProcessor, OrgPurgeService } from "./org-purge"
import { OrgPurgeRepository } from "./repositories/org-purge.repository"

/** The workspace purge (ADR-0043); the dispatcher feeds it the orgs past their window. */
@Module({
  imports: [PlatformModule, StorageModule, BullModule.registerQueue({ name: "org-purge" })],
  providers: [OrgPurgeRepository, OrgPurgeService, OrgPurgeProcessor],
})
export class PurgeModule {}
