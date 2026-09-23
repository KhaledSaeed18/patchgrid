# Architecture Decision Records

One file per non-obvious decision. Numbered, and **the Context, Options, Decision and Consequences
sections are never edited after acceptance** — a changed mind is a new ADR that supersedes the old one.
The Status line *is* updated, and a factual error is corrected by a dated **Erratum** block below it that
points at the ADR or document carrying the correct rule. Copy `0000-template.md` to start a new one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-package-scope-patchgrid.md) | Package scope `@patchgrid/*` | Accepted |
| [0002](0002-per-type-state-machines-and-extension-tables.md) | Per-type state machines with one status enum and extension tables | Accepted |
| [0003](0003-sla-24x7-with-pending-pause.md) | SLA clocks run 24×7 and pause in `PENDING` | Accepted |
| [0004](0004-auth-invite-only-jwt-cookies.md) | JWT access + rotating refresh in httpOnly cookies, Argon2id | Accepted — invite-only superseded by 0017; cookie scoping by 0024 |
| [0005](0005-attachments-s3-presigned.md) | Attachments in S3-compatible storage via presigned URLs | Accepted — erratum: upload constraints and serving |
| [0006](0006-explicit-transition-endpoint.md) | State changes through an explicit transitions endpoint | Accepted |
| [0007](0007-web-calls-api-directly-no-bff.md) | Next.js calls the NestJS API directly; no BFF layer | Accepted |
| [0008](0008-sse-for-in-app-notifications.md) | Server-Sent Events for live notifications | Accepted |
| [0009](0009-ticket-numbering.md) | Per-type ticket numbers from a counter table | Accepted |
| [0010](0010-ml-services-behind-interfaces-in-monorepo.md) | LLM and phishing model as swappable, non-blocking services inside the monorepo | Accepted |
| [0011](0011-testing-strategy.md) | Testing strategy: Vitest everywhere, real Postgres for integration, Playwright for E2E | Accepted |
| [0012](0012-error-format-and-pagination.md) | RFC 9457 Problem Details and cursor pagination | Accepted — erratum: domain, search exception |
| [0013](0013-full-multi-tenant-saas.md) | Patchgrid is a full multi-tenant SaaS | Accepted |
| [0014](0014-subdomain-per-tenant-routing.md) | Subdomain per tenant; three deployables | Accepted — cookies and tenant resolution superseded by 0024 |
| [0015](0015-tenant-isolation-rls.md) | Tenant isolation via shared schema + `orgId` + Postgres RLS | Accepted — refined by 0022 and 0023; erratum on `FORCE` and ownership |
| [0016](0016-three-frontend-deployables.md) | Three deployables: `www`, `app`, `api` | Accepted |
| [0017](0017-org-signup-and-provisioning.md) | Org signup, provisioning, membership model | Accepted — supersedes 0004 in part; erratum; immediate signup session superseded by 0031 |
| [0018](0018-tenant-aware-jobs-and-events.md) | Tenant-aware background jobs, events and email | Accepted — erratum; inbound auth in 0027 |
| [0019](0019-rbac-model-and-enforcement.md) | RBAC: cumulative roles, permission catalog, pure policy function | Accepted — erratum; team scoping extended by 0025 |
| [0020](0020-consent-based-support-access.md) | Consent-based, read-only, audited support access | Accepted — erratum: per-request auditing |
| [0021](0021-api-tokens-as-service-accounts.md) | API tokens as scoped service accounts | Accepted — erratum: tenant lookup, scope mapping |
| [0022](0022-platform-scope-access-under-rls.md) | Platform-scope access under RLS: projections, not bypass | Accepted |
| [0023](0023-identity-keys-and-tenant-safe-foreign-keys.md) | Identity keys, timestamps, and tenant-safe foreign keys | Accepted |
| [0024](0024-per-tenant-cookies-and-api-tenant-resolution.md) | Per-tenant session cookies, API tenant resolution, and revocation | Accepted |
| [0025](0025-multi-team-membership.md) | An agent can belong to several teams | Accepted |
| [0026](0026-wildcard-tls-and-dns-operations.md) | Wildcard TLS and DNS operations | Accepted |
| [0027](0027-email-dns-and-inbound-sender-authentication.md) | Email DNS and inbound sender authentication | Accepted |
| [0028](0028-data-protection-export-erasure-retention.md) | Data protection: export, pseudonymised erasure, retention | Accepted |
| [0029](0029-mfa-and-step-up-authentication.md) | MFA (TOTP) and step-up authentication | Accepted |
| [0030](0030-observability-opentelemetry-per-tenant.md) | Observability: OpenTelemetry with per-tenant dimensions | Accepted |
| [0031](0031-identity-flow-hardening.md) | Identity-flow hardening: invite binding, uniform responses, a revocable `pg_id` | Accepted |

## Reading order for someone new

The tenancy story, in the order the decisions actually depend on each other:

**0013** (it is a SaaS) → **0014** (how tenants are addressed) → **0015** (how rows are isolated) →
**0023** (why the schema shape matters more than the filters) → **0022** (how anything ever crosses a
tenant boundary) → **0024** (how a session names its tenant) → **0019** (what an actor may do once the
tenant is settled).
