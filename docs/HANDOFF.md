# Handoff — M2 complete, M3 next

Written 2026-10-09, at the M2 → M3 boundary. **This file is regenerated, not appended to** — at every
milestone boundary, and whenever enough has landed that the previous version would mislead. If it
disagrees with `FEATURES.md` or an ADR, they are right and this is stale.

Read this first, then `CLAUDE.md`, then the documents it points at.

---

## What Patchgrid is

A **multi-tenant SaaS ITSM platform** — ticketing and operations for IT and security teams. It models
four ITIL record types (Incident, Service Request, Problem, Change) with four lifecycles, and priority is
_computed_ from impact × urgency rather than typed into a dropdown.

A learning and portfolio project built as though it were production: three deployables, tenants
addressed by subdomain, tenant data isolated at the database level.

| Host                   | App        | What it is                                       |
| ---------------------- | ---------- | ------------------------------------------------ |
| `patchgrid.xyz`        | `apps/www` | Landing, pricing, signup                         |
| `<slug>.patchgrid.xyz` | `apps/app` | A tenant's workspace — the product               |
| `app.patchgrid.xyz`    | `apps/app` | Tenant-less: login, picker, create workspace     |
| `api.patchgrid.xyz`    | `apps/api` | NestJS — all business logic and data access      |

Locally: `lvh.me:3000`, `<slug>.lvh.me:3001`, `app.lvh.me:3001`, `api.lvh.me:4000`.

---

## Where we are

**M0 (Foundation)** — complete 2026-09-22. **M1 (Tenancy and identity)** — complete 2026-10-09.
**M2 (Incident lifecycle)** — complete 2026-10-09: every item checked, and the exit criterion walked in
a real browser against the seeded workspaces — a requester raises an incident from the portal, an agent
takes it from the unassigned queue, replies, notes internally, waits and resumes, resolves; the
requester closes it; two agents saving one ticket get a clean `409`. See `FEATURES.md` §M2 for the note.

**CI is green on `main`.**

**Carried into M3:** the isolation suite's assertion 8 clause about the dispatcher fan-out (`it.todo`).
It lands with `tenant-dispatch`, which `FEATURES.md` places in M3 — an earlier note that said M2 was
corrected.

---

## What is implemented

### Infrastructure

Postgres 17 + pgvector, Redis 7, MinIO (**Chainguard's `minio:latest-dev`**, non-root; its volume is
`object-data`), Mailpit. Two roles: `patchgrid_owner` (BYPASSRLS; migrations, tests) and `patchgrid_app`
(neither BYPASSRLS nor CREATE). Three databases: `patchgrid`, `patchgrid_test`, `patchgrid_shadow`.

### `packages/database` — 8 unit, 13 catalog, 22 integration tests

Five migrations: identity and tenancy; the **partitioned `AuditLog`** and the `REMOVED` membership
status; the **`UsageCounter`** quota table; **tickets** (`TicketCounter`, `Category`, `SLAPolicy`,
`Ticket`, `Comment`, `TicketWatcher`, each with policy, composite keys and coverage, plus CHECKs for the
priority matrix, per-type statuses, category depth and SLA warning thresholds); **ticket search** — a
`GENERATED ALWAYS … STORED` `tsvector` (title weight A, description B, `english`) with a GIN index.

- **`AuditLog`** (ADR-0034): `PARTITION BY RANGE ("createdAt")`, key `(id, createdAt)`, no
  `(orgId, id)` unique (nothing references it). Every partition carries forced RLS and the template
  policy itself, because a query naming a partition is checked against the partition's policies.
  Partitions come from `ensure_audit_log_partition(timestamptz)`, a `SECURITY DEFINER` function the app
  role may execute — it never gains `CREATE`. No default partition.
- `src/lookalikes.ts` — **`seedLookalikes`**: Acme and Globex with the same team names, display names,
  roles and a same-address invitation, plus Dana (admin at Acme, agent at Globex). Used by `db:seed`
  (fixed slugs) and the isolation suite (a suffix per run).
