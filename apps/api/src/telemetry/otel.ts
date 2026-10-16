import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis"
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg"
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import process from "node:process"

/**
 * The OpenTelemetry SDK (ADR-0030, ADR-0046). Started before anything else is
 * required, because the instrumentations patch `http`, `pg`, `ioredis` and
 * `pino` as they load — a module required earlier is a module left dark.
 *
 * Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector: tests and a
 * plain `pnpm dev` pay nothing, and the API-level tracer and meter fall back
 * to the SDK's no-ops. Everything exported is ids and durations — the same
 * rule as the logs, no PII in a span or a label.
 */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): NodeSDK | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (endpoint === undefined || endpoint === "") return null

  if (env.OTEL_LOG_LEVEL === "debug") diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? "patchgrid-api",
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? "dev",
      "deployment.environment.name": env.NODE_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 15_000),
    }),
    instrumentations: [
      new HttpInstrumentation({
        // Probes every few seconds would be most of the traces and none of the signal.
        ignoreIncomingRequestHook: (request) => request.url?.startsWith("/health") === true,
        // A query string is where bearer capabilities (an invitation's token) and
        // tenant text (a search) travel; neither belongs in a span (M9 review).
        redactedQueryParams: ["token", "q", "cursor"],
      }),
      // Not the Express or Nest instrumentations: they re-wrap every middleware
      // and guard in their own async context, which loses the request store
      // the tenant resolver fills in (`nestjs-cls`) before the auth guard reads
      // it. The HTTP span is the request; the route lands on it from the
      // middleware, and the domain spans come from the `Tracer` seam.
      // Log lines get `trace_id` and `span_id`, so a line opens its trace and a trace lists its lines.
      new PinoInstrumentation(),
      // The command only: keys carry addresses (throttles) and ids, values carry payloads.
      new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
      new PgInstrumentation({ requireParentSpan: true }),
    ],
  })
  sdk.start()

  const stop = () => void sdk.shutdown().catch(() => undefined)
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  return sdk
}
