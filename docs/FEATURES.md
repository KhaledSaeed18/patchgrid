# Patchgrid — Feature Backlog by Milestone

Vertical slices, not horizontal layers: every milestone ends with something you can click through. Do not
start milestone N+1 until milestone N's exit criteria are met. Do not add a feature that is not on this
list without adding it here first (and an ADR if it is a real decision).

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## M0 — Foundation

_Exit: `docker compose up` + `pnpm dev` serves `lvh.me:3000`, `app.lvh.me:3001` and `api.lvh.me:4000`;
CI green on an empty PR; `/health/ready` returns 200 (connectivity only — there is no schema yet)._

**Met on 2026-09-22.** All three hosts serve from one `pnpm dev`; `/health/ready` reports database,
redis and object-storage up; all four CI jobs pass on GitHub's runners. 105 tests across four packages.
Licensed MIT: the value of this repository is that people read it.

- [x] Rename scope `@workspace/*` → `@patchgrid/*`; rename `apps/web` → `apps/app` (including its
      `package.json` `name`); scaffold `apps/www` (ADR-0001, ADR-0016)
- [x] `apps/api` NestJS 11: Zod-validated config that refuses to boot on a bad environment,
      `nestjs-pino` with per-request ids, Problem Details filter, `nestjs-zod` pipe throwing typed
      problems, helmet, slug-aware CORS, `/health` + `/health/ready` over Postgres/Redis/MinIO, no-op
      `Tracer` and `Clock` providers, `@Public`/`@TenantOptional` markers, boot assertion that the
      database role cannot bypass RLS
- [x] `packages/database`: Prisma **pinned to 7.10.0** (never `latest` — it points at an 8.0 RC), with
      `prisma.config.ts` holding the connection strings and `@prisma/adapter-pg` driver adapters (Prisma 7
      removed `url` from the datasource block); generator provider `prisma-client`; `prisma`,
      `@prisma/engines` and `esbuild` added to `allowBuilds` in `pnpm-workspace.yaml`;
      `PrismaService`, migration + seed scripts, `pgvector`, **two DB roles**
      (owner **with** `BYPASSRLS`, `patchgrid_app` **without**) created by the Postgres init script,
      including `GRANT`s and `ALTER DEFAULT PRIVILEGES`; the same SQL as an idempotent file run by
      `db:migrate`; boot assertion that the app's role lacks `BYPASSRLS`
- [x] `packages/contracts`: shared primitives — ids, cursor pagination, Problem Details, slug schema,
      `RESERVED_SLUGS`, `formatTicketNumber` / `parseTicketNumber`, limit constants. 59 round-trip tests;
      `apps/www` renders its problem pages from the registry rather than a copy of it
- [x] `docker-compose.yml`: postgres (pgvector, init script), redis, minio (+ bucket; **CORS is a
      server setting**, `MINIO_API_CORS_ALLOW_ORIGIN`, not a bucket one), mailpit — all four
      healthchecked, every published port env-overridable
- [x] Root scripts (`test`, `db:*`), Vitest in api/app/www/contracts — 105 tests; Playwright installed
      and configured but deliberately empty until M9. `test:tenancy`, `test:authz`, `platform:grant` and
      per-worker template database clones arrive with the code they serve, in M1
- [x] GitHub Actions: `verify` (lint, typecheck, test, build), `database` (service container →
      bootstrap → doctor, run twice for idempotency), `smoke` (full Compose stack + API boot +
      readiness), `security` (gitleaks over full history, `pnpm audit --audit-level=high`); CodeQL
      `security-extended` and grouped Dependabot. Tenancy/authz suites, schema assertions and
      migration-drift land with the code they check, in M1
- [x] ESLint rules: no `@patchgrid/database` outside `apps/api`; no Prisma outside `**/repositories/**`;
      no raw SQL outside `packages/database`; `runAsPlatform`/`runAsTenant` import paths restricted by
      module (ADR-0022). `eslint-plugin-only-warn` removed and `--max-warnings 0` set, so lint can fail
