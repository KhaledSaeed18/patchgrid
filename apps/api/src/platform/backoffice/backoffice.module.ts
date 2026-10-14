import { Module } from "@nestjs/common"

import { AuthModule } from "../../auth/auth.module"
import { PlatformModule } from "../platform.module"
import { BackofficeController } from "./backoffice.controller"
import { BackofficeService } from "./backoffice.service"
import { BackofficeRepository } from "./repositories/backoffice.repository"

/** The operators' back-office (M8): workspaces as metadata, and the few changes an operator may make. */
@Module({
  imports: [AuthModule, PlatformModule],
  controllers: [BackofficeController],
  providers: [BackofficeRepository, BackofficeService],
})
export class BackofficeModule {}
