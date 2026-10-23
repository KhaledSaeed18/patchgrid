import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { SsoCoreModule } from "./sso-core.module"
import { SsoSettingsController } from "./sso-settings.controller"
import { SsoSettingsService } from "./sso-settings.service"

/** A workspace's SSO settings (ADR-0054). The sign-in itself lives with the other auth routes. */
@Module({
  imports: [AuthModule, SsoCoreModule],
  controllers: [SsoSettingsController],
  providers: [SsoSettingsService],
})
export class SsoModule {}
