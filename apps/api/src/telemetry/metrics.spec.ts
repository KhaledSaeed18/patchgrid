import { metrics } from "@opentelemetry/api"
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  isRlsDenied,
  recordHttpRequest,
  recordOutboxConsumed,
  recordOutboxDrain,
  recordOutboxParked,
  recordQuotaRejection,
  recordRlsDenied,
} from "./metrics"

/**
 * The meter is global and `metrics.ts` creates its instruments on first
 * import, so the provider is installed before the module loads.
 */
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })
let provider: MeterProvider

beforeAll(() => {
  provider = new MeterProvider({ readers: [reader] })
  metrics.setGlobalMeterProvider(provider)
})

afterAll(async () => {
  await provider.shutdown()
  metrics.disable()
})

async function collected(name: string) {
  const { resourceMetrics } = await reader.collect()
  return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)
}

describe("the multi-tenant metrics", () => {
  it("records request duration by route, status and a bounded tenant label — never the URL", async () => {
    recordHttpRequest({
      method: "GET",
      route: "/api/v1/tickets/:id",
      status: 200,
      orgId: "0190b2f0-0000-7000-8000-00000000000a",
      durationMs: 12,
    })
    recordHttpRequest({ method: "GET", route: "/api/v1/tickets/:id", status: 404, orgId: null, durationMs: 3 })
    const metric = await collected("http_request_duration")
    expect(metric).toBeDefined()
    const attributes = metric?.dataPoints.map((p) => p.attributes) ?? []
    expect(attributes).toContainEqual({
      "http.request.method": "GET",
      "http.route": "/api/v1/tickets/:id",
      "http.response.status_code": 200,
      org: "0190b2f0-0000-7000-8000-00000000000a",
    })
    expect(attributes).toContainEqual(expect.objectContaining({ "http.response.status_code": 404, org: "none" }))
  })

  it("counts quota rejections and policy refusals as they happen", async () => {
    recordQuotaRejection("0190b2f0-0000-7000-8000-00000000000a", "AGENT_SEATS")
    recordRlsDenied(undefined)
    const quota = await collected("quota_rejections_total")
    const rls = await collected("rls_denied_total")
    expect(quota?.dataPoints[0]).toMatchObject({ value: 1, attributes: expect.objectContaining({ metric: "AGENT_SEATS" }) })
    expect(rls?.dataPoints[0]).toMatchObject({ value: 1, attributes: { org: "none" } })
  })
})

describe("the outbox metrics (ADR-0049)", () => {
  const ORG = "0190b2f0-0000-7000-8000-00000000000b"

  it("records each event's age when its consumer read it, in buckets that reach a stuck consumer's minutes", async () => {
    recordOutboxConsumed({ consumer: "notify", orgId: ORG, ages: [40, 90_000, -3] })
    const age = await collected("outbox_event_age")
    const point = age?.dataPoints.find((p) => p.attributes.org === ORG)
    expect(point?.attributes).toEqual({ consumer: "notify", org: ORG })
    const value = point?.value as { count: number; min?: number; buckets: { boundaries: number[] } }
    expect(value.count).toBe(3)
    // A clock a millisecond behind the database is not a negative wait.
    expect(value.min).toBe(0)
    expect(value.buckets.boundaries).toContain(300_000)
  })

  it("counts drains by outcome and parked events by tenant", async () => {
    recordOutboxDrain("notify", "held-back")
    recordOutboxParked("notify", ORG)
    expect((await collected("outbox_drains_total"))?.dataPoints[0]).toMatchObject({
      value: 1,
      attributes: { consumer: "notify", outcome: "held-back" },
    })
    expect((await collected("outbox_events_parked_total"))?.dataPoints[0]).toMatchObject({
      value: 1,
      attributes: { consumer: "notify", org: ORG },
    })
  })
})

describe("isRlsDenied", () => {
  it("recognises Postgres 42501 wherever the adapter buried it, and nothing else", () => {
    expect(isRlsDenied({ code: "42501" })).toBe(true)
    expect(isRlsDenied(new Error('new row violates row-level security policy for table "Ticket"'))).toBe(true)
    expect(isRlsDenied({ message: "wrapped", meta: { driverAdapterError: { cause: { code: "42501" } } } })).toBe(true)
    expect(isRlsDenied({ code: "23505" })).toBe(false)
    expect(isRlsDenied(new Error("connection refused"))).toBe(false)
    expect(isRlsDenied(null)).toBe(false)
    expect(isRlsDenied("42501")).toBe(false)
  })
})
