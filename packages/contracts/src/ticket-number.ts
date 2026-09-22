import { z } from "zod"

/**
 * Human-facing ticket numbers (ADR-0009).
 *
 * The database stores an integer `number` and the `type`; the string is derived,
 * here, so the API, the web client and the email-subject parser agree on one
 * format. Numbering is **per organization** — two tenants both having `INC-000001`
 * is correct and expected (ADR-0013).
 */

export const ticketTypeSchema = z.enum([
  "INCIDENT",
  "SERVICE_REQUEST",
  "PROBLEM",
  "CHANGE",
])
export type TicketType = z.infer<typeof ticketTypeSchema>

export const TICKET_TYPE_PREFIX = {
  INCIDENT: "INC",
  SERVICE_REQUEST: "SR",
  PROBLEM: "PRB",
  CHANGE: "CHG",
} as const satisfies Record<TicketType, string>

const PREFIX_TO_TYPE: Record<string, TicketType> = Object.fromEntries(
  Object.entries(TICKET_TYPE_PREFIX).map(([type, prefix]) => [prefix, type as TicketType]),
)

export const TICKET_NUMBER_PAD = 6

/** `formatTicketNumber("INCIDENT", 42)` → `"INC-000042"`. */
export function formatTicketNumber(type: TicketType, number: number): string {
  return `${TICKET_TYPE_PREFIX[type]}-${String(number).padStart(TICKET_NUMBER_PAD, "0")}`
}

/**
 * Parses `INC-000042`, `inc-42`, or a bare `42`.
 *
 * Lenient on purpose: this drives the search box short-circuit (`DOMAIN.md` §9.1)
 * and the `[INC-000042]` email-subject match, where a human may have retyped it.
 * A bare number has no type, so the caller searches every type.
 */
export function parseTicketNumber(
  input: string,
): { type: TicketType | null; number: number } | null {
  const trimmed = input.trim()

  const bare = /^#?(\d{1,9})$/.exec(trimmed)
  if (bare?.[1] !== undefined) {
    return { type: null, number: Number(bare[1]) }
  }

  const prefixed = /^([A-Za-z]{2,4})-(\d{1,9})$/.exec(trimmed)
  if (prefixed?.[1] === undefined || prefixed[2] === undefined) return null

  const type = PREFIX_TO_TYPE[prefixed[1].toUpperCase()]
  if (type === undefined) return null

  return { type, number: Number(prefixed[2]) }
}

/** Finds `[INC-000042]` in an email subject, for threading (ADR-0018). */
export function findTicketNumberInSubject(
  subject: string,
): { type: TicketType; number: number } | null {
  const match = /\[([A-Za-z]{2,4}-\d{1,9})\]/.exec(subject)
  if (match?.[1] === undefined) return null
  const parsed = parseTicketNumber(match[1])
  return parsed?.type == null ? null : { type: parsed.type, number: parsed.number }
}
