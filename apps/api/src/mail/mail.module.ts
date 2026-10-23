import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { MAIL_PROVIDER } from "./mail-provider"
import { MailProcessor } from "./mail.processor"
import { MAIL_QUEUE, MailService } from "./mail.service"
import { type AppConfig, APP_CONFIG } from "../config/app-config"
import { SesMailProvider } from "./providers/ses-mail.provider"
import { SmtpMailProvider } from "./providers/smtp-mail.provider"

/**
 * Outbound mail (ARCHITECTURE.md §Modules): the `MailProvider` boundary, with
 * SMTP or SES behind it as `MAIL_TRANSPORT` says, the `mail` queue, and the
 * processor. Services inject `MailService` and enqueue; nothing else sends.
 */
@Module({
  imports: [BullModule.registerQueue({ name: MAIL_QUEUE })],
  providers: [
    {
      provide: MAIL_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => (config.MAIL_TRANSPORT === "ses" ? new SesMailProvider() : new SmtpMailProvider(config)),
    },
    MailService,
    MailProcessor,
  ],
  exports: [MailService],
})
export class MailModule {}
