/**
 * The integration boundary for outbound mail (ARCHITECTURE.md §Integration
 * boundaries). Resend behind it in production, Mailpit over SMTP locally, a
 * recorder in tests. Nothing above this interface knows which.
 */
export type OutboundMail = {
  to: string
  /** Display name per tenant, envelope address always ours (ADR-0018). */
  from: { name: string; address: string }
  replyTo?: string
  subject: string
  html: string
  text: string
}

export interface MailProvider {
  send(mail: OutboundMail): Promise<{ providerMessageId: string }>
}

export const MAIL_PROVIDER = Symbol("MAIL_PROVIDER")
