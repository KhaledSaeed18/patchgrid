# 0030 — Observability: OpenTelemetry with per-tenant dimensions

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

`ENGINEERING.md` specified structured logs with `orgId` on every line, health endpoints, and nothing
else. For a single-tenant service that would be adequate. For a system where every customer shares a
process, a connection pool and a worker pool, "which tenant is slow" and "which tenant is generating the
errors" are the first two operational questions, and grepping logs answers neither at any scale.

Two design decisions from this review make it more pressing rather than less:

- Every query runs inside its own transaction (ADR-0015), so a single N+1 consumes N pooled connections
  and can starve every other tenant. There is currently no way to see that happening.
- Jobs are dispatched per tenant (ADR-0018), so queue depth and job duration are per-tenant quantities
  that a global gauge averages into meaninglessness.

There is also a sequencing trap. Retrofitting instrumentation through a finished codebase is why most
projects never do it — the seams have to exist before there is code to thread through them.

## Options considered

1. **Logs only.** Free, already specified, and answers aggregate questions badly.
2. **Prometheus metrics alone.** Cheap and answers "how much"; cannot answer "why was *this* request
   slow".
3. **A hosted APM.** Fastest to value; an external dependency for a self-hostable product, and the
   per-tenant modelling would still have to be designed.
4. **OpenTelemetry**, exporting traces and metrics to a local collector, with Prometheus and Grafana/Tempo
   behind a Compose profile. Vendor-neutral, self-hostable, and the instrumentation survives any later
   change of backend.

## Decision

Option 4, with the seam introduced in M0 and the implementation in M9.

- **The seam first.** A `Tracer` injection token with a no-op implementation ships in M0 and is used from
  the first service method. In M9 the no-op is swapped for the real SDK and nothing else changes. The
  cost now is an interface; the cost later would be 200 files.
- **Auto-instrumentation** for HTTP, NestJS, Prisma, BullMQ and Redis. Hand-written spans only where a
  domain operation is not a library call: transition evaluation, SLA computation, permission resolution,
  scope-filter expansion.
- **Every span carries the tenant.** `org.id`, `membership.id`, `actor.kind`, and for authorization spans
  the `permission` and its outcome. This is the whole point — a trace that cannot tell you whose request
  it was is a single-tenant trace.
- **`reqId` is the trace id.** The correlation id already surfaced in 5xx Problem Details (ADR-0012)
  becomes the identifier that opens the trace, so a user's bug report is one paste away from the
  waterfall.
- **Metrics that exist because the system is multi-tenant:**

  | Metric | Why |
  | --- | --- |
  | `http_request_duration` by route, status, **org** | the first question |
  | `db_transaction_duration` and `db_transactions_per_request` | catches the N+1-becomes-pool-exhaustion failure mode |
  | `db_pool_saturation` | the resource every tenant shares |
  | `job_duration` / `queue_depth` by queue **and org** | whether one tenant is starving the others (ADR-0018 fairness) |
  | `rls_denied_total` | a non-zero value is a bug, and a loud one |
  | `sla_breaches_total` by org and priority | a product metric that happens to be an ops metric |
  | `quota_rejections_total` by org and metric | who is hitting limits, and whether the limits are sane |

- **Cardinality is bounded deliberately.** `org.id` is fine as a *span attribute* (unbounded attributes
  are cheap in traces) and dangerous as a *metric label* (each value is a time series). Metrics therefore
  carry `org.id` only on the handful above, and a tenant beyond the top-N by volume is bucketed as
  `other`. Stated explicitly because "add orgId to every metric" is the obvious move and it is the one
  that takes Prometheus down.
- **No PII in spans**, on the same rule as logs (`ENGINEERING.md`): ids only, never emails, ticket titles
  or bodies. A trace is not a safer place for customer data than a log line.
- **Locally** the collector, Prometheus and Grafana sit behind a Compose profile, so the default
  `docker compose up` stays light and `--profile observability` turns it on.

## Consequences

- One dashboard answers the question the architecture exists to make answerable, and it exists because
  `orgId` was threaded through logs, jobs, spans and metrics from the start rather than added once it hurt.
- The M0 cost is an interface and a no-op. That is the entire trick, and it is worth stating as a
  transferable lesson: instrumentation is a seam problem, not a tooling problem.
- Alerting is out of scope for a local project; the metrics are shaped so that alerts would be obvious
  (pool saturation, `rls_denied_total > 0`, per-tenant queue depth).
- Profiling and continuous profiling are a later ADR if ever; traces plus the transaction-count metric
  should answer the questions this system will actually raise.
