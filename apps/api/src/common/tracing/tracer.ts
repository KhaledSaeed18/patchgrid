import { Inject } from "@nestjs/common"

/**
 * Instrumentation seam.
 *
 * The real OpenTelemetry implementation is an M9 item (ADR-0030), but the *seam*
 * ships now, with a no-op behind it. Retrofitting instrumentation through a
 * finished codebase is why most projects never add it; adding the interface now
 * costs an indirection and makes the later swap a one-provider change.
 *
 * Every span carries the tenant. A trace that cannot say whose request it was is
 * a single-tenant trace, which is not the system we are building.
 */
export const TRACER = Symbol("TRACER")

export const InjectTracer = (): ParameterDecorator => Inject(TRACER)

export type SpanAttributes = Readonly<Record<string, string | number | boolean | undefined>>

export interface Span {
  setAttributes(attributes: SpanAttributes): void
  recordError(error: unknown): void
  end(): void
}

export interface Tracer {
  startSpan(name: string, attributes?: SpanAttributes): Span
  /** Runs `fn` inside a span, ending it even when `fn` throws. */
  withSpan<T>(name: string, attributes: SpanAttributes, fn: (span: Span) => Promise<T>): Promise<T>
}

const NOOP_SPAN: Span = {
  setAttributes: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
}

export class NoopTracer implements Tracer {
  startSpan(): Span {
    return NOOP_SPAN
  }

  async withSpan<T>(
    _name: string,
    _attributes: SpanAttributes,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return fn(NOOP_SPAN)
  }
}
