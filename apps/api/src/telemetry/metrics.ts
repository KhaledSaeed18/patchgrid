import { metrics, trace } from "@opentelemetry/api"

import { TenantLabels } from "./tenant-labels"

/**
 * The metrics that exist because the system is multi-tenant (ADR-0030). Plain
 * functions over the global meter: the no-op meter answers when no SDK was
 * started, so a repository, a job runner or a pure service records without
 * injecting anything. Attribute cardinality is the design: `org` is the top-N
 * tenants by volume and `other`, never every id.
 */
/** How many tenants get a series of their own on a per-tenant metric. */
export const TOP_TENANTS = 25
const tenants = new TenantLabels(TOP_TENANTS)

/**
 * Names carry no unit: the Prometheus exporter appends one from the
 * instrument's `unit` (`_milliseconds`, `_ratio`) and `_total` to counters,
 * so `http_request_duration` is `http_request_duration_milliseconds_bucket`
 * on the other side. The dashboard uses those names.
 *
 * Instruments are made on first use, not at import: the metrics API has no
 * proxy provider (unlike tracing), so an instrument created before the SDK
 * installs its meter would be a no-op forever. `main.ts` starts the SDK
 * before anything else loads; tests install an in-memory provider first.
 */
function instruments() {
  const meter = metrics.getMeter("patchgrid-api")
  return {
    httpDuration: meter.createHistogram("http_request_duration", {
      description: "Request duration by route, status and tenant — the first question (ADR-0030)",
      unit: "ms",
    }),
    dbTransactionDuration: meter.createHistogram("db_transaction_duration", { description: "One interactive transaction, by tenant", unit: "ms" }),
    dbTransactionsPerRequest: meter.createHistogram("db_transactions_per_request", {
      description: "Transactions one request opened — an N+1 becomes N pooled connections",
      unit: "1",
    }),
    jobDuration: meter.createHistogram("job_duration", { description: "A background job, by queue, outcome and tenant", unit: "ms" }),
    rlsDenied: meter.createCounter("rls_denied_total", { description: "Statements Postgres refused under row-level security — a non-zero value is a bug" }),
    slaBreaches: meter.createCounter("sla_breaches_total", { description: "SLA breaches flagged, by tenant and priority" }),
    quotaRejections: meter.createCounter("quota_rejections_total", { description: "Writes refused by a plan limit, by tenant and metric" }),
    authorizationDecisions: meter.createCounter("authorization_decisions_total", { description: "Permission decisions by permission and outcome" }),
    outboxEventAge: meter.createHistogram("outbox_event_age", {
      description: "How long an event waited in the outbox before its consumer read it, by consumer and tenant (ADR-0049)",
      unit: "ms",
      // Delivery latency spans milliseconds to a stuck consumer's minutes; the default buckets stop at 10 s.
      advice: { explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000, 900_000] },
    }),
    outboxDrains: meter.createCounter("outbox_drains_total", { description: "Drains by consumer and outcome: drained, idle, held back by the horizon, busy" }),
    reportingDrift: meter.createCounter("reporting_drift_total", { description: "Reporting facts the reconcile had to rewrite, by tenant — after the first build, any value is a missed write" }),
    outboxParked: meter.createCounter("outbox_events_parked_total", { description: "Events a consumer gave up on, by consumer and tenant — any value needs a look" }),
  }
}
let made: ReturnType<typeof instruments> | undefined
const the = () => (made ??= instruments())

export function recordHttpRequest(input: { method: string; route: string; status: number; orgId: string | null | undefined; durationMs: number }): void {
  the().httpDuration.record(input.durationMs, {
    "http.request.method": input.method,
    "http.route": input.route,
    "http.response.status_code": input.status,
    org: tenants.labelFor(input.orgId),
  })
}

export function recordTransaction(input: { orgId: string | null; durationMs: number }): void {
  the().dbTransactionDuration.record(input.durationMs, { org: tenants.labelFor(input.orgId) })
}

export function recordTransactionsPerRequest(count: number, route: string): void {
  the().dbTransactionsPerRequest.record(count, { "http.route": route })
}

export function recordJob(input: { queue: string; orgId: string | null; outcome: "completed" | "failed"; durationMs: number }): void {
  the().jobDuration.record(input.durationMs, { queue: input.queue, outcome: input.outcome, org: tenants.labelFor(input.orgId) })
}

