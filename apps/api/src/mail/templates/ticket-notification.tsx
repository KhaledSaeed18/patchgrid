import { Button, FallbackLink, MailLayout } from "./layout"

export type TicketNotificationParams = {
  orgName: string
  /** What happened, as the inbox says it: "Assigned to you — INC-000042: Printer". */
  headline: string
  /** Why this person, in a few words: "you're the assignee". */
  reason: string
  ticketUrl: string
  preferencesUrl: string
}

/**
 * One in-app notification, also by email (DOMAIN.md §8): the inbox's line —
 * ticket number and title — and a link. Never a comment's body or the
 * description: a mailbox outlives access, and the link asks the API, which
 * decides again when it is opened.
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
      <p>
        <strong>{headline}</strong>
      </p>
      <p>In {orgName} on Patchgrid.</p>
      <Button href={ticketUrl}>Open the ticket</Button>
      <FallbackLink href={ticketUrl} />
    </MailLayout>
  )
}
