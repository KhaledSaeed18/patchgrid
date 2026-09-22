# 0018 — Tenant-aware background jobs, events and email

- **Status:** Accepted — inbound mail authentication specified by [0027](0027-email-dns-and-inbound-sender-authentication.md)
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** "`runAsPlatform` appears in exactly three places" undercounts and, more
> importantly, mis-describes the mechanism: per-tenant work uses `runAsTenant(orgId)` and is not a bypass
> at all (ADR-0022). The import rule is now expressed per module rather than as a count. Inbound mail
> resolves its tenant from the recipient **and** authenticates the sender before creating anything
> (ADR-0027).

## Context

RLS and request-scoped tenant context (ADR-0015) work because a request establishes a tenant. Background jobs, domain-event handlers, SSE streams and scheduled scans have no request, so they need their own discipline — and the SLA scanner in particular must sweep every tenant without ever mixing them.

## Options considered

1. **Run background work with a privileged connection that bypasses RLS**, filtering by `orgId` in code — convenient; discards the safety net exactly where nobody is watching, which is where leaks survive longest.
2. **One queue per tenant** — perfect isolation of work; unbounded queue growth and idle workers as tenants multiply.
3. **Shared queues, tenant id in every job payload, tenant context established per job** — one set of queues, the same isolation guarantees as a request.

## Decision

Option 3.

- **Every job payload carries `orgId`** (plus the ids it needs, never full entities, so it cannot act on stale data). The BullMQ processor wrapper opens the same `AsyncLocalStorage` tenant context a request would, so repositories, RLS and audit logging behave identically. A job without `orgId` on a tenant-owned queue is rejected as a programming error.
- **Sweeping jobs are two-stage.** The repeatable `sla-scan` does not scan all tickets globally. A *dispatcher* runs `runAsPlatform` to list active, non-suspended organizations, then enqueues one `sla-scan:org` job per tenant. Each of those runs in tenant context. This keeps the privileged, cross-tenant query to a single well-audited line, bounds the work per job, prevents one huge tenant from starving others, and makes failures retryable per tenant.
- **Fairness**: per-tenant jobs carry a priority derived from plan and recent volume, so a tenant with 50 000 tickets cannot monopolise the worker pool.
- **Domain events** carry `orgId`; the in-process emitter propagates the current context to handlers, and any handler that enqueues a job passes it along.
- **SSE streams** are per `(userId, orgId)`. Fan-out via a Redis channel namespaced by org (`org:<orgId>:notifications`); a subscriber can only ever subscribe to its own token's org.
- **Outbound email** is rendered inside tenant context so it can safely include ticket data, and always links to `https://<slug>.patchgrid.xyz/...`. The `From` name carries the organization name, the envelope sender stays a Patchgrid address (deliverability), and `Reply-To` is the tenant's inbound address (`<slug>@inbound.patchgrid.xyz`) once email intake exists.
- **Inbound email** resolves its tenant from the recipient address before anything else; an unresolvable tenant is dropped with a log line, never guessed.
- **Idempotency** is per tenant: job ids are `<queue>:<orgId>:<entityId>:<discriminator>` so a retry cannot double-act and two tenants cannot collide.

## Consequences

- The dispatcher/worker split is slightly more machinery than a single global scan, and it is the piece most worth understanding — it is how real multi-tenant schedulers work.
- Job observability is per tenant: logs and metrics carry `orgId`, so "which tenant is slow" is answerable.
- `runAsPlatform` appears in exactly three places (tenant dispatcher, auth/provisioning, platform admin). A lint rule and a review checklist keep it that way.
- If a tenant is suspended or pending deletion, the dispatcher skips it, so no background work touches dormant data.
