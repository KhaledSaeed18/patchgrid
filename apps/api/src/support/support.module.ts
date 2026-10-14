import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"
import { APP_INTERCEPTOR } from "@nestjs/core"

import { AuthModule } from "../auth/auth.module"
import { PlatformModule } from "../platform/platform.module"
import { SupportCoreModule } from "./support-core.module"
import { SupportReadInterceptor } from "./support-read.interceptor"
import { SupportSweepProcessor, SupportSweepService } from "./support-sweep"
import { SupportController } from "./support.controller"
import { SupportService } from "./support.service"

/** Consent-based support access (M8, ADR-0020, ADR-0041): the workspace's side, the per-request audit, the expiry sweep. */
@Module({
  imports: [AuthModule, PlatformModule, SupportCoreModule, BullModule.registerQueue({ name: "support-sweep" })],
  controllers: [SupportController],
  providers: [SupportService, SupportSweepService, SupportSweepProcessor, { provide: APP_INTERCEPTOR, useClass: SupportReadInterceptor }],
  exports: [SupportService],
})
export class SupportModule {}