- `scripts/demo-tickets.ts` — seed-only volume: a fuller category tree (with `Other` under two
  parents) and 29 incidents per workspace of every status and age, SLA clocks consistent with their
  history. Deterministic per workspace. Never used by a test; the lookalikes stay small.
- The catalog assertions exempt partitioned tables from the composite-target rule by catalog fact and
  assert nothing references them.

### `packages/contracts` — 165 tests

Beyond M0's primitives: the auth and identity shapes; **the permission catalog and matrix**
(`permissions.ts`, held cell by cell to `RBAC.md` §6 by a test that parses the document) with
`SCOPE_GRANTS`; the audit catalogue (held to `RBAC.md` §12); members, invitations, teams, me, org
settings, slug change, usage; **`PLAN_LIMITS`** (held to `TENANCY.md` §8); **`PRIORITY_MATRIX`** and
**`DEFAULT_SLA_TARGETS`** (held to `DOMAIN.md` §3 and §4.1); the session cookie names; `suggestSlug`;
categories and SLA policies; **tickets** — strict create/update/assign/transition requests (a `priority`
anywhere is a `400`), the ticket with `availableActions` and `capabilities`, list views and the
`newest`/`oldest` sort, comments, watchers, and search (`q`, `type`, `status`, capped at 100).

### `apps/api` — 646 unit, 90 integration, 31 tenancy tests

M1's spine (tenancy context, crossings, resolution guard, sessions, identity, mail, throttling,
provisioning — see the module headers), the M1 modules below, and M2's:

- `src/tickets/` — **the transition table as data** (`domain/transitions.ts`: `checkTransition` and
  `availableActions`, Problem/Change tables empty until M4) and **the SLA clock as pure functions**
  (`domain/sla.ts`). `TicketsService`: create (quota, then policy, then the number **last**), versioned
  update (`409` stale-write; priority recomputed from the stored clock origin), assign, transition (the
  required public comment in the same transaction), list (one query per `scopeFor` branch, ANDed with
  the view, merged and de-duplicated — ADR-0025's `UNION ALL` in two passes), and **search** (a number
  short-circuit through the same scope, then `websearch_to_tsquery` ranked by `ts_rank`; the scope goes
  into one static statement as parameters). Comments filter internal notes in the query; a requester's
  public reply resumes a pending ticket. Watchers implicit and explicit. `GET /tickets/:id/audit`.
- `src/categories/` (pure tree in `domain/tree.ts`: subtree, ancestors, move planning, routing to the
  nearest ancestor's team) and `src/sla/` (eight policies per workspace, editable; open tickets keep
  their targets).
- `src/common/idempotency/` — `@Idempotent()`: Redis-backed, scoped by org, actor and route, on every
  entity-creating `POST`.

- `src/authz/` — **`PermissionService`**: `can` evaluates the contracts matrix against a `Subject` the
  caller loads, with no I/O (a lint zone forbids it); `assert` is 403, `assertVisible` 404;
  `permissionsFor` role-level; `scopeFor` returns branch-shaped filters. **`@RequirePermission`** is a
  global guard after auth. `route-coverage.spec.ts` walks the module graph and fails on an unmarked
  route. `pnpm test:authz` is its own CI step.
- `src/audit/` — `AuditService` writes in the change's transaction, attributed to member, service
  account or SYSTEM; partitions ensured at boot and daily; `GET /org/audit` (newest first, by actor,
  action, date).
- `src/memberships/` — **ADR-0033's lifecycle**: invitations (`<orgId-base36>.<secret>`, hashed, one
  pending per address, owners alone invite at admin+), acceptance in `acceptance/` (the one memberships
  folder allowed `runAsTenant`; signed in, or with a new verified account), members (role change,
  disable, enable, remove — every change locks the organization row, checks permission, then state, then
  the last-owner count, mirrors `UserOrgIndex`, audits, and bumps the epoch in the transaction),
  `GET /me`.
- `src/teams/` — CRUD (deactivate, never delete), membership managed by a lead for their own team or by
  an admin, one lead per team under a team row lock, epoch bumps on every change.
