import { Injectable } from "@nestjs/common"
import { createTransport, type Transporter } from "nodemailer"

import { InjectConfig, type AppConfig } from "../../config/app-config"
import type { MailProvider, OutboundMail } from "../mail-provider"

/**
 * Plain SMTP — Mailpit locally, any relay that speaks it elsewhere. No
 * authentication is configured yet because Mailpit accepts anything; a real
 * relay adds `SMTP_USER` / `SMTP_PASSWORD` to the env contract when it exists.
 */
@Injectable()
export class SmtpMailProvider implements MailProvider {
  private readonly transport: Transporter

  constructor(@InjectConfig() config: AppConfig) {
    this.transport = createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: false,
      // A relay that hangs must not hang the worker.
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    })
  }

  async send(mail: OutboundMail): Promise<{ providerMessageId: string }> {
    const info: { messageId: string } = await this.transport.sendMail({
      from: mail.from,
      to: mail.to,
      ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    })
    return { providerMessageId: info.messageId }
  }
}
