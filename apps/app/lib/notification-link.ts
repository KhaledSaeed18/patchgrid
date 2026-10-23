import type { Notification } from "@patchgrid/contracts"

/**
 * Where a notification takes its reader: the ticket it is about, or for one
 * about the workspace itself — a plan limit reached — the settings page that
 * shows its usage. `null` when there is nowhere to go.
 */
export function notificationHref(n: Pick<Notification, "type" | "ticketId">): string | null {
  if (n.ticketId !== null) return `/tickets/${n.ticketId}`
  if (n.type === "PLAN_LIMIT_REACHED") return "/settings"
  return null
}