- [x] Repo furniture: `.nvmrc` + `engines`, `.editorconfig`, `commitlint` + `lefthook` (commit-msg and
      pre-commit hooks), `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, PR template,
      issue config
- [x] `apps/app` route groups `(auth)`, `(select)`, `(portal)`, `(console)`, `(admin)` with placeholders
      that name the milestone each screen arrives in. The tenant-scoped groups declare
      `force-dynamic` at the _layout_, so a page added below cannot silently render one tenant's data
      into the build output (ADR-0016)
- [x] `apps/www` landing placeholder + `/problems/*` pages for Problem Details `type` URIs — 13 types,
      statically prerendered; the registry moves to `@patchgrid/contracts` when that package exists

## M1 — Tenancy and identity (the foundation everything else sits on)

_Exit: a stranger signs up on `lvh.me:3000`, picks a slug, lands in a provisioned workspace at
`acme.lvh.me:3001`, invites an agent who accepts and logs in; a second org exists; the dual-member
account holds both workspaces open in two tabs; the isolation suite proves RLS blocks cross-tenant reads
at the database level and that composite keys make cross-tenant references impossible; the authorization
suite proves every route asserts a permission._

- [x] **Threat model** (`docs/THREAT-MODEL.md`): assets, actors, trust boundaries, STRIDE per boundary.
      Written **first** — it informs the design rather than certifying it, and it is a one-page document.
      Findings TM-3…TM-5 decided in ADR-0031; TM-1 (attachment origin, M5) and TM-2 (platform actor, M8) open
- [ ] Data: `Organization`, `OrganizationSlugHistory`, `User`, `Membership`, `TeamMembership`,
      `Invitation`, `Team`, `RefreshToken`, `PasswordResetToken`, `EmailVerification`, `PlatformAdmin`,
      `UserOrgIndex`, `ApiTokenIndex` — with composite `(orgId, id)` uniques and membership references
      throughout (ADR-0023)
- [ ] **RLS**: hand-written policy migrations from one template, `FORCE ROW LEVEL SECURITY`, tenant
      Prisma client extension with transaction-local `set_config` and CLS-aware nesting, `nestjs-cls`
      context, `runAsTenant` / `runAsPlatform` (ADR-0015, ADR-0022)
- [ ] Tenant resolution middleware: credential → org, `Origin` / `X-Patchgrid-Tenant` cross-check,
      Redis-cached org lookup, slug-history redirects (302), suspended/deleted handling (ADR-0024)
- [ ] Auth: signup, login, logout, refresh with rotation + reuse detection, email verification, password
      reset, Argon2id, **per-tenant cookies** on `.lvh.me`, Redis revocation epoch (ADR-0004, ADR-0017,
      ADR-0024)
- [ ] Org provisioning: slug validation + availability, transactional creation, default
      teams/categories/**eight** SLA policies/KB, idempotent `provision-org` job; one org per unverified
      user
- [ ] Membership: invite (org-bearing token), accept, disable, remove, change role; last-owner protection
      **under a row lock**; org switcher minting tenant-bound cookie pairs
- [ ] Teams: CRUD, `TeamMembership`, lead assignment, "manage own team's members" for leads
- [ ] `authz` module: unified permission catalog/matrix in `@patchgrid/contracts`, pure
      `PermissionService` (`can` / `assert` / `scopeFor` / `permissionsFor` / `capabilitiesFor`),
      `@RequirePermission` guard, deny-by-default, branch-shaped `ScopeFilter` (ADR-0019, ADR-0025)
- [ ] `GET /me` returning `{ user, membership, org, teams, permissions[] }`; `apps/app` renders from it
- [ ] `Organization.agentVisibility` setting + `scopeFor()` unit tests (plumbed into real list queries in
      M2, where lists first exist)
- [ ] Org-wide audit actions (`RBAC.md` §12) and `GET /org/audit` with its indexes
- [ ] **Authorization suite**: exhaustive matrix test, deny-by-default, route-coverage reflection test,
      escalation negatives including concurrent last-owner demotion — wired as a CI gate
- [ ] `QuotaService` + `UsageCounter` with atomic conditional increments (seats first; ticket volume in
      M2); Postgres authoritative, Redis a display cache
- [ ] Throttling on `/auth/*`, signup and slug lookup, per IP **before** tenant resolution
- [ ] Mail: `MailProvider`, Mailpit SMTP impl, BullMQ `mail` queue, react-email templates (verify,
      invite, reset)
- [ ] `apps/www`: landing, pricing, signup flow with live slug availability
- [ ] `apps/app`: login, accept invite, reset, org picker, create workspace, `proxy.ts` host parsing,
      `apiFetch` with tenant cookie selection + refresh-and-retry, `TenantProvider`
- [ ] Admin UI: members list, invite, role changes, teams CRUD with lead, org settings (name, slug change)
- [ ] Seed: two orgs with similar data + a dual-member user
- [ ] **Tenancy isolation suite** (`ENGINEERING.md`) — all thirteen assertions, wired as a CI gate

## M2 — Incident lifecycle (the heart)

_Exit: a requester submits an Incident from the portal; it gets a per-org number, computed priority, SLA
deadlines and a routed team; an agent assigns, replies publicly, adds an internal note, moves to pending
and back, resolves; the requester closes or reopens; two agents editing the same ticket get a clean
conflict; every step is audit-logged; transition table, priority matrix and SLA clock are unit-tested._

- [ ] Data: `TicketCounter`, `Ticket` (with clock origins, `version`, `searchVector`), `Category`,
      `SLAPolicy`, `Comment`, `TicketWatcher`, `AuditLog` (partitioned) — all tenant-owned, all with
      policies and composite keys
- [ ] Admin UI: category tree (3 levels, unique per parent, soft-delete only, default team), SLA policies
- [ ] Ticket service: create (per-org numbering, priority, SLA targets, category routing, atomic quota
      check, `Idempotency-Key`), update with optimistic `version`, Incident transition table, reopen,
      cancel, create-on-behalf
- [ ] `POST /tickets/:id/transitions` with required comments on `wait` / `resolve` / `cancel`, returning
      `availableActions` **and** `capabilities` (ADR-0006, `RBAC.md` §7)
- [ ] Comments: public vs internal, 15-minute edit window, soft delete, with an integration test proving
      a requester-scoped query can never return an internal note
- [ ] Watchers: add/remove self and others, implicit requester/assignee, watcher read scope
- [ ] `scopeFor()` plumbed into every list query as a `UNION ALL` of branches; `OWN_TEAM_ONLY` exercised
      with a multi-team agent
- [ ] Ticket search: generated `tsvector`, GIN index, number short-circuit, scope-filtered, ranked
- [ ] Audit log written in-transaction; `GET /tickets/:id/audit`
- [ ] Portal: new incident form (no priority field), my tickets, ticket detail, close/reopen
- [ ] Console: queues (mine, my teams, all open, unassigned), URL-driven filters/sort, detail with full
      thread, assign/reassign, valid-only transition buttons, SLA countdown + breach badge
- [ ] Seed: categories, default SLA policies, ~30 incidents per org with varied ages and statuses

## M3 — Time and attention

_Exit: SLA warnings and breaches fire from the per-tenant dispatcher, arrive live over SSE and as email in
Mailpit; resolved tickets auto-close after 7 days under an injected clock; the notification bell works and
never shows another tenant's events — nor a ticket the agent may not read._

- [ ] BullMQ: `tenant-dispatch` dispatcher, per-tenant `sla-scan` and `auto-close`, `Clock` provider,
      `WORKER_MODE` (ADR-0018)
- [ ] SLA warning/breach flags with the split thresholds, notifications, audit entries (`DOMAIN.md` §4.3)
- [ ] `Notification` + `GET /notifications` + mark read + `dedupeKey` + SSE stream namespaced
      `org:<orgId>`, fan-out filtered through `scopeFor()` (ADR-0008)
- [ ] `apps/app`: bell, inbox, live query invalidation, assignment toast
- [ ] Email notifications for `DOMAIN.md` §8 events; per-**membership** preferences + org kill switch
- [ ] Worker tests with fake timers; dispatcher tests covering suspended-org skipping
- [ ] Maintenance jobs: `attachment-sweep` scaffold, `audit-partition`, `projection-reconcile`

## M4 — Four record types

_Exit: Service Requests, Problems and Changes each work end to end with their own state machines; a
Problem links incidents; a Change goes submit → approve/reject by a team lead → implement → close, and a
single-admin workspace can still ship one._

- [ ] `ProblemDetails`, `ChangeDetails`, `ChangeApproval`, `TicketLink`
- [ ] Transition tables for SR / Problem / Change; approval rules including the documented last-approver
      self-approval case; `(type, status)` `CHECK` constraint
- [ ] Type-specific forms and detail panels (planned window, risk, plans, root cause, workaround)
- [ ] Linking: `POST /tickets/:id/links` with canonical directions and uniqueness, linked-tickets panel,
      "create Problem from these incidents", "create Change from this Problem"
- [ ] Console: per-type queues, approval inbox for leads and admins
- [ ] Seed: problems with linked incidents, changes in every state, a few watched tickets

## M5 — Context: assets, knowledge, attachments

_Exit: assets link to tickets with a "tickets for this asset" view; KB articles are searchable and
suggested while a requester types; files attach to tickets and comments through presigned MinIO uploads,
stored under the tenant's key prefix and served so an uploaded file can never execute in the app's origin._

- [ ] `Asset`, `TicketAsset`; asset CRUD, picker on tickets, asset detail with ticket history, requesters
      see their own
- [ ] `KnowledgeArticle` with per-org tsvector search, markdown editor, `version`, three-tier visibility
      (`DRAFT` / `INTERNAL` / `PUBLISHED`), portal search + suggestions on the new-ticket form
- [ ] `Attachment` presigned upload (exact signed `Content-Length` + `Content-Type`) → confirm with
      **byte sniffing** → `READY`; MIME allow-list excluding SVG/HTML; `org/<orgId>/…` keys; separate
      serving origin with `Content-Disposition: attachment`; storage quota increment **and decrement**
      (ADR-0005)
- [ ] Seed: ~20 assets and ~15 articles per org

## M6 — Email intake

_Exit: mail to a tenant's inbound address creates a ticket in that tenant, attributed only to a verified
sender; a reply threads onto the existing ticket; an unresolvable tenant or an unauthenticated sender is
dropped, never guessed._

- [ ] `InboundEmail`, signature-verified webhook, `mailparser`, tenant resolution from the recipient
      address **before** anything else (ADR-0018)
- [ ] **Sender authentication**: require the provider's DMARC-aligned verdict; map the sender to an
      active `Membership`; unknown senders dropped by default, or created as a visibly-badged external
      requester if the org opts in. Never silently attribute (ADR-0027)
- [ ] Threading by `In-Reply-To` and `[INC-000042]` in the subject, **and** only when the verified sender
      is a participant on that ticket; otherwise a new linked ticket
- [ ] Server-side attachment ingest to MinIO with the same allow-list, size cap and quota accounting
- [ ] Bounce/auto-reply detection (`Auto-Submitted`, `Precedence: bulk`); loop protection
- [ ] Dev harness: a script posting a sample inbound payload; `source: EMAIL` visible in the console

## M7 — Differentiators

_Exit: new tickets get an LLM suggestion an agent can accept; a phishing report is scored and lands in the
Security queue; likely duplicates surface with a merge action; admins define automation rules that
demonstrably fire — all per tenant, none blocking ticket creation._

- [ ] `ollama` in Compose, `TicketClassifier` + Ollama impl, per-tenant `triage` queue, `TicketTriage`,
      accept/dismiss UI, `Noop` impl for tests, gated on plan
- [ ] `apps/phishing-svc` (FastAPI) wrapping the thesis model, `UrlRiskScorer`, portal "Report phishing"
      form, `PhishingReport`, risk badge, Security routing (ADR-0010)
- [ ] `EmbeddingProvider` (`nomic-embed-text`), `TicketEmbedding` + pgvector HNSW, similar-tickets panel
      scoped to the tenant, merge via `DUPLICATE_OF` + cancel
- [ ] `AutomationRule` engine (`DOMAIN.md` §10), admin UI, per-rule execution audit, per-tenant evaluation
- [ ] Prompt-injection posture documented and tested: ticket text is attacker-controlled, so model output
      is **data an agent accepts**, never an instruction and never auto-applied
- [ ] Seed: rules replicating hard-coded escalation; sample phishing tickets

## M8 — Platform layer

_Exit: an operator can run the platform without being able to read anyone's mail; an owner can grant a
time-boxed read-only support session and see exactly what was looked at; a monitoring system can raise
incidents through a scoped token._

- [ ] Platform back-office (`admin.patchgrid.xyz`): org list, suspend/unsuspend, set plan,
      request/restore deletion; metadata only, no tenant content (`RBAC.md` §8). Platform admins created
      by CLI only
- [ ] **Consent-based support access** (ADR-0020): owner grants a time-boxed read-only session,
      `SupportSession`, **per-request** `SUPPORT_READ` audit into the tenant's log, in-app banner, owner
      emails on grant/first use/expiry, instant revoke via the epoch
- [ ] **Scoped API tokens** (ADR-0021): `ApiToken` + `ApiTokenIndex`, bearer strategy, the documented
      scope→permission mapping, once-only secret display, per-token rate limits, admin UI with
      `lastUsedAt`, `source: API` and `actorKind: SERVICE` attribution
- [ ] Org deletion flow: owner request, 30-day soft window, hard purge under `runAsTenant` including
      object storage; permanent slug reservation
- [ ] **Data protection** (ADR-0028): `GET /org/export` as an async owner-only job; pseudonymised user
      erasure; retention windows per entity

## M9 — Hardening

_Exit: the security review has no open findings; E2E covers the core flows across two tenants in a real
browser, including the negative cases; observability answers "which tenant is slow" without grepping._

- [ ] **MFA (TOTP)** (ADR-0029): mandatory for `PlatformAdmin`, optional-but-enforceable per org, with
      recovery codes and step-up re-authentication for `org:delete`, `org:transfer_ownership`,
      `support:grant_access` and `token:create`
- [ ] Playwright E2E: signup → provision → invite → incident lifecycle; SLA breach with a 1-minute
      policy; change approval; **a cross-tenant negative test, a role-escalation negative test, and the
      two-tabs-two-tenants test in a real browser**
- [ ] **Observability** (ADR-0030): OpenTelemetry replacing the no-op `Tracer`, `orgId`/`permission` span
      attributes, Prometheus metrics (request duration, DB transaction duration, queue depth and job
      duration per tenant, SLA breaches per tenant), collector + Grafana behind a Compose profile
- [ ] Security review against the M1 threat model: headers, rate limits, dependency audit, attachment
      handling, cookie tossing, token leakage, prompt injection
- [ ] OpenAPI polished (tags, examples) at `/api/docs`
- [ ] Load sanity check: one tenant with 100k tickets, confirming the scope-filter `UNION ALL` and the
      keyset cursors hold up

## M10 — Ship

_Exit: a stranger clones the repo, runs three commands, signs up, and uses a realistic system; the public
demo is live; the README explains the decisions._

- [ ] Realistic two-tenant demo seed across all types/ages/statuses, KB, assets, rules; idempotent
      `db:reset`
- [ ] `apps/www` finished: docs, pricing, blog, `/problems/*`, OG images, sitemap, robots, Lighthouse pass
- [ ] Dockerfiles (multi-stage `turbo prune`) for `www`, `app`, `api`, `phishing-svc`;
      `docker-compose.prod.yml`
- [ ] **DNS and TLS** (ADR-0026, ADR-0027): wildcard `*.patchgrid.xyz`, DNS-01 via delegated
      `_acme-challenge`, CAA records, SPF/DKIM/DMARC progression, MX for `inbound.`
- [ ] Deploy: Coolify on Hetzner, managed Postgres/Redis/MinIO, migrations in a post-deploy hook, nightly
      demo reset, Ollama on-server or degraded
- [ ] README: architecture diagram, screenshots/GIF, "why these decisions" linking to ADRs, run
      instructions

---

## Explicitly out of scope (do not build unless this doc changes)

- Payment processing / self-serve billing (plans exist; a platform admin sets them)
- SSO / SAML / OIDC per tenant, SCIM provisioning
- Per-tenant custom domains (`support.acme.com`) — the design accommodates it (`DNS.md`), v1 does not
  ship it
- Custom form builder / configurable workflow DSL
- Multi-brand or multi-channel intake (chat widget, Slack/Teams) — email + portal only
- Business-hours SLA calendars and holiday schedules (ADR-0003 documents the extension path)
- Multi-stage CAB approval, approval delegation
- Custom/customer-defined roles or per-field permission policies (ADR-0019 documents the path to a policy
  engine)
- Write-capable support sessions or operator impersonation (ADR-0020)
- Outbound webhooks (`webhooks:write` is reserved in the scope list for later)
- Database-per-tenant or schema-per-tenant isolation (ADR-0015 documents the path if ever needed)
- Internationalisation — English only, `english` text search config
- Antivirus scanning of attachments — deferred with a stated reason, not omitted (ADR-0005); the
  mitigation is the MIME allow-list, byte sniffing, a separate serving origin and forced download
- Mobile apps
- Reporting/BI beyond simple queue counts
