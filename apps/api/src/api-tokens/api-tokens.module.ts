import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { MailModule } from "../mail/mail.module"
import { PlatformModule } from "../platform/platform.module"
import { ApiTokenCoreModule } from "./api-token-core.module"
import { ApiTokenSweepProcessor, ApiTokenSweepService } from "./api-token-sweep"
import { ApiTokensController } from "./api-tokens.controller"
import { ApiTokensService } from "./api-tokens.service"

/** Scoped API tokens (M8, ADR-0021, ADR-0042): the admin routes and the expiry warning. */
@Module({
  imports: [AuthModule, PlatformModule, MailModule, ApiTokenCoreModule, BullModule.registerQueue({ name: "api-token-sweep" })],
  controllers: [ApiTokensController],
  providers: [ApiTokensService, ApiTokenSweepService, ApiTokenSweepProcessor],
})
export class ApiTokensModule {}
