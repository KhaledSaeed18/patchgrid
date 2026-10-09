import { describe, expect, it } from "vitest"

import { notificationListQuerySchema } from "./notifications.ts"

describe("the inbox query", () => {
  it("lists everything by default, and only the unread when asked", () => {
    expect(notificationListQuerySchema.parse({})).toEqual({ unread: false, limit: 25 })
    expect(notificationListQuerySchema.parse({ unread: "true" }).unread).toBe(true)
    expect(notificationListQuerySchema.safeParse({ unread: "yes" }).success).toBe(false)
  })
})
