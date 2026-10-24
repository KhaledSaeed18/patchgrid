import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2"
import { Injectable } from "@nestjs/common"
import { createTransport, type Transporter } from "nodemailer"

import type { MailProvider, OutboundMail } from "../mail-provider"

/**
 * Amazon SES, v2 API (ADR-0058). nodemailer composes the MIME — the same
 * builder the SMTP provider uses, so the two cannot drift — and hands SES the
 * raw message, which is what lets `References` and `Auto-Submitted` through.
 *
 * Region, credentials and endpoint come from the SDK's default chain: the task
 * role and AWS_REGION on ECS, AWS_ENDPOINT_URL against an emulator. Nothing
 * here knows which.
 *
 * SES replaces `Message-ID` with its own, so a reply's `In-Reply-To` names
 * SES's id, not ours. Threading still holds: our id is also in `References`,
 * which the intake reads, and the subject carries the ticket number
 * (ADR-0039).
 */
@Injectable()
export class SesMailProvider implements MailProvider {
  private readonly transport: Transporter

  constructor() {
    this.transport = createTransport({ SES: { sesClient: new SESv2Client({}), SendEmailCommand } })
  }

  async send(mail: OutboundMail): Promise<{ providerMessageId: string }> {
    const info: { messageId: string } = await this.transport.sendMail({
      from: mail.from,
      to: mail.to,
      ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
      ...(mail.messageId === undefined ? {} : { messageId: mail.messageId }),
      ...(mail.headers === undefined ? {} : { headers: mail.headers }),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    })
    return { providerMessageId: info.messageId }
  }
}
