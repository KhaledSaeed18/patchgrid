import { Module } from "@nestjs/common"

import { AuthModule } from "../../auth/auth.module"
import { PlatformModule } from "../platform.module"
import { BackofficeController } from "./backoffice.controller"
import { SupportCoreModule } from "../../support/support-core.module"
import { BackofficeService } from "./backoffice.service"
import { PlatformSupportService } from "./platform-support.service"
import { BackofficeRepository } from "./repositories/backoffice.repository"

/** The operators' back-office (M8): workspaces as metadata, and the few changes an operator may make. */
@Module({
  imports: [AuthModule, PlatformModule, SupportCoreModule],
  controllers: [BackofficeController],
  providers: [BackofficeRepository, BackofficeService, PlatformSupportService],
})
export class BackofficeModule {}
