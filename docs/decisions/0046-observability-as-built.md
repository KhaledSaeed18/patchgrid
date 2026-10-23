# 0046 — Observability as built: the SDK before the app, metrics by top-N tenant, a trace id as the request id

- **Status:** Accepted
- **Date:** 2026-10-16
- **Refines:** [0030](0030-observability-opentelemetry-per-tenant.md)

> **Erratum (2026-10-23).** `db_transactions_per_request` counts every transaction a request opens: the
> interactive `transaction()` calls, and the batched one the tenant extension opens for each
> tenant-owned query outside them (its `onTransaction` hook). Counting only the first hid the N+1 the
> metric exists for, since an N+1 is usually N bare queries.

## Context

ADR-0030 decided OpenTelemetry with per-tenant dimensions and shipped the `Tracer` seam in M0. M9 puts
the SDK behind it. Three things turned out to need a decision rather than a straight implementation:
where the SDK starts, which tenants get a metric series of their own, and what the request id is once
there is a trace to open.

## Decision

### The SDK starts before the application is required

The instrumentations patch `http`, `pg`, `ioredis` and `pino` as those modules are first required. A
module loaded earlier stays dark. So `main.ts` is now three lines of intent — read the local `.env`,
`startTelemetry()`, then `require("./bootstrap")` — and everything Nest touches lives in `bootstrap.ts`.
The order is the whole point and the file says so.

Telemetry is **off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.** Tests and a plain `pnpm dev` pay
nothing; the API's `Tracer` is then the SDK's non-recording tracer and the meter a no-op. Locally,
`docker compose --profile observability up` runs the collector, Tempo, Prometheus and Grafana
(on 3100 — 3000 is the marketing site), and one line in `.env` turns the export on.

### Instruments are made on first use, not at import

The metrics API, unlike tracing, has no proxy provider: an instrument created before the SDK installs
its meter is a no-op forever. `telemetry/metrics.ts` therefore creates its instruments lazily. In
production the SDK is up before any module loads; in a test an in-memory provider is installed first.

### Which tenants get their own series

`org` on a metric is the top **25** tenants by request volume, counted in memory per process, and
`other` for the rest; `none` for tenant-less requests. Ranking uses the count *before* the current
observation, with ties broken by id, so equal-volume tenants do not take turns being named — the set is
stable until volumes actually change. The counts halve past a window rather than reset, so a tenant that
goes quiet makes room without the busy ones becoming strangers. Spans carry the real `org.id` always; the
bucketing is only for the time series, as ADR-0030 said.

The metrics, as ADR-0030 listed them. The Prometheus exporter appends the unit (`_milliseconds`,
`_ratio`) and `_total` to counters, so `http_request_duration` is `http_request_duration_milliseconds_bucket`
on the other side; the dashboard uses those names.

| Metric | Labels |
| --- | --- |
| `http_request_duration` | `http.request.method`, `http.route` (the pattern, never the URL), `http.response.status_code`, `org` |
| `db_transaction_duration` | `org` |
| `db_transactions_per_request` | `http.route` — interactive `transaction()` calls; every statement, inside one or not, is in the pg instrumentation's `db_client_operation_duration` |
| `db_pool_saturation`, `db_pool_waiting` | — (the one resource every tenant shares) |
| `job_duration` | `queue`, `outcome`, `org` |
| `rls_denied_total` | `org` — any value is a bug |
| `sla_breaches_total` | `org`, `priority` |
| `quota_rejections_total` | `org`, `metric` |
| `authorization_decisions_total` | `permission`, `outcome` |

They are recorded by plain functions over the global meter, so a repository, the job runner and the
pure `PermissionService` record without injecting anything. Request duration is measured by a
middleware on `finish`, inside the request context the guards filled in — an interceptor would miss the
refusals guards produce, which are exactly the answers one wants counted.

### A trace id is the request id

`genReqId` prefers the active trace id when one is sampled, so `X-Request-Id`, every log line's
`reqId` and the `correlationId` on a 5xx are the id that opens the trace in Tempo. A forwarded
`X-Request-Id` from a proxy still wins, as before. Pino lines also carry `trace_id` and `span_id` from
the instrumentation, so a line opens its trace and a trace lists its lines.

### Where the tenant lands on a span

The HTTP span gets `org.id`, `membership.id` and `actor.kind` once the credential is verified; a job's
span gets `org.id` and `actor.kind: job` from the one wrapper every processor uses. Every permission
decision adds an `authorization` event with the permission and its outcome to whatever span is active.
Ids only — the span rule is the log rule.

### Pool saturation comes from the driver pool

`createPrismaClient` now builds the `pg` pool itself and hands it to a callback; the API registers an
observable gauge over `totalCount`, `idleCount` and `waitingCount` against the configured ceiling. The
adapter's own pool was never reachable, and the gauge is the one ADR-0030 called the resource every
tenant shares.

## Consequences

- One dashboard, "which tenant is slow", answers it: p95 by tenant, errors by tenant, slowest routes,
  transactions per request by route, pool saturation, jobs by queue and tenant, breaches, quota
  rejections, and a stat that must read zero.
- The process pays a few microseconds per request and nothing at all when the endpoint is unset.
- A later backend is a change to the collector's config and nowhere in the application.
- Alerting stays out of scope, as ADR-0030 said; the shapes make the alerts obvious.
