import type { MailProvider, OutboundMail } from "../mail-provider"

/** For tests: remembers what would have been sent. */
export class RecordingMailProvider implements MailProvider {
  readonly sent: OutboundMail[] = []

  async send(mail: OutboundMail): Promise<{ providerMessageId: string }> {
    this.sent.push(mail)
    return { providerMessageId: `recorded-${String(this.sent.length)}` }
  }
}