export function recordRlsDenied(orgId: string | null | undefined): void {
  the().rlsDenied.add(1, { org: tenants.labelFor(orgId) })
}

export function recordSlaBreach(orgId: string, priority: string): void {
  the().slaBreaches.add(1, { org: tenants.labelFor(orgId), priority })
}

export function recordQuotaRejection(orgId: string, metric: string): void {
  the().quotaRejections.add(1, { org: tenants.labelFor(orgId), metric })
}

/**
 * What a drain read (ADR-0049): each event's age at the moment its consumer
 * handled it. Per tenant, it is the fairness question — does one tenant's
 * flood make another's events wait — and the horizon's cost, made visible.
 */
export function recordOutboxConsumed(input: { consumer: string; orgId: string; ages: readonly number[] }): void {
  const attributes = { consumer: input.consumer, org: tenants.labelFor(input.orgId) }
  for (const age of input.ages) the().outboxEventAge.record(Math.max(0, age), attributes)
}

export function recordOutboxDrain(consumer: string, outcome: "drained" | "idle" | "held-back" | "busy"): void {
  the().outboxDrains.add(1, { consumer, outcome })
}

export function recordReportingDrift(orgId: string, facts: number): void {
  the().reportingDrift.add(facts, { org: tenants.labelFor(orgId) })
}

export function recordOutboxParked(consumer: string, orgId: string): void {
  the().outboxParked.add(1, { consumer, org: tenants.labelFor(orgId) })
}

/**
 * An authorization decision, on the active span and as a count (ADR-0030:
 * "for authorization spans the permission and its outcome"). No I/O, so the
 * pure `PermissionService` can call it: the span is whatever request or job
 * is running, or nothing.
 */
export function recordAuthorization(permission: string, allowed: boolean, actorKind: string | undefined): void {
  trace.getActiveSpan()?.addEvent("authorization", { permission, allowed, ...(actorKind === undefined ? {} : { "actor.kind": actorKind }) })
  the().authorizationDecisions.add(1, { permission, outcome: allowed ? "allowed" : "denied" })
}

/** Every span carries the tenant (ADR-0030): set once the credential is verified, on whatever span is active. */
export function tagActiveSpanWithTenant(input: { orgId?: string | undefined; membershipId?: string | undefined; actorKind?: string | undefined }): void {
  const span = trace.getActiveSpan()
  if (span === undefined) return
  span.setAttributes({
    ...(input.orgId === undefined ? {} : { "org.id": input.orgId }),
    ...(input.membershipId === undefined ? {} : { "membership.id": input.membershipId }),
    ...(input.actorKind === undefined ? {} : { "actor.kind": input.actorKind }),
  })
}

/** The active trace id, when a sampled trace is running: the request id that opens the waterfall (ADR-0030). */
export function activeTraceId(): string | undefined {
  const context = trace.getActiveSpan()?.spanContext()
  return context !== undefined && context.traceId !== "00000000000000000000000000000000" ? context.traceId : undefined
}

/**
 * Pool saturation, observed on demand: the resource every tenant shares. The
 * callback is whatever the Prisma adapter's pool reports at collection time.
 */
export function observePool(stats: () => { total: number; idle: number; waiting: number; max: number } | null): void {
  const meter = metrics.getMeter("patchgrid-api")
  const saturation = meter.createObservableGauge("db_pool_saturation", { description: "Connections in use over the pool ceiling (0–1)", unit: "1" })
  const waiting = meter.createObservableGauge("db_pool_waiting", { description: "Callers waiting for a pooled connection" })
  meter.addBatchObservableCallback(
    (result) => {
      const s = stats()
      if (s === null) return
      result.observe(saturation, s.max === 0 ? 0 : (s.total - s.idle) / s.max)
      result.observe(waiting, s.waiting)
    },
    [saturation, waiting],
  )
}

/**
 * Postgres refused a statement under a row-level security policy — error
 * 42501, surfaced by the pg driver inside whatever Prisma wrapped it in. Found
 * by walking the error rather than by class, because the adapter's wrapping
 * changes between releases and the code does not.
 */
export function isRlsDenied(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 4) return false
  const record = error as Record<string, unknown>
  if (record.code === "42501") return true
  if (typeof record.message === "string" && /row-level security policy/i.test(record.message)) return true
  return ["cause", "meta", "driverAdapterError", "originalError"].some((key) => isRlsDenied(record[key], depth + 1))
}
