import { Injectable } from "@nestjs/common"
import { type Span as OtelSpan, SpanStatusCode, trace } from "@opentelemetry/api"

import type { Span, SpanAttributes, Tracer } from "../common/tracing/tracer"

/**
 * The `Tracer` seam, backed by OpenTelemetry (ADR-0030: "in M9 the no-op is
 * swapped for the real SDK and nothing else changes"). With no SDK started the
 * API hands back non-recording spans, so this is safe to provide everywhere;
 * the tests that care about no spans keep `NoopTracer`.
 */
@Injectable()
export class OtelTracer implements Tracer {
  private readonly tracer = trace.getTracer("patchgrid-api")

  startSpan(name: string, attributes: SpanAttributes = {}): Span {
    return wrap(this.tracer.startSpan(name, { attributes: defined(attributes) }))
  }

  withSpan<T>(name: string, attributes: SpanAttributes, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes: defined(attributes) }, async (span) => {
      const wrapped = wrap(span)
      try {
        return await fn(wrapped)
      } catch (error) {
        wrapped.recordError(error)
        throw error
      } finally {
        span.end()
      }
    })
  }
}

function wrap(span: OtelSpan): Span {
  return {
    setAttributes: (attributes) => void span.setAttributes(defined(attributes)),
    recordError: (error) => {
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      span.setStatus({ code: SpanStatusCode.ERROR })
    },
    end: () => span.end(),
  }
}

/** The seam allows `undefined` values; the SDK does not. */
function defined(attributes: SpanAttributes): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
  )
}
