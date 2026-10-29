# Patchgrid documentation

These documents are Patchgrid's **specification**. They were written before the code and are kept
true as it changes: a change to a rule ships in the same pull request as the code that implements it.
If code and a document disagree, one of them is wrong.

New here? Read the [project README](../README.md) for the showcase and the demo, then
[`HANDOFF.md`](HANDOFF.md) for where things stand.

## The documents

### The product

| Document | Answers |
| --- | --- |
| [`PROJECT.md`](PROJECT.md) | What Patchgrid is, who it is for, and its explicit non-goals |
| [`DOMAIN.md`](DOMAIN.md) | The ITSM rules: the four record types and their state machines, the priority matrix, SLA clocks, routing, comments, notifications, the knowledge base and assets |
| [`FEATURES.md`](FEATURES.md) | The scope as milestones M0–M14, each with its exit criteria and what was built |

### Architecture

| Document | Answers |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The stack, the monorepo and its dependency rules, the request pipeline, the NestJS layering, the data model, background jobs, integration boundaries, the production images and the deployment shape |
| [`TENANCY.md`](TENANCY.md) | The multi-tenant model: organizations, slugs and subdomains, signup and provisioning, joining, sessions and tenant resolution, the isolation layers, plans and limits, tenant-aware background work |
| [`RBAC.md`](RBAC.md) | Authorization within a tenant: actors, roles, agent visibility, watchers, the permission catalog and matrix, what the API returns so the UI never re-derives a rule, platform admins, support access, API tokens |
| [`DNS.md`](DNS.md) | Hostnames, wildcard TLS, mail DNS (SPF, DKIM, DMARC), the custom-domain path, subdomain takeover and the Public Suffix List question |
| [`../infra/README.md`](../infra/README.md) | The production rehearsal on emulated AWS: commands, module layout, opening it in a browser, and every place the emulator differs from AWS |

### Security

| Document | Answers |
| --- | --- |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | Assets, actors, thirteen trust boundaries, STRIDE per boundary, accepted residual risks, and the findings of each security review (M9, M11, M12, M13, M14) with their fixes |
| [`../SECURITY.md`](../SECURITY.md) | How to report a vulnerability, what counts as most serious, and design decisions that are intentional rather than bugs |

### Working on it

| Document | Answers |
| --- | --- |
| [`ENGINEERING.md`](ENGINEERING.md) | Conventions: TypeScript, API rules, transactions and side effects, schema changes, testing, local development, CI, logging, frontend rules, documentation |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | The short version: running it, commits, what CI rejects, adding a tenant-owned table |
| [`../CLAUDE.md`](../CLAUDE.md) | The non-negotiable rules, condensed for AI coding agents and equally useful to people |
| [`../apps/app/e2e/README.md`](../apps/app/e2e/README.md) | The browser suite: what each scenario proves, and how it runs against the AWS rehearsal |

### Decisions and history

| Document | Answers |
| --- | --- |
| [`decisions/`](decisions/README.md) | 59 architecture decision records: why each non-obvious choice was made, and what it beat |
| [`HANDOFF.md`](HANDOFF.md) | The state of play at the latest milestone boundary: what is built, the test counts, what is open, what a real deployment would still need, and the gotchas each milestone cost |
| [`SPEC-REVIEW.md`](SPEC-REVIEW.md) | The review of these documents before and during M0: the design defects found before the code was built on them, such as foreign keys that bypass RLS, and where each fix landed. Kept as a record |

## Reading paths

**Fifteen minutes, to evaluate the project.** The [README](../README.md), then the five isolation
layers in [`TENANCY.md` §7](TENANCY.md#7-isolation-summary--full-reasoning-in-adr-0015-adr-0022-adr-0023),
then [ADR-0023](decisions/0023-identity-keys-and-tenant-safe-foreign-keys.md), the decision the rest
of the isolation design leans on.

**How tenant isolation works.** Follow the decisions in the order they depend on each other:
[0013](decisions/0013-full-multi-tenant-saas.md) (it is a SaaS) →
[0014](decisions/0014-subdomain-per-tenant-routing.md) (tenants are addressed by subdomain) →
[0015](decisions/0015-tenant-isolation-rls.md) (rows are isolated by RLS) →
[0023](decisions/0023-identity-keys-and-tenant-safe-foreign-keys.md) (the schema's shape matters more
than the filters) → [0022](decisions/0022-platform-scope-access-under-rls.md) (how anything crosses a
tenant boundary) → [0024](decisions/0024-per-tenant-cookies-and-api-tenant-resolution.md) (how a
session names its tenant) → [0019](decisions/0019-rbac-model-and-enforcement.md) (what an actor may
do once the tenant is settled). Then [`TENANCY.md`](TENANCY.md) and [`RBAC.md`](RBAC.md).

**How a ticket works.** [`PROJECT.md`](PROJECT.md#domain-grounding-itil) for the four record types,
then [`DOMAIN.md`](DOMAIN.md) §2–§4 for their state machines, the priority matrix and the SLA clock,
then [ADR-0002](decisions/0002-per-type-state-machines-and-extension-tables.md),
[ADR-0003](decisions/0003-sla-24x7-with-pending-pause.md) and
[ADR-0006](decisions/0006-explicit-transition-endpoint.md).

**How events reach the outside world.** [ADR-0018](decisions/0018-tenant-aware-jobs-and-events.md)
(tenant-aware jobs), [ADR-0049](decisions/0049-transactional-outbox-as-a-tenant-log.md) (the
outbox, read as a log), [ADR-0050](decisions/0050-outbound-webhooks.md) (webhooks) and
[ADR-0051](decisions/0051-reporting-read-side.md) (the reporting read side), then the background-jobs
section of [`ARCHITECTURE.md`](ARCHITECTURE.md#background-jobs-bullmq-inside-appsapi).

**Before changing code.** [`HANDOFF.md`](HANDOFF.md), [`../CLAUDE.md`](../CLAUDE.md),
[`ENGINEERING.md`](ENGINEERING.md), then the document that owns the area you are touching.

**Before deploying anywhere.** [`../infra/README.md`](../infra/README.md),
[ADR-0058](decisions/0058-production-rehearsal-on-emulated-aws.md),
[ADR-0059](decisions/0059-rds-compatible-database-roles.md),
[`DNS.md`](DNS.md), and the "If it is ever deployed" list in [`HANDOFF.md`](HANDOFF.md).

## How these documents are kept

- **Each rule has one home.** The tables above say which document owns what. Others link to it rather
  than restating it. Wire shapes, reserved slugs, size limits and the permission catalog are defined
  once, in `packages/contracts`.
- **Some tables are tested.** The contracts tests read the permission matrix (`RBAC.md` §6), the
  priority matrix (`DOMAIN.md` §3), the audit actions (`RBAC.md` §12, `DOMAIN.md` §7) and the plan
  limits (`TENANCY.md` §8) cell by cell.
  A document that drifts from the code fails the build, so keep those tables' shapes.
- **Decisions are immutable.** An ADR's Context, Options, Decision and Consequences are never edited
  after acceptance; a changed mind is a new ADR that supersedes it. A factual error gets a dated
  **Erratum** block under the Status line. The process is in [`decisions/README.md`](decisions/README.md).
- **The handoff is regenerated, not appended.** [`HANDOFF.md`](HANDOFF.md) is rewritten at each
  milestone boundary. Earlier states are in its git history.
- **Screenshots** in [`screenshots/`](screenshots/) are generated, never edited by hand: `pnpm screenshots`
  takes every one from the seeded demo at 1440 × 900, scale 2, in light and dark.
