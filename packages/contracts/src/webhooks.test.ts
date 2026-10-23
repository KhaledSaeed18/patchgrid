import { describe, expect, it } from "vitest"

import {
  createWebhookEndpointRequestSchema,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SECRET_PATTERN,
  webhookEventDataSchema,
  webhookPayloadSchema,
} from "./webhooks.ts"

const ID = "0190b2f0-0000-7000-8000-00000000000a"

describe("webhook endpoints", () => {
  const valid = { url: "https://hooks.example.com/patchgrid", eventTypes: ["ticket.created"] }

  it("takes an https URL and at least one known event type, each once", () => {
    expect(createWebhookEndpointRequestSchema.safeParse(valid).success).toBe(true)
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, eventTypes: [] }).success).toBe(false)
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, eventTypes: ["ticket.created", "ticket.created"] }).success).toBe(false)
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, eventTypes: ["comment.internal_created"] }).success).toBe(false)
  })

  it("refuses credentials in the URL, other schemes and unknown fields", () => {
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, url: "https://user:pw@hooks.example.com/" }).success).toBe(false)
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, url: "ftp://hooks.example.com/" }).success).toBe(false)
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, url: "file:///etc/passwd" }).success).toBe(false)
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, secret: "mine" }).success).toBe(false)
  })
})

describe("the event catalogue", () => {
  it("has a data shape for every type, and no internal notes", () => {
    const shaped = webhookEventDataSchema.options.map((o) => o.shape.type.value)
    expect([...shaped].sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort())
    expect(WEBHOOK_EVENT_TYPES.some((t) => t.includes("internal"))).toBe(false)
  })

  it("carries identifiers and states, never a title or a body", () => {
    const payload = {
      id: ID,
      type: "ticket.created",
      occurredAt: "2026-10-17T09:00:00.000Z",
      orgId: ID,
      data: {
        type: "ticket.created",
        ticket: { id: ID, number: "INC-000007", type: "INCIDENT", title: "Leaked?" },
        actorMembershipId: null,
      },
    }
    const parsed = webhookPayloadSchema.parse(payload)
    expect(JSON.stringify(parsed)).not.toContain("Leaked")
  })

  it("names the Standard Webhooks secret shape", () => {
    expect(WEBHOOK_SECRET_PATTERN.test(`whsec_${Buffer.alloc(24, 7).toString("base64")}`)).toBe(true)
    expect(WEBHOOK_SECRET_PATTERN.test("whsec_short")).toBe(false)
  })
})
