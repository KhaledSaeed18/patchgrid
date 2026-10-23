# Patchgrid

## What this is

Patchgrid is a **multi-tenant SaaS IT service management (ITSM) platform** — a ticketing and operations system for IT and security teams. It is explicitly **not** a general-purpose project management tool. Jira, ClickUp, Trello and Asana manage arbitrary work items; Patchgrid manages IT operations specifically, and its data model reflects that difference.

Positioning: a scoped-down Freshservice / Jira Service Management / Zendesk — the parts a real internal IT desk uses every day, built as a portfolio-quality reference implementation of a production SaaS architecture.

It is also a learning project. Every non-obvious decision is written down in `docs/decisions/` (ADRs) so the reasoning is visible, not just the code.

## Product shape

Three deployables across five hostnames, one monorepo (ADR-0014, ADR-0016):

| Host                   | App          | What it is                                                            |
| ---------------------- | ------------ | --------------------------------------------------------------------- |
| `patchgrid.xyz`        | `apps/www`   | Public marketing site: landing, pricing, docs, blog, sign-up          |
| `<slug>.patchgrid.xyz` | `apps/app`   | A single tenant's workspace — the product                             |
| `app.patchgrid.xyz`    | `apps/app`   | Tenant-less entry: login, org picker, accept invite, create workspace |
| `api.patchgrid.xyz`    | `apps/api`   | NestJS — all business logic and data access                           |
| `admin.patchgrid.xyz`  | _(reserved)_ | Platform back-office, later                                           |

A company signs up on the marketing site, picks a slug, and lands in its own workspace at `acme.patchgrid.xyz` with teams, a category tree, SLA policies and starter knowledge-base articles already provisioned.

## Tenancy model

- A **tenant** is an `Organization`, addressed by its subdomain slug.
- A **user** is a global identity (one email, one account) who belongs to organizations through **memberships**. The same person can be an Admin at one company and a Requester at another.
- Roles live on the membership: `OWNER | ADMIN | AGENT | REQUESTER`, with team leadership as a scoped capability rather than a role. Machines act through scoped API tokens bound to service-account memberships, so one authorization model covers humans and integrations (`RBAC.md`).
- Every tenant-owned row is isolated at the **database** level by Postgres Row-Level Security, not merely by application filtering (ADR-0015). Isolation is defended in five independent layers — starting with a schema shape in which a cross-tenant reference is _unrepresentable_ (ADR-0023) — and proven by a dedicated test suite.

## Domain grounding (ITIL)

Patchgrid models four distinct record types instead of collapsing everything into one generic "ticket". This distinction is the core domain decision the rest of the system is built around:

- **Incident** — something is broken or degraded right now. Goal: restore service fast. Root cause is not required to close an incident.
- **Service Request** — a user asking for something standard and pre-approved in shape: a new laptop, a software license, an account, an access grant.
- **Problem** — the underlying root cause behind one or more recurring incidents. Investigated on its own timeline; carries no SLA.
- **Change** — a planned modification to infrastructure or systems, gated by an approval step before execution (one approval gate, not a full CAB).

A Problem links to N Incidents it explains. A Change can originate from a Problem or stand alone. Each type has its **own status state machine** — see `DOMAIN.md`.

## Priority model

Priority is never set directly by a human typing "High" into a dropdown. It is computed from **Impact × Urgency**:

- **Impact** — how many users or how critical the affected system is (Low / Medium / High)
- **Urgency** — how time-sensitive the situation is (Low / Medium / High)

The resulting Priority (Low / Medium / High / Critical) selects the SLA policy. See `DOMAIN.md` for the matrix and the SLA clock rules.

## Document map

| File                     | Purpose                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `PROJECT.md` (this file) | What we are building, for whom, and what we are _not_ building                                |
| `TENANCY.md`             | The multi-tenant model: identity, membership, isolation, provisioning, limits                 |
| `RBAC.md`                | Authorization: actors, permission catalog, matrix, platform admin, support access, API tokens |
| `DOMAIN.md`              | ITSM business rules: record types, state machines, priority, SLA                              |
| `ARCHITECTURE.md`        | Stack, monorepo layout, layering, data model, request pipeline, integrations                  |
| `ENGINEERING.md`         | Conventions, API rules, testing, CI, local development                                        |
| `FEATURES.md`            | Scope as milestones — the working backlog                                                     |
| `DNS.md`                 | Hostnames, wildcard TLS, mail DNS, and the custom-domain path                                 |
| `decisions/`             | One ADR per non-obvious decision                                                              |
| `SPEC-REVIEW.md`         | Working review log — findings burn down into the docs above, then the file is deleted         |
| `HANDOFF.md`             | State of play at the current milestone boundary — read first when picking the work back up    |
| `../CLAUDE.md`           | Rules for AI coding agents working in this repo                                               |

## Explicit non-goals

- Not a general project/task management tool (no arbitrary boards, no non-IT work items)
- Not a customer-facing support suite (no live chat widget, no multi-brand customer inboxes)
- Not ServiceNow-scale configurability (no custom form builder, no workflow DSL, no automation rule engine)
- No payment processing or self-serve billing in v1; plans exist, a platform admin sets them
- No SAML, SCIM, or per-tenant custom domains in v1 (per-tenant OIDC sign-in is built, ADR-0054; the rest are designed _for_, deferred by ADR)
- No machine learning or local models: no LLM triage, embeddings or phishing scoring (ADR-0056)
- No platform-operator impersonation, ever: support access is owner-granted, read-only, time-boxed and audited into the customer's own log (ADR-0020)
- No business-hours SLA calendars in v1 — clocks run 24×7 (ADR-0003)
- No internationalisation: English only, no locale routing, no `next-intl`. Search is `english`-configured Postgres full-text
- No mobile apps

## What separates this from a CRUD tutorial

The architecture itself, every part of it exercised and tested locally: isolation that holds at three
layers and in the schema's shape (ADR-0015, ADR-0023), authorization decided by a pure function over a
resolved subject (ADR-0019), a transactional outbox read as a per-tenant log with webhooks on top
(ADR-0049, ADR-0050), a reporting read side checked against its source (ADR-0051), and per-tenant SSO
and passkeys (ADR-0053, ADR-0054). There is no machine learning: the models once planned as M7 were
dropped (ADR-0056).

## Current stage

Local development only. Everything — Postgres, Redis, MinIO, Mailpit, and Keycloak for SSO — runs via Docker Compose on the developer machine, with wildcard-subdomain tenancy working locally through `lvh.me`. There is no public deployment (ADR-0047): the production shape — wildcard DNS and TLS, the images, `docker-compose.prod.yml` — is designed and the images build in CI, but nothing is hosted. The effort goes to the implementation and the architecture.
