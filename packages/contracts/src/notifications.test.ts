import { describe, expect, it } from "vitest"

import { emailWanted, notificationListQuerySchema, updateNotificationPreferencesSchema } from "./notifications.ts"

describe("the inbox query", () => {
  it("lists everything by default, and only the unread when asked", () => {
    expect(notificationListQuerySchema.parse({})).toEqual({ unread: false, limit: 25 })
    expect(notificationListQuerySchema.parse({ unread: "true" }).unread).toBe(true)
    expect(notificationListQuerySchema.safeParse({ unread: "yes" }).success).toBe(false)
  })
})

describe("email preferences", () => {
  it("are on unless turned off", () => {
    expect(emailWanted({}, "TICKET_ASSIGNED")).toBe(true)
    expect(emailWanted({ TICKET_ASSIGNED: false }, "TICKET_ASSIGNED")).toBe(false)
    expect(emailWanted({ TICKET_ASSIGNED: false }, "SLA_BREACHED")).toBe(true)
  })

  it("refuse a type that does not exist, and anything beside the email map", () => {
    expect(updateNotificationPreferencesSchema.safeParse({ email: { NOT_A_TYPE: false } }).success).toBe(false)
    expect(updateNotificationPreferencesSchema.safeParse({ email: {}, sms: {} }).success).toBe(false)
    expect(updateNotificationPreferencesSchema.parse({ email: { SLA_WARNING: false } })).toEqual({ email: { SLA_WARNING: false } })
  })
})
