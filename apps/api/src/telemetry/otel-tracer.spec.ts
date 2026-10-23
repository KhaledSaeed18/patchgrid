import { trace } from "@opentelemetry/api"
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { OtelTracer } from "./otel-tracer"

const exporter = new InMemorySpanExporter()
let provider: TracerProvider

beforeAll(() => {
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
  trace.setGlobalTracerProvider(provider)
})

beforeEach(() => exporter.reset())

afterAll(async () => {
  await provider.shutdown()
  trace.disable()
})

describe("OtelTracer", () => {
  it("runs the work inside a span that carries the attributes given, dropping undefined ones", async () => {
    const tracer = new OtelTracer()
    const result = await tracer.withSpan("ticket.transition", { "org.id": "o-1", action: "resolve", missing: undefined }, async (span) => {
      span.setAttributes({ "ticket.id": "t-1" })
      return 42
    })
    expect(result).toBe(42)
    const [span] = exporter.getFinishedSpans()
    expect(span?.name).toBe("ticket.transition")
    expect(span?.attributes).toEqual({ "org.id": "o-1", action: "resolve", "ticket.id": "t-1" })
    expect(span?.ended).toBe(true)
  })

  it("ends the span and marks it failed when the work throws, then rethrows", async () => {
    const tracer = new OtelTracer()
    await expect(tracer.withSpan("sla.compute", {}, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    const [span] = exporter.getFinishedSpans()
    expect(span?.status.code).toBe(2) // SpanStatusCode.ERROR
    expect(span?.events.map((e) => e.name)).toContain("exception")
  })

  it("hands out a span to end by hand, for the few places a callback does not fit", () => {
    const span = new OtelTracer().startSpan("permission.resolve", { permission: "ticket:read" })
    span.end()
    expect(exporter.getFinishedSpans().map((s) => [s.name, s.attributes])).toEqual([["permission.resolve", { permission: "ticket:read" }]])
  })
})