- `src/orgs/settings/` — `GET/PATCH /org/settings` (agent visibility gets its own audit action and
  invalidates the cached summary), the owner's `POST /org/slug` (both slugs locked, 30-day cooldown and
  redirect, session re-minted under the new cookie name), `GET /org/usage`.
- `src/orgs/repositories/slug-registry.repository.ts` — the one definition of "is this slug free".
- `src/quota/` — `QuotaService.consume/release` inside the counted change's transaction, one conditional
  update deciding the last unit; seats taken and freed across the membership lifecycle.
- `GET /auth/identity` for the picker.
- `test/tenancy/isolation.int-spec.ts` — **ENGINEERING.md's thirteen assertions, numbered**, against
  `seedLookalikes`; `pnpm test:tenancy` runs `test:schema` then the suite, its own step in CI.
- `test/support/workspace.ts` — `seedWorkspace` and `browser` for specs starting from people already in
  a workspace.

### `apps/app` — 36 tests

- `lib/routing.ts` — **the proxy's whole decision as a pure, table-tested function**; `proxy.ts` applies
  it. `app.` serves the tenant-less pages; a workspace host sends no-session browsers to login on `app.`
  with the way back, and expiring sessions through `/session/refresh` (ADR-0035).
- `lib/api/` — `serverApi` forwards only this workspace's access cookie and `pg_id`, names the tenant in
  `X-Patchgrid-Tenant`, redirects on 401, renders not-found on 403/404; `clientApi` refreshes once on a
  401 (one refresh shared by concurrent 401s) and retries once; `anonymous` calls get their 401 back.
- Pages: login, reset, verify-email, invite, picker, create workspace (pre-filled from the marketing
  signup), `/session/refresh`; the `(tenant)` layout with `TenantProvider` and the shell; admin
  settings — workspace, members and invitations, teams, **categories, SLA targets**, audit log.
- **Portal**: My tickets, *Raise a ticket* (impact and urgency asked in plain words, no priority field,
  one idempotency key per form), the ticket page.
- **Console**: `/queues` — assigned to me, my teams, unassigned, all open; status, order and search in the
  URL. Deadline badges count down to the target that matters now, tell a missed target from an overdue
  one, and say *Paused* while waiting on the requester.
- **One ticket page for every role** (`(portal)/tickets/[id]`): actions from `availableActions`, the
  reply box and internal notes from `capabilities`, the edit dialog limited to `editableFields`, the
  assignment control only with `canAssign`. A stale version reloads with a toast.
- `lib/` — `category-tree`, `duration` (`"1d 4h"` ↔ minutes), `relative-time`, `navigation.currentHref`,
  the labels for statuses, actions, impact and urgency.

### `apps/www` — 2 tests

Landing with the **working priority matrix** as its hero, pricing from `PLAN_LIMITS`, signup with the
live address check.

### `packages/ui`

The base-nova shadcn set the app uses: field, input, card, alert, badge, avatar, dialog, alert dialog,
dropdown menu, select, table, tabs, tooltip, skeleton, spinner, toaster.

### CI — `.github/workflows/ci.yml`

**verify** (lint, typecheck, test, build, then `test:authz`) · **database** · **schema** (safety → deploy →
catalog → tenant client → API integration → **tenancy suite** → drift) · **smoke** (now migrates before
booting) · **security**. Plus CodeQL and Dependabot.

---

## Decisions made in M2

| Decision | Where |
| --- | --- |
| Search SQL is a tagged `$queryRaw` in the ticket repository, like the row locks before it; ids ranked first, summaries then through the client in the same transaction | `ticket.repository.ts` |
| The GIN index is on `searchVector` alone; `orgId` is the query's other predicate. A composite GIN needs `btree_gin` | `ARCHITECTURE.md` (corrected) |
| A generated column and a partial index are declared in Prisma exactly as Postgres deparses them, or drift reports a change | `schema.prisma` |
| A ticket number that no visible ticket has falls through to full text — a bare `503` may be in a title | `TicketsService.search` |
| Lists sort by creation time only, either direction — the one order with an index | `ticketSortSchema` |
| `breached` on a summary is sticky (any target, ever); the UI shows it beside a live countdown rather than as "breached in 3 hours" | `due-badge.tsx` |
| One ticket page serves requesters and agents; nothing on it is decided by role on the client | `tickets/[id]` |
| Which actions take a note (`wait`, `resolve`, `cancel`) is a UI prompt only; whether one is required is the server's `400` | `ticket-detail.tsx` |
| Demo volume lives in a seed-only script; the isolation suite's lookalikes stay minimal | `scripts/demo-tickets.ts` |
| Integration specs use Redis database 1, so a running dev API cannot take their jobs | `test/support/env.ts` |

