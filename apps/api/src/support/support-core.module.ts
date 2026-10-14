import { Module } from "@nestjs/common"

import { MailModule } from "../mail/mail.module"
import { PlatformModule } from "../platform/platform.module"
import { SupportSessionRepository } from "./repositories/support-session.repository"
import { SupportMail } from "./support-mail"

/**
 * What every side of a support session shares (ADR-0041): the rows and the
 * owners' mail. Free of the auth module, so its guard can use both.
 */
@Module({
  imports: [MailModule, PlatformModule],
  providers: [SupportSessionRepository, SupportMail],
  exports: [SupportSessionRepository, SupportMail],
})
export class SupportCoreModule {}
