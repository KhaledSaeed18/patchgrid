import { describe, expect, it } from "vitest"

import { notificationHref } from "./notification-link"

describe("notificationHref", () => {
  it("opens the ticket a notification is about, and the usage for a plan limit", () => {
    expect(notificationHref({ type: "TICKET_ASSIGNED", ticketId: "0190b2f0-0000-7000-8000-000000000001" })).toBe("/tickets/0190b2f0-0000-7000-8000-000000000001")
    expect(notificationHref({ type: "PLAN_LIMIT_REACHED", ticketId: null })).toBe("/settings")
    expect(notificationHref({ type: "TICKET_ASSIGNED", ticketId: null })).toBeNull()
  })
})
