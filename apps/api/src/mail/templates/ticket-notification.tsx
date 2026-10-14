import { REPLY_ABOVE_LINE } from "../../inbound/domain/reply-text"
import { Button, FallbackLink, MailLayout } from "./layout"

export type TicketNotificationParams = {
  orgName: string
  /** What happened, as the inbox says it: "Assigned to you — INC-000042: Printer". */
  headline: string
  /** Why this person, in a few words: "you're the assignee". */
  reason: string
  ticketUrl: string
  preferencesUrl: string
  ticketId: string
  ticketNumber: string
  replyTo: string
}

/**
 * One in-app notification, also by email (DOMAIN.md §8): the inbox's line —
 * ticket number and title — and a link. Never a comment's body or the
 * description: a mailbox outlives access, and the link asks the API, which
 * decides again when it is opened. A reply goes to the workspace's inbound
 * address and lands on the ticket (ADR-0027); the line above the text is
 * where the intake cuts what a reply quotes.
 */
export function TicketNotification({ orgName, headline, reason, ticketUrl, preferencesUrl }: TicketNotificationParams) {
  return (
    <MailLayout
      preview={headline}
      footer={
        <>
          You received this from {orgName} because {reason}. Choose what reaches your inbox in your{" "}
          <a href={preferencesUrl} style={{ color: "#7a736b" }}>
            notification preferences
          </a>
          .
        </>
      }
    >
      <p style={{ color: "#7a736b", fontSize: "12px" }}>{REPLY_ABOVE_LINE}</p>
      <p>
        <strong>{headline}</strong>
      </p>
      <p>In {orgName} on Patchgrid. Reply to this email to add to the ticket.</p>
      <Button href={ticketUrl}>Open the ticket</Button>
      <FallbackLink href={ticketUrl} />
    </MailLayout>
  )
}
