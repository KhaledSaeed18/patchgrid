# Patchgrid

[![CI](https://github.com/KhaledSaeed18/patchgrid/actions/workflows/ci.yml/badge.svg)](https://github.com/KhaledSaeed18/patchgrid/actions/workflows/ci.yml)
[![CodeQL](https://github.com/KhaledSaeed18/patchgrid/actions/workflows/codeql.yml/badge.svg)](https://github.com/KhaledSaeed18/patchgrid/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)](.nvmrc)

A **multi-tenant IT service management platform** — ticketing and operations for IT
and security teams, built as a production-grade reference rather than a tutorial.

Incidents, service requests, problems and changes are four different things with four
different lifecycles. Priority is computed from impact × urgency, never typed into a
dropdown. Each company gets its own subdomain, and its data is isolated at the
**database** level — not by remembering to add a `WHERE` clause.

```
patchgrid.xyz           marketing            apps/www    Next.js
<slug>.patchgrid.xyz    tenant workspace     apps/app    Next.js
api.patchgrid.xyz       everything else      apps/api    NestJS
```

## Isolation, in five layers

The thing this project is actually about:

0. **Schema shape** — composite `(orgId, id)` foreign keys, so a cross-tenant
   reference is _unrepresentable_. PostgreSQL runs referential-integrity checks with
   row security off, so this is the layer the other four cannot provide.
1. **Request context** — the tenant comes from the credential, never the host
2. **Repository arguments** — every method takes an explicit `orgId`
3. **Prisma client extension** — transaction-local `set_config`, throws without context
4. **Postgres RLS** — `FORCE ROW LEVEL SECURITY`, and an app role that holds no `BYPASSRLS`

The same discipline reaches everything that runs without a request. Background jobs
carry their `orgId` and run inside that tenant. Sweeps go dispatcher → one job per
tenant, never one global scan. The live notification stream listens on
`org:<orgId>` for the credential's org only, and sends a ticket event only to
members who could open that ticket — a CI test holds that decision equal to the one
`GET /tickets/:id` makes. A tenancy suite of numbered assertions gates every merge.

## What works today

- **Workspaces and people** — signup and provisioning, invitations, roles on the
  membership (`REQUESTER ⊂ AGENT ⊂ ADMIN ⊂ OWNER`), multi-team agents, team leads,
  per-tenant sessions, an org picker for people in several workspaces, audit log.
- **Incidents end to end** — a portal for requesters and a console for agents:
  - computed priority and per-org numbers (`INC-000042`), routing by category;
  - a transition table with required notes, and stale-write `409`s;
  - public replies and internal notes, watchers, and full-text search.
- **Four record types, four lifecycles** — service requests; problems with root
  cause, workaround and known errors; changes with a plan, a risk, an approval by
  someone other than their author, and a recorded outcome. Tickets link to each
  other (caused by, resolves, duplicate of, relates to), read from either end.
- **Files** — attachments on tickets and replies, uploaded straight to object storage
  with a presigned URL, checked by their bytes rather than their name, and served
  from a domain that shares nothing with the app. Each workspace has a storage quota.
- **Assets** — a register of laptops, phones, printers, network kit and licences:
  who has each, its warranty, and every ticket raised about it. Requesters see
  their own and name them when they raise a ticket.
- **Email intake** — mail to `<slug>@inbound.<domain>` becomes a ticket, and a reply to a
  ticket email lands on its ticket. That only happens when the sender passes DMARC and is a
  member. Everything else is recorded in an admin's inbound log and left at that: forged
  senders, strangers, autoresponders and floods.
- **Knowledge base** — markdown articles that are drafts, internal runbooks or
  published to the workspace. Full-text search; versioned edits; suggestions under
  a new ticket's title while a requester types.
- **SLA clocks** — response and resolution targets with pause on pending. A
  per-tenant scan flags warnings and breaches once each and audits them. Resolved
  tickets auto-close after seven days.
- **Notifications** —
  - a bell and inbox, with a burst on one ticket folded into one row;
  - live updates over Server-Sent Events, including an "assigned to you" toast and
    queues and ticket pages that refresh themselves;
  - email for assignments, replies, status changes and SLA events, with
    preferences per membership and a workspace-wide off switch.
- **Housekeeping jobs** — audit-log partitions kept a month ahead and archived past
  seven years, a nightly repair of the org picker's projection, and a sweep that
  clears uploads nobody finished and gives their quota back.
- **The platform layer** —
  - an operator back-office at `admin.<domain>`, behind its own login and a TOTP second
    factor, that sees workspace metadata and never their content;
  - support access an owner grants for a few hours: read-only, through the workspace's own
    routes, every page it opens written to the workspace's audit log;
  - scoped API tokens, each its own service account, so a monitoring system can raise
    incidents and can never manage members, settings or other tokens;
  - deleting a workspace: thirty days to change your mind, then a purge that leaves only
    a nameless record, so its address is never reused;
  - a workspace export streamed as a zip, self-service account erasure that keeps what
    you wrote under "Former member", and retention sweeps.

## Running it

```bash
cp .env.example .env
pnpm install
docker compose up -d && docker compose up minio-init
pnpm db:bootstrap && pnpm db:migrate && pnpm db:generate
pnpm db:doctor        # asserts the isolation invariants actually hold — expect 6/6
pnpm db:seed          # two lookalike workspaces, acme and globex
pnpm dev
```

`www` on `lvh.me:3000`, `app` on `<slug>.lvh.me:3001`, `api` on `api.lvh.me:4000`.
Outgoing mail lands in Mailpit at `localhost:8025`. To mail a ticket in, run
`pnpm --filter @patchgrid/api run inbound:send -- --from rita@patchgrid.test --to acme`.
It signs the message as the receiving server would; add `--dmarc fail` to see a forged one
refused. Attachments are served by MinIO
at `localhost:9000` — a different site from `lvh.me`, as files must be (ADR-0037).

To see which tenant is slow, start the observability profile and point the API at it
(ADR-0030, ADR-0046): `docker compose --profile observability up -d`, then set
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in `.env` and restart `pnpm dev`. Grafana is at
`localhost:3100` with the dashboard "Patchgrid — which tenant is slow"; traces in Tempo carry the
tenant, and a 5xx's `correlationId` is the trace id.

Sign in at `app.lvh.me:3001` with password `patchgrid-demo`:

| Account | Who they are |
| --- | --- |
| `dana@patchgrid.test` | Admin at Acme and agent at Globex — sees the workspace picker; also the platform operator at `admin.lvh.me:3001`, who enrols a TOTP factor on first sign-in |
| `sam@patchgrid.test` | Agent at Acme |
| `rita@patchgrid.test` | Requester at Acme |

### Tests

```bash
pnpm turbo lint typecheck test build
pnpm test:tenancy                                      # schema catalog + isolation suite
pnpm test:authz                                        # permission matrix + route coverage
pnpm --filter @patchgrid/api run test:integration      # real Postgres, Redis and queues
pnpm --filter @patchgrid/database run test:integration
```

Time is injected, so SLA and worker tests run on fake timers and nothing sleeps.

## Documentation

The docs are the specification, not a description written afterwards.

|                                                                                     |                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`docs/HANDOFF.md`](docs/HANDOFF.md)                                                | **Start here** — what is built, what is not, what comes next  |
| [`docs/PROJECT.md`](docs/PROJECT.md)                                                | What this is, and what it deliberately is not                 |
| [`docs/TENANCY.md`](docs/TENANCY.md) · [`docs/RBAC.md`](docs/RBAC.md)               | Isolation between tenants; authorization within one           |
| [`docs/DOMAIN.md`](docs/DOMAIN.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | ITSM rules; stack, pipeline and data model                    |
| [`docs/ENGINEERING.md`](docs/ENGINEERING.md) · [`docs/DNS.md`](docs/DNS.md)         | How we work; hostnames, TLS and mail                          |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)                                      | Assets, actors, trust boundaries, STRIDE — and accepted risks |
| [`docs/FEATURES.md`](docs/FEATURES.md)                                              | The backlog, milestone by milestone                           |
| [`docs/decisions/`](docs/decisions/)                                                | 44 ADRs — _why_ any of it is this way                         |

## Status

**M0 (foundation) through M6, and M8, are complete:**
- tenancy and identity;
- the incident lifecycle;
- SLA sweeps and notifications;
- service requests, problems and changes;
- attachments, assets and the knowledge base;
- tickets raised and answered by email;
- the platform layer: back-office, support access, API tokens, deletion and data protection.

Next is M9, hardening: MFA for members, end-to-end tests across two tenants, observability
and a security review. M10 (ship) follows. M7 comes last because it needs local models: LLM triage, phishing scoring, duplicate
detection and automation rules.
`docs/HANDOFF.md` has the detail. Screenshots, an architecture
diagram and a public demo arrive with the final milestone.

MIT licensed — the value of this repository is that people read it.
