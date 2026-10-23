# Patchgrid — Feature Backlog by Milestone

Vertical slices, not horizontal layers: every milestone ends with something you can click through. Do not
start the next milestone until the current one's exit criteria are met. Do not add a feature that is not on this
list without adding it here first (and an ADR if it is a real decision).

**Build order: M0 → M6, then M8 → M14** (re-planned 2026-10-15; M11–M14 added 2026-10-17 by ADR-0048;
M7 dropped 2026-10-23 by ADR-0056). M7, the models and the automation rule engine, is not part of the
plan: no LLM, embeddings, phishing service or rule engine is built. Milestone numbers are kept as they
were, because ADRs, the threat model and code comments refer to them by number; 7 is simply unused.
"Milestone N+1" below means the next one in this order.

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
      `PrismaService`, migration + seed scripts, `pgvector` (removed with M7, ADR-0056), **two DB roles**
      (owner **with** `BYPASSRLS`, `patchgrid_app` **without**) created by the Postgres init script,
      including `GRANT`s and `ALTER DEFAULT PRIVILEGES`; the same SQL as an idempotent file run by
      `db:migrate`; boot assertion that the app's role lacks `BYPASSRLS`
- [x] `packages/contracts`: shared primitives — ids, cursor pagination, Problem Details, slug schema,
      `RESERVED_SLUGS`, `formatTicketNumber` / `parseTicketNumber`, limit constants. 59 round-trip tests;
      `apps/www` renders its problem pages from the registry rather than a copy of it
