/**
 * Mail no person wrote to us (ADR-0027 §6): a bounce, an out-of-office, a
 * mailing list. Never a ticket, never answered — answering is how two
 * autoresponders loop. `header` reads one header, lower-cased name.
 */
export function automaticReason(header: (name: string) => string | undefined, fromAddress: string): string | null {
  const autoSubmitted = header("auto-submitted")?.trim().toLowerCase()
  if (autoSubmitted !== undefined && autoSubmitted !== "" && !autoSubmitted.startsWith("no")) return `Auto-Submitted: ${autoSubmitted}`
  const precedence = header("precedence")?.trim().toLowerCase()
  if (precedence !== undefined && ["bulk", "junk", "list", "auto_reply"].includes(precedence)) return `Precedence: ${precedence}`
  if (header("list-id") !== undefined || header("list-unsubscribe") !== undefined) return "mailing list"
  if (header("x-autoreply") !== undefined || header("x-autorespond") !== undefined) return "autoresponder"
  if (/^multipart\/report\b/i.test(header("content-type") ?? "")) return "delivery report"
  if (/^(mailer-daemon|postmaster)@/i.test(fromAddress)) return "bounce"
  return null
}
