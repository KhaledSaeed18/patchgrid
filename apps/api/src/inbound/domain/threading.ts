import { findTicketNumberInSubject, type TicketType } from "@patchgrid/contracts"

/** What a message says it is about: a ticket id from our own Message-ID, or a number from its subject. */
export type TicketReference = { kind: "id"; ticketId: string } | { kind: "number"; type: TicketType; number: number }

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/** The Message-ID our ticket mail carries: `<t.<ticketId>.<unique>@<inbound domain>>`. */
export function ticketMessageId(ticketId: string, unique: string, inboundDomain: string): string {
  return `<t.${ticketId}.${unique}@${inboundDomain}>`
}

/**
 * `In-Reply-To` first, then `References`, newest last; then `[INC-000042]` in
 * the subject (ADR-0027 §5). Only a Message-ID at our own inbound domain
 * counts — and a reference is never authorization: the caller still checks
 * the sender takes part in the ticket.
 */
export function ticketReference(input: {
  inReplyTo: string | undefined
  references: readonly string[]
  subject: string
  inboundDomain: string
}): TicketReference | null {
  const ours = new RegExp(`^<?t\\.(${UUID})\\.[^@>]+@${escape(input.inboundDomain)}>?$`, "i")
  // A header may hold several ids, separated by whitespace (RFC 5322 §3.6.4).
  const ids = [input.inReplyTo ?? "", ...[...input.references].reverse()].flatMap((value) => value.split(/\s+/)).filter((v) => v !== "")
  for (const id of ids) {
    const match = ours.exec(id)
    if (match?.[1] !== undefined) return { kind: "id", ticketId: match[1].toLowerCase() }
  }
  const numbered = findTicketNumberInSubject(input.subject)
  return numbered === null ? null : { kind: "number", ...numbered }
}

/** A subject as a ticket title: no `Re:`/`Fwd:` chain, no `[INC-…]` tag, one line, at most 200 characters. */
export function titleFromSubject(subject: string): string {
  let title = subject.replace(/[\r\n]+/g, " ")
  for (let previous = ""; previous !== title;) {
    previous = title
    title = title.replace(/^\s*((re|fwd?|aw|wg|sv|tr)\s*(\[\d+\])?\s*:\s*)/i, "").replace(/^\s*\[[A-Za-z]{2,4}-\d{1,9}\]\s*/, "")
  }
  title = title.trim().replace(/\s+/g, " ")
  return title === "" ? "(no subject)" : title.slice(0, 200)
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