- [x] `docker-compose.yml`: postgres (init script; pgvector until ADR-0056), redis, minio (+ bucket; **CORS is a
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

**Met on 2026-10-09.** Walked in a real browser: signup on the marketing site, the verification link, the
workspace created with the address chosen at signup, an agent invited and joined with a new account;
the seeded Acme and Globex with Dana holding both open; `pnpm test:tenancy` and `pnpm test:authz` green
as CI gates. One clause of the isolation suite — the dispatcher's fan-out — waits for the first
per-tenant sweep in M2.

- [x] **Threat model** (`docs/THREAT-MODEL.md`): assets, actors, trust boundaries, STRIDE per boundary.
      Written **first** — it informs the design rather than certifying it, and it is a one-page document.
      Findings TM-3…TM-5 decided in ADR-0031; TM-1 (attachment origin, M5) and TM-2 (platform actor, M8) open
- [x] Data: `Organization`, `OrganizationSlugHistory`, `User`, `Membership`, `TeamMembership`,
      `Invitation`, `Team`, `RefreshToken`, `PasswordResetToken`, `EmailVerification`, `PlatformAdmin`,
      `UserOrgIndex`, `ApiTokenIndex` — with composite `(orgId, id)` uniques and membership references
      throughout (ADR-0023). Shipped with its five catalog assertions, migration drift and
      migration-safety checks as the CI `schema` job
- [x] **RLS**: hand-written policy migrations from one template, `FORCE ROW LEVEL SECURITY`, tenant
      Prisma client extension with transaction-local `set_config` and CLS-aware nesting, `nestjs-cls`
      context, `runAsTenant` / `runAsPlatform` (ADR-0015, ADR-0022). Shipped with the API's
      `TenantContextService` (read-only), `PrismaService.db` / `transaction()`, the two helpers in
      `src/platform/`, the import zones that confine them and `nestjs-cls`, and a twelve-assertion
      integration suite against live RLS in the CI `schema` job
- [x] Tenant resolution middleware: credential → org, `Origin` / `X-Patchgrid-Tenant` cross-check,
      Redis-cached org lookup, slug-history redirects (302), suspended/deleted handling (ADR-0024).
      Shipped as the first global guard (middleware cannot see route markers): a pure credential
      locator, a 60 s Redis read-through over the first platform repositories, a thirteen-row
      decision table, and public `GET /tenants/:slug` as the API side of the app's 302s
- [x] Auth: signup, login, logout, refresh with rotation + reuse detection, email verification, password
      reset, Argon2id, **per-tenant cookies** on `.lvh.me`, Redis revocation epoch (ADR-0004, ADR-0017,
      ADR-0024). Shipped 2026-10-05: login with the uniform 401 and timing equaliser, `pg_id` as a
      rotating `RefreshToken`, the org switcher re-reading `Membership` in `runAsTenant`, refresh with
      chain revocation on reuse, logout and logout-everywhere with the epoch, the auth and CSRF guards,
      the `Actor`; signup answering `202` with the same Argon2id cost on both paths, the verification
      link completing signup and starting the session, resend, password reset and change ending every
      session. Two full-stack lifecycle specs drive it all through the booted app. Throttling (its own
      item) is still to come
- [x] Org provisioning: slug validation + availability, transactional creation, default
      teams/categories/**eight** SLA policies/KB, idempotent `provision-org` job; one org per unverified
      user. Shipped 2026-10-05: `POST /orgs` (`@TenantOptional`, a verified `pg_id` holder becomes the
      owner) writes `Organization`, the owner `Membership`, the `UserOrgIndex` row and the three default
      teams in one transaction inside `runAsTenant` on an id minted up front; uniqueness across current
      and retired slugs is decided under a transaction-scoped advisory lock on the slug (`409` to the
      loser, proven with two simultaneous creators); the response sets the new workspace's cookie pair.
      Public, throttled `GET /orgs/slug-available` names the reason a slug is not free. Unverified
      accounts create **no** org — stricter than "one". Categories, SLA policies and KB defaults join
      with their M2 tables, and with them the `provision-org` job: nothing is slow enough for it yet
- [x] Membership: invite (org-bearing token), accept, disable, remove, change role; last-owner protection
      **under a row lock**; org switcher minting tenant-bound cookie pairs. Shipped 2026-10-09 (ADR-0033):
      `REMOVED` as a terminal status that keeps history attributed; `GET/POST/DELETE /invitations`, public
      `GET /invitations/preview` and `POST /invitations/accept-new`, tenant-optional `POST
      /invitations/accept`; `GET /members[/:id]`, `PATCH /members/:id/role`, `POST /members/:id/disable|enable`,
      `DELETE /members/:id`. Every change locks the organization row, mirrors `UserOrgIndex`, audits and
      bumps the epoch in one transaction; a full-stack spec proves the lifecycle and two owners demoting
      each other at once. Seat limits join with `QuotaService`
- [x] Teams: CRUD, `TeamMembership`, lead assignment, "manage own team's members" for leads. Shipped
      2026-10-09: `GET/POST /teams`, `GET/PATCH /teams/:id` (deactivate, never delete), `PUT /teams/:id/lead`
      (admins), `PUT/DELETE /teams/:id/members/:membershipId` (a lead for their own team, admins for any).
      Team rows are locked for membership and lead changes, every affected member's epoch is bumped in the
      transaction, requesters join no team, and demoting a member to requester takes them out of every team
- [x] `authz` module: unified permission catalog/matrix in `@patchgrid/contracts`, pure
      `PermissionService` (`can` / `assert` / `scopeFor` / `permissionsFor` / `capabilitiesFor`),
      `@RequirePermission` guard, deny-by-default, branch-shaped `ScopeFilter` (ADR-0019, ADR-0025).
      Shipped 2026-10-09, built before membership because its routes needed it: the matrix is data in
      contracts, held cell by cell to `RBAC.md` §6 by a test that parses the document; `can()` reads a
      loaded `Subject` and nothing else (a lint zone forbids I/O under `src/authz`); `assert` is the 403,
      `assertVisible` the 404; service actors are role ∩ scopes. `capabilitiesFor` waits for its first
      subject, the ticket, in M2
- [x] `GET /me` returning `{ user, membership, org, teams, permissions[] }`; `apps/app` renders from it.
      Shipped 2026-10-09: a spec holds two workspaces open as one account; the app's `(tenant)` layout
      reads it once per navigation into `TenantProvider`, and the navigation is drawn from it
- [x] `Organization.agentVisibility` setting + `scopeFor()` unit tests (plumbed into real list queries in
      M2, where lists first exist). Shipped 2026-10-09 with the org settings: `GET/PATCH /org/settings`
      (name, notifications, agent visibility — its own audit action, and the cached summary invalidated)
      and the owner's `POST /org/slug` (30-day cooldown, old slug retired for a 302 window, session
      re-minted under the new cookie name)
- [x] Org-wide audit actions (`RBAC.md` §12) and `GET /org/audit` with its indexes. Shipped 2026-10-09:
      the partitioned `AuditLog` with forced RLS on every partition (ADR-0034), `AuditService` writing in
      the change's transaction, the member, invitation, team and settings actions, and `GET /org/audit`
      paged newest first and filtered by actor, action and date range. Support, token and plan actions
      join with their items
- [x] **Authorization suite**: exhaustive matrix test, deny-by-default, route-coverage reflection test,
      escalation negatives including concurrent last-owner demotion — wired as a CI gate. `pnpm
      test:authz` (its own `verify` step) drives every role × permission through satisfying and failing
      subjects and walks the module graph for unmarked routes; the concurrent demotion is in the
      membership lifecycle spec under `test:integration`
- [x] `QuotaService` + `UsageCounter` with atomic conditional increments (seats first; ticket volume in
      M2); Postgres authoritative, Redis a display cache. Shipped 2026-10-09: `PLAN_LIMITS` in contracts
      held to `TENANCY.md` §8 by a test; one conditional update per consume inside the counted change's
      transaction; seats taken and freed through acceptance, role change, enable, disable and remove;
      `GET /org/usage`; a spec racing two promotions for the last seat. The Redis display cache waits
      for a reader that needs it — `GET /org/usage` is one indexed read
- [x] Throttling on `/auth/*`, signup and slug lookup, per IP **before** tenant resolution. Shipped
      2026-10-05: two guards — per address (and per email hash on any route naming one, ADR-0031) before
      resolution, per organization after it — on a Redis Lua counter that fails open, `429` as
      `rate-limited` with a plain `Retry-After`, health never throttled, `THROTTLE_ENABLED` off only for
      the lifecycle specs. Per token waits for the M8 api-tokens item
- [x] Mail: `MailProvider`, Mailpit SMTP impl, BullMQ `mail` queue, react-email templates (verify,
      invite, reset). Shipped 2026-10-05 with the BullMQ root, `runJob` (the processor wrapper that
      opens the tenant context), `WORKER_MODE`, `PublicUrls`, an `account-exists` template for
      ADR-0031's signup path, and a Mailpit round-trip spec. Templates are React elements rendered by
      `@react-email/render`; the `@react-email/components` widget set is skipped — npm marks it
      unsupported
- [x] `apps/www`: landing, pricing, signup flow with live slug availability. Shipped 2026-10-09: the
      landing page opens with the priority matrix working, from the contracts' `PRIORITY_MATRIX` and
      `DEFAULT_SLA_TARGETS`; pricing renders `PLAN_LIMITS`; signup checks the address live and carries the
      chosen workspace to `app.` in a non-secret cookie, since nothing is reserved before verification
- [x] `apps/app`: login, accept invite, reset, org picker, create workspace, `proxy.ts` host parsing,
      `apiFetch` with tenant cookie selection + refresh-and-retry, `TenantProvider`. Shipped 2026-10-09
      under ADR-0035 (the browser owns the refresh): a pure, table-tested routing decision behind
      `proxy.ts`; a server client that forwards only this workspace's cookie and redirects on 401, and a
      browser client that refreshes once for every concurrent 401; verify-email, the invitation's three
      cases, the picker with sign-out everywhere, workspace creation with the live check
- [x] Admin UI: members list, invite, role changes, teams CRUD with lead, org settings (name, slug change).
      Shipped 2026-10-09, plus usage against the plan and the audit log read as sentences. A page whose
      data the role may not read renders the workspace's not-found page
- [x] Seed: two orgs with similar data + a dual-member user. Shipped 2026-10-09: `seedLookalikes` in
      `packages/database` writes Acme and Globex with the same team names, display names, roles and an
      invitation to the same address, plus Dana (admin at one, agent at the other); `pnpm db:seed` is
      idempotent (`-- --reset` replaces), every demo password `patchgrid-demo`. Categories and tickets
      join with their M2 tables
- [x] **Tenancy isolation suite** (`ENGINEERING.md`) — all thirteen assertions, wired as a CI gate.
      `pnpm test:tenancy` (its own step in the CI `schema` job) runs the catalog assertions (7, 10, 11)
      then the suite over `seedLookalikes` with a suffix per run. One clause waits: assertion 8's
      dispatcher fan-out lands with `tenant-dispatch`, the first per-tenant sweep, in M3

## M2 — Incident lifecycle (the heart)

_Exit: a requester submits an Incident from the portal; it gets a per-org number, computed priority, SLA
deadlines and a routed team; an agent assigns, replies publicly, adds an internal note, moves to pending
and back, resolves; the requester closes or reopens; two agents editing the same ticket get a clean
conflict; every step is audit-logged; transition table, priority matrix and SLA clock are unit-tested._

**Met on 2026-10-09.** Walked in a real browser against the seeded workspaces: Rita raises an incident
from the portal (no priority field) and gets `INC-000002` with a computed priority and deadlines; Sam
takes it from the unassigned queue, starts, replies, adds an internal note, waits on the requester and
resumes, resolves with the required note (refused without one); Rita closes it. Sam and Dana editing one
ticket: the second save is a `409` and a reload. Every step is in the ticket's audit trail; the domain
rules are unit-tested and the lifecycle, visibility, search and idempotency are integration-tested.
Sort is creation time only, either direction — the one order with an index behind it.

- [x] Data: `TicketCounter`, `Ticket` (with clock origins, `version`, `searchVector`), `Category`,
      `SLAPolicy`, `Comment`, `TicketWatcher`, `AuditLog` (partitioned) — all tenant-owned, all with
      policies and composite keys
- [x] Admin UI: category tree (3 levels, unique per parent, soft-delete only, default team), SLA policies
- [x] Ticket service: create (per-org numbering, priority, SLA targets, category routing, atomic quota
      check, `Idempotency-Key`), update with optimistic `version`, Incident transition table, reopen,
      cancel, create-on-behalf
- [x] `POST /tickets/:id/transitions` with required comments on `wait` / `resolve` / `cancel`, returning
      `availableActions` **and** `capabilities` (ADR-0006, `RBAC.md` §7)
- [x] Comments: public vs internal, 15-minute edit window, soft delete, with an integration test proving
      a requester-scoped query can never return an internal note
- [x] Watchers: add/remove self and others, implicit requester/assignee, watcher read scope
- [x] `scopeFor()` plumbed into every list query as a `UNION ALL` of branches; `OWN_TEAM_ONLY` exercised
      with a multi-team agent
- [x] Ticket search: generated `tsvector`, GIN index, number short-circuit, scope-filtered, ranked
- [x] Audit log written in-transaction; `GET /tickets/:id/audit`
- [x] Portal: new incident form (no priority field), my tickets, ticket detail, close/reopen
- [x] Console: queues (mine, my teams, all open, unassigned), URL-driven filters/sort, detail with full
      thread, assign/reassign, valid-only transition buttons, SLA countdown + breach badge
- [x] Seed: categories, default SLA policies, ~30 incidents per org with varied ages and statuses

## M3 — Time and attention

_Exit: SLA warnings and breaches fire from the per-tenant dispatcher, arrive live over SSE and as email in
Mailpit; resolved tickets auto-close after 7 days under an injected clock; the notification bell works and
never shows another tenant's events — nor a ticket the agent may not read._

**Met on 2026-10-14.** Against the seeded workspaces with the dev stack: Rita raises a ticket and Mailpit
holds her emailed receipt from "Acme"; Sam's reply reaches her inbox and her email; with its response
deadline moved into the past, the live per-tenant dispatcher flags the breach within a minute, audits
`SLA_BREACHED`, and Mailpit holds the breach for Sam (assignee) and Alice and Dana (admins). In a real
browser signed in as Sam: Dana assigning him a ticket raises the "Assigned to you" toast and the bell's
count without a reload; the queue gains the ticket live; Rita's reply appears on his open ticket page;
he adds Dana as a watcher, replies, and edits his reply (marked edited); the inbox and email preferences
work and persist. A second `EventSource` in his page, recording every frame while Globex raises a ticket
and, under `OWN_TEAM_ONLY`, an Acme ticket is routed to Security and commented on, receives that ticket
only at creation — while unteamed and in his scope — then nothing until the unteamed sentinel. Auto-close
at seven days runs under fake timers (`worker-timeline.spec.ts`) and through its processor against a real
database (`sweeps.int-spec.ts`). The stream's isolation and scope are CI gates: the tenancy suite and an
authz-suite spec holding the fan-out equal to `TicketAccess` for every role, visibility, relationship and
team placement.

- [x] BullMQ: `tenant-dispatch` dispatcher, per-tenant `sla-scan` and `auto-close`, `Clock` provider,
      `WORKER_MODE` (ADR-0018)
- [x] SLA warning/breach flags with the split thresholds, notifications, audit entries (`DOMAIN.md` §4.3)
- [x] `Notification` + `GET /notifications` + mark read + `dedupeKey` + SSE stream namespaced
      `org:<orgId>`, fan-out filtered through `scopeFor()` (ADR-0008, ADR-0036)
- [x] `apps/app`: bell, inbox, live query invalidation, assignment toast — plus live updates, watchers and
      comment edit/delete on the ticket page
- [x] Email notifications for `DOMAIN.md` §8 events; per-**membership** preferences + org kill switch
      (invitations already email; change approvals notify as `CHANGE_AWAITING_APPROVAL`, `_APPROVED` and
      `_REJECTED`; plan-limit notices were added on 2026-10-23)
- [x] Worker tests with fake timers; dispatcher tests covering suspended-org skipping
- [x] Maintenance jobs: `attachment-sweep` scaffold, `audit-partition` (with retention archive),
      `projection-reconcile`

## M4 — Four record types

_Exit: Service Requests, Problems and Changes each work end to end with their own state machines; a
Problem links incidents; a Change goes submit → approve/reject by a team lead → implement → close, and a
single-admin workspace can still ship one._

- [x] `ProblemDetails`, `ChangeDetails`, `ChangeApproval`, `TicketLink`
- [x] Transition tables for SR / Problem / Change; approval rules including the documented last-approver
      self-approval case; `(type, status)` `CHECK` constraint
- [x] Type-specific forms and detail panels (planned window, risk, plans, root cause, workaround)
- [x] Linking: `POST /tickets/:id/links` with canonical directions and uniqueness, linked-tickets panel,
      "create Problem from these incidents", "create Change from this Problem"
- [x] Console: per-type queues, approval inbox for leads and admins
- [x] Seed: problems with linked incidents, changes in every state, a few watched tickets

## M5 — Context: assets, knowledge, attachments

_Exit: assets link to tickets with a "tickets for this asset" view; KB articles are searchable and
suggested while a requester types; files attach to tickets and comments through presigned MinIO uploads,
stored under the tenant's key prefix and served so an uploaded file can never execute in the app's origin._

- [x] `Asset`, `TicketAsset`; asset CRUD, picker on tickets, asset detail with ticket history, requesters
      see their own
- [x] `KnowledgeArticle` with per-org tsvector search, markdown editor, `version`, three-tier visibility
      (`DRAFT` / `INTERNAL` / `PUBLISHED`), portal search + suggestions on the new-ticket form
- [x] `Attachment` presigned upload (exact signed `Content-Length` + `Content-Type`) → confirm with
      **byte sniffing** → `READY`; MIME allow-list excluding SVG/HTML; `org/<orgId>/…` keys; separate
      serving origin with `Content-Disposition: attachment`; storage quota increment **and decrement**
      (ADR-0005)
- [x] Seed: ~20 assets and ~15 articles per org

_Met 2026-10-15, walked in headless Chromium against the seeded workspaces: files attached, opened from
`localhost:9000` and a disguised SVG refused; an asset's history, a requester naming her phone on a new
ticket; articles searched with stemming, suggested under a ticket title, written, published, and a stale
save refused. Uploads land in staging and only checked bytes are served (ADR-0038)._

## M6 — Email intake

_Exit: mail to a tenant's inbound address creates a ticket in that tenant, attributed only to a verified
sender; a reply threads onto the existing ticket; an unresolvable tenant or an unauthenticated sender is
dropped, never guessed._

- [x] `InboundEmail`, signature-verified webhook, `mailparser`, tenant resolution from the recipient
      address **before** anything else (ADR-0018)
- [x] **Sender authentication**: require the provider's DMARC-aligned verdict; map the sender to an
      active `Membership`; unknown senders dropped by default, or created as a visibly-badged external
      requester if the org opts in. Never silently attribute (ADR-0027)
- [x] Threading by `In-Reply-To` and `[INC-000042]` in the subject, **and** only when the verified sender
      is a participant on that ticket; otherwise a new linked ticket
- [x] Server-side attachment ingest to MinIO with the same allow-list, size cap and quota accounting
- [x] Bounce/auto-reply detection (`Auto-Submitted`, `Precedence: bulk`); loop protection
- [x] Dev harness: a script posting a sample inbound payload; `source: EMAIL` visible in the console

_Met 2026-10-15. Each step was walked through `inbound:send` against the dev stack and the browser:_

- _Rita's mail became an incident badged "Email", with its file._
- _Her reply to the confirmation email threaded onto it, with the quote cut._
- _A forged message and a stranger's were recorded and nothing more._
- _The admin's inbound log showed each outcome._

_External requesters, deferred by ADR-0039, were built on 2026-10-23 (ADR-0055). An account that later
joins under the same address takes the external membership over (ADR-0057)._

## M8 — Platform layer

_Exit: an operator can run the platform without being able to read anyone's mail; an owner can grant a
time-boxed read-only support session and see exactly what was looked at; a monitoring system can raise
incidents through a scoped token._

- [x] **The platform credential** (ADR-0040, resolves TM-2): its own login, TOTP enrolment and
      verification with recovery codes (the platform-admin half of ADR-0029, brought forward from M9),
      a path-scoped one-hour `pg_pa` session, `@PlatformRoute`, CLI-only `platform:grant`/`revoke`,
      `PlatformAuditLog`
- [x] Platform back-office (`admin.patchgrid.xyz`): org list, suspend/unsuspend, set plan, restore a
      pending deletion; metadata only, no tenant content (`RBAC.md` §8). Platform admins created by CLI only
- [x] **Consent-based support access** (ADR-0020, ADR-0041): owner grants a time-boxed read-only session,
      `SupportSession`, **per-request** `SUPPORT_READ` audit into the tenant's log, in-app banner, owner
      emails on grant/first use/expiry, instant revoke via the epoch. The operator reads through the
      tenant's own routes as a `support` actor; every write is refused at the guard
- [x] **Scoped API tokens** (ADR-0021, ADR-0042): `ApiToken` + `ApiTokenIndex`, bearer strategy, the documented
      scope→permission mapping, once-only secret display, per-token rate limits, admin UI with
      `lastUsedAt`, `source: API` and `actorKind: SERVICE` attribution. One service account per token,
      kept out of member admin, teams, assignment and watching; expiry warned a week ahead
- [x] Org deletion flow (ADR-0043): owner request, 30-day soft window, hard purge under `runAsTenant` including
      object storage; permanent slug reservation. An owner cancels from the picker, an operator restores from the
      back-office, both until the purge date; the purge leaves a `DELETED` tombstone
- [x] **Data protection** (ADR-0028, ADR-0044): `POST /org/exports` as an async owner-only job, a zip streamed into
      storage and mailed as a 24-hour link; pseudonymised self-service erasure from the picker; retention windows per
      entity (notifications and lapsed exports per tenant, expired credentials on the platform)

## M9 — Hardening

_Exit: the security review has no open findings; E2E covers the core flows across two tenants in a real
browser, including the negative cases; observability answers "which tenant is slow" without grepping._

- [x] **MFA (TOTP)** (ADR-0029, ADR-0045) for members — platform admins have it from M8 (ADR-0040):
      optional-but-enforceable per org (`requireMfa`, owner-set, gating open and refresh but never an open
      session), recovery codes, and step-up re-authentication carried as a `sua` claim on the access token
      for `org:delete`, `org:transfer_ownership` (raising anyone to `OWNER`), `support:grant_access` and
      `token:create`; the password proves a step-up only when no factor exists. Done 2026-10-16
- [x] Playwright E2E (`apps/app/e2e`, on `main` only): signup → verification → provision → invite →
      incident lifecycle; an SLA breach on a two-minute response target seen from the owner's view;
      change draft → submit → approve by someone else → implement → close; **the cross-tenant,
      role-escalation and two-tabs-two-tenants negatives in a real browser**. Done 2026-10-16
- [x] **Observability** (ADR-0030, ADR-0046): OpenTelemetry behind the `Tracer` seam, started before the
      app loads; `org.id`/`membership.id`/`actor.kind` on spans and every permission decision as a span
      event; the trace id as the request id; metrics for request duration, transactions per request and
      their duration, pool saturation, job duration by queue and tenant, SLA breaches, quota rejections,
      RLS refusals and authorization denials, `org` bounded to the top-25 tenants; collector, Tempo,
      Prometheus and a provisioned Grafana dashboard behind `--profile observability`. Done 2026-10-16
- [x] Security review against the M1 threat model (`THREAT-MODEL.md` §7, 2026-10-16): sixteen confirmed
      findings fixed with tests, the rest recorded with reasons. Covered: headers, rate limits, dependency audit, attachment
      handling, inbound mail, cookie tossing, token leakage (prompt injection was to be reviewed with M7,
      which is dropped, ADR-0056)
- [x] OpenAPI at `/api/docs` (`apps/api/src/openapi.ts`): built from the Zod DTOs, tagged by path,
      session and token security schemes, the first-integration requests as examples. Done 2026-10-16
- [x] Load sanity check (`pnpm --filter @patchgrid/database run load:tickets`, results in
      `ENGINEERING.md` §Testing): one tenant with 100k tickets; every list under 25 ms at p50, deep
      cursors no dearer than page one; found and fixed the two branches whose index lacked the sort
      column. Done 2026-10-16

## M10 — Ship

_Exit: a stranger clones the repo, runs three commands, signs up, and uses a realistic system; the README
explains the decisions. There is no public deployment (ADR-0047): Patchgrid runs locally._

- [x] Realistic two-tenant demo seed across all types/ages/statuses, KB, assets, inbound mail; idempotent
      `db:reset`
- [x] `apps/www` finished: docs, pricing, blog, `/problems/*`, OG images, sitemap, robots, Lighthouse pass.
      Eight docs and four posts as MDX from one registry; every page a prerendered shell (Cache
      Components) with the session check streamed in; canonical metadata, build-time OG cards, sitemap,
      robots, JSON-LD. Lighthouse (mobile, local): performance 90–98, accessibility and SEO 100,
      best practices 100 but for the two HTTPS audits a local run cannot pass
- [x] Dockerfiles (multi-stage `turbo prune`) for `www`, `app`, `api`; `docker-compose.prod.yml`.
      `apps/api/Dockerfile` (`runtime`, `tools`) and `docker/next.Dockerfile` (standalone); the compose
      file runs migrate → api, worker, app, www against managed state. Smoke-tested locally against the
      dev stack's Postgres, Redis and MinIO; CI builds all three. `TRUST_PROXY_HOPS` replaces the fixed hop count
- ~~DNS and TLS~~ and ~~the public deployment~~: **dropped** (ADR-0047). The design stays in `DNS.md`,
      ADR-0026 and ADR-0027, and the images keep building in CI; what only a real deployment would prove
      is listed in `HANDOFF.md`
- [x] README: architecture diagram, screenshots/GIF, "why these decisions" linking to ADRs, run
      instructions. Three commands from a clone — `pnpm install && pnpm local:up && pnpm dev` — walked
      on a fresh clone in its own compose project: 6/6 invariants, the seed, a signup whose verification
      mail arrives

## M11 — Reliable delivery

_Exit: a side effect of a committed change cannot be lost and is not repeated: kill the worker between
commit and delivery and the notification still arrives once. One tenant flooding its log does not delay
another's notifications. A tenant subscribes an endpoint, receives signed deliveries, sees failures
retried and parked, and replays them, and a slow or hostile endpoint harms nobody else._

- [x] Transactional outbox read as a per-tenant log (ADR-0049): `OutboxEvent` written in the change's own
      transaction, ordered by transaction id and read only below the snapshot horizon, so no reader
      skips an event that commits late; `EventConsumer` cursors; poison events parked in
      `EventDeadLetter`
- [x] The relay: a `LISTEN` wake on commit, per-tenant drain jobs, a sweep as the safety net; ticket
      notifications move onto it, and their inbox rows are written in the same transaction as the
      cursor that consumed them. A worker that boots catches up at once; `test/events/` proves the
      horizon, the lock, poison parking, recovery after downtime and fairness against Postgres
- [x] Fairness: a drain takes a bounded batch and yields, so tenants are served round-robin; a flood test
      proves one tenant's backlog does not delay another's; per-tenant lag on the dashboard. The flood
      test is `test/events/delivery.int-spec.ts`; the lag is the dashboard's event-age p95 by tenant
- [x] Outbound webhooks (ADR-0050): `WebhookEndpoint` (owner/admin; no token, see the ADR), the Standard Webhooks
      signature with rotating secrets, a delivery log, retries with backoff and jitter, dead letters with
      replay, a circuit breaker per endpoint, SSRF protection on the target, a per-tenant concurrency cap
- [x] Settings UI for endpoints, deliveries and replay; the public event catalogue in the docs site.
      Settings → Webhooks (list, add with the secret shown once, edit, turn off and on, rotate, remove,
      the delivery log with replay), walked in a browser against a local receiver; `/docs/webhooks`
      renders the catalogue from the same constant as the picker
- [x] Event retention: consumed events deleted past the retention window, never ahead of a cursor.
      Daily in `retention-sweep`: finished deliveries past 30 days, then events past 30 days that every
      consumer has read and nothing points at, in batches of 5,000

## M12 — Insight

_Exit: an admin opens a reports page that answers "are we meeting our SLAs, and where not?" in under
100 ms at a hundred thousand tickets, with numbers that agree with the tickets. An agent saves a view
and closes two hundred tickets in one action, with every refusal and conflict reported per ticket._

- [x] A reporting read side (ADR-0051): a `TicketFact` per ticket (what reports group by, and the
      durations and clock outcomes already computed), refreshed by the `reporting` consumer of M11's log,
      built and checked by a nightly reconcile; rollups only if the load check asks for them
- [x] Reports: SLA compliance by priority, team and category; median and p90 time to resolve; backlog
      age; workload per agent. Charts in the app, CSV export. Every report under 25 ms at 100k tickets
      (`ENGINEERING.md`); walked in a browser on the demo seed
- [x] The reconcile recomputes facts from source and counts every one it has to change as drift
- [x] Saved views (ADR-0052): a list query per member, shareable with one of their teams, run as each
      reader; the list query gains a priority filter
- [x] Bulk actions (ADR-0052): assign or any transition over up to 200 tickets, each through the single
      action's own path and transaction, a per-ticket outcome, and progress over the live stream; walked
      in a browser

## M13 — Identity

_Exit: a member signs in with a passkey and uses it for step-up; a workspace with SSO configured sends its
members to their identity provider, and a new member is provisioned on first sign-in._

- [x] Passkeys (WebAuthn): register, sign in without a password, step-up with a passkey (ADR-0045's
      `sua`), list and revoke. ADR-0053 and its erratum; the browser suite drives a virtual authenticator.
      Done 2026-10-22
- [x] Per-tenant OIDC (authorization code with PKCE) against a local Keycloak profile in Compose; the
      workspace's verified email domain routes sign-in; just-in-time membership at a default role;
      "SSO required" mirrors `requireMfa`. ADR-0054 and its erratum: the domain proved by a TXT record,
      the session an IdP starts scoped to its workspace, owners exempt; the browser suite signs in
      through Keycloak. Done 2026-10-23
- [x] Threat model and authorization updates: which routes a SSO-only member may still use, and how an
      owner recovers when the provider is down. `THREAT-MODEL.md` TB12 and §10 (the M13 review),
      `RBAC.md` §2, `TENANCY.md` §5–§6. Done 2026-10-23

## M14 — Production rehearsal on emulated AWS

_Planned 2026-10-24 by ADR-0058, replacing ADR-0048's Caddy-and-replica plan. Floci emulates AWS
locally and OpenTofu provisions it; the infrastructure is written for real AWS with only the endpoints
overridden, and no AWS-native rewrite of tested architecture is made._

_Exit: `pnpm aws:up` builds the three production images, pushes them to ECR and applies the
infrastructure; migrations run as a one-off ECS task; the API, worker, app, www and PgBouncer run as
ECS services behind an HTTPS ALB on `*.patchgrid.test`, on an RDS database whose roles RDS itself could
create, with ElastiCache, S3, SES, Secrets Manager under KMS and CloudWatch Logs; the tenancy suite
passes through PgBouncer and the browser suite passes through the ALB, passkeys included, with no
Chrome flag._

- [ ] Database roles a managed Postgres can create (ADR-0059): no `FORCE`, no `BYPASSRLS` anywhere, the
      bootstrap run as a `CREATEROLE`-only admin, the app role asserted to be no member of the owner
- [ ] The application ready for AWS: S3 credentials from the default provider chain (task role), an SES
      `MailProvider`, a direct `LISTEN` URL beside a pooled one, graceful drain on `SIGTERM`
- [ ] Floci pinned by digest, its CA exported and trusted; OpenTofu state in S3 with DynamoDB locking
- [ ] Network, data and secrets: VPC, two subnets, security groups by tier; RDS PostgreSQL 17 with
      parameter group and TLS; ElastiCache; S3 buckets with CORS, versioning, encryption and the
      `staging/` lifecycle rule; KMS key and Secrets Manager secrets; least-privilege task roles
- [ ] Compute and edge: ECR repositories with lifecycle policies; one ECS cluster running api, worker,
      app, www and PgBouncer; ALB with ACM certificate, host rules, 80 → 443, HSTS, health checks and
      deregistration delay; Route 53 private zone for the workspace hosts, public zones for domain
      proof
- [ ] Deploy as one command: build → push → `tofu apply` → migrations task → rolling update → healthy
      targets; `aws:down` and `aws:deploy` beside it
- [ ] Verification: the tenancy suite through PgBouncer, the browser suite (passkeys included) through
      the ALB, a CI job that deploys to Floci; `docker-compose.prod.yml` retired
- [ ] Runbook: what a real AWS account still needs beyond this code, and each place Floci differs from
      AWS with the decision that covers it

---

## Explicitly out of scope (do not build unless this doc changes)

- Payment processing / self-serve billing (plans exist; a platform admin sets them)
- SAML and SCIM provisioning (per-tenant OIDC is M13)
- Machine learning and local models: LLM triage, embeddings and duplicate detection, phishing URL
  scoring, Ollama, pgvector (M7, dropped by ADR-0056)
- An automation rule engine (also M7; escalation is the hard-coded rule in `DOMAIN.md` §4.3)
- Per-tenant custom domains (`support.acme.com`) — the design accommodates it (`DNS.md`), v1 does not
  ship it
- Custom form builder / configurable workflow DSL
- Multi-brand or multi-channel intake (chat widget, Slack/Teams) — email + portal only
- Business-hours SLA calendars and holiday schedules (ADR-0003 documents the extension path)
- Multi-stage CAB approval, approval delegation
- Custom/customer-defined roles or per-field permission policies (ADR-0019 documents the path to a policy
  engine)
- Write-capable support sessions or operator impersonation (ADR-0020)
- Database-per-tenant or schema-per-tenant isolation (ADR-0015 documents the path if ever needed)
- Internationalisation — English only, `english` text search config
- Antivirus scanning of attachments — deferred with a stated reason, not omitted (ADR-0005); the
  mitigation is the MIME allow-list, byte sniffing, a separate serving origin and forced download
- Mobile apps
- Reporting/BI beyond simple queue counts
