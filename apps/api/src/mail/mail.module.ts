import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { MAIL_PROVIDER } from "./mail-provider"
import { MailProcessor } from "./mail.processor"
import { MAIL_QUEUE, MailService } from "./mail.service"
import { SmtpMailProvider } from "./providers/smtp-mail.provider"

/**
 * Outbound mail (ARCHITECTURE.md §Modules): the `MailProvider` boundary with
 * its SMTP implementation, the `mail` queue, and the processor. Services
 * inject `MailService` and enqueue; nothing else sends.
 */
@Module({
  imports: [BullModule.registerQueue({ name: MAIL_QUEUE })],
  providers: [{ provide: MAIL_PROVIDER, useClass: SmtpMailProvider }, MailService, MailProcessor],
  exports: [MailService],
})
export class MailModule {}