M0 and M1's decisions live in their ADRs and in the module headers they point to.

---

## Recommended next steps — M3

`FEATURES.md` §M3, in order: the `tenant-dispatch` dispatcher with per-tenant `sla-scan` and
`auto-close` behind `WORKER_MODE` (ADR-0018) — and with it the isolation suite's last clause; SLA
warnings and breaches with the split thresholds, notifying the assignee and the team lead; `Notification`
with `dedupeKey`, `GET /notifications`, the SSE stream namespaced `org:<orgId>` with fan-out through
`scopeFor()`; the bell and inbox; email for `DOMAIN.md` §8 events with per-membership preferences;
worker tests on fake timers; the maintenance jobs. The partial indexes `Ticket_open_resolveBy_idx` and
`Ticket_unresponded_respondBy_idx` already exist for the scan.

---

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **TM-1** attachment host is same-site | M5 | `files.` receives session cookies; needs its own registrable domain |
| **TM-2** platform actor resolved from the host | M8 | Same inversion ADR-0024 fixed for tenants |
| Unverified login re-sending the verification mail | any time | Today: the uniform 401 and nothing else |
| Per-member capabilities in the admin UI | any time | Member actions are offered by role; a `capabilities` block per member would let the UI hide what the API would refuse |
| Watchers and comment edit/delete in the UI | M3 | The API has both; the ticket page shows the thread but offers neither yet |
| Live updates on the ticket page | M3 | Today a page reflects other people's changes on the next navigation or a stale-write reload |
| `next-themes` inline-script warning under React 19.2 | any time | Dev-only console issue from the theme provider |
| Doc formatting drift | any time | Docs and API code are not Prettier-clean at 80 cols; commits skip the format hook. The apps are clean |

## Running it

```bash
cp .env.example .env
pnpm install
docker compose up -d && docker compose up minio-init
pnpm db:bootstrap && pnpm db:migrate && pnpm db:generate
pnpm db:doctor                   # 6/6
pnpm db:seed                     # acme + globex, 29 incidents each; every password "patchgrid-demo"
pnpm test:schema                 # 13
pnpm test:tenancy                # 13 + 27 (3 pointers, 1 todo)
pnpm test:authz
pnpm --filter @patchgrid/api run test:integration   # 90 — on Redis db 1, beside a dev API
pnpm dev                         # www :3000, app :3001, api :4000
```

`pnpm turbo lint typecheck test build` should be 22/22. Sign in at `http://app.lvh.me:3001` as
`dana@patchgrid.test` to see two workspaces; `rita@` is a requester at Acme, `sam@` an agent.

## Gotchas paid for in M2

- **English stemming keeps `printing` and `printer` apart.** A search spec that excluded "Printing toner"
  from a "printers" search was passing for the wrong reason; the excluded ticket must be one the query
  would otherwise match.
- **Prisma reads a generated column's expression as a default.** Declare it with
  `@default(dbgenerated("…"))` in Postgres's deparsed form (`'english'::regconfig`, `''::text`,
  `'A'::"char"`) or every drift check reports a change; Prisma never writes the column.
- **`prisma migrate dev` can hang** after creating a migration; kill it and apply with `migrate deploy`.
- **Two branches may constrain the same column.** The `teams` view and the no-team branch both name
  `teamId`; spreading them into one `where` let one replace the other. AND them.
- **A saved edit that changes nothing sends nothing** — a conflict test must change a field for real.
- **`TableCell` truncation needs a width.** The console table overflowed at laptop width until the title
  cell had a max width and the console dropped the *Updated* column.

Older gotchas are in the previous handoffs in git history and in the module headers where they bite.
