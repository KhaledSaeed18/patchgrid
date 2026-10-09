# Handoff — M1 complete, M2 next

Written 2026-10-09, at the M1 → M2 boundary. **This file is regenerated, not appended to** — at every
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

**M0 (Foundation) — complete** 2026-09-22. **M1 (Tenancy and identity) — complete** 2026-10-09: every
item checked, and the exit criterion walked in a real browser — a stranger signs up on the marketing
site, follows the verification link, creates the workspace they named at signup, invites an agent who
joins with a new account; the seeded Acme and Globex with Dana holding both open in two tabs; the
isolation and authorization suites green as CI gates.

**CI is green on `main`** — all five jobs. It had been red since 2026-10-05 behind three unrelated
causes, all fixed this session: gitleaks newly flagging the test JWT default (reviewed false positive in
`.gitleaksignore`), MinIO's public images disappearing (moved to Chainguard's build), and `pnpm audit`
finding a critical in Next 16.3.3 (moved to 16.3.8, transitive fixes pinned).

**Carried into M2:** the isolation suite's assertion 8 clause about the dispatcher fan-out (`it.todo`);
it lands with `tenant-dispatch`, the first per-tenant sweep.

---

## What is implemented

### Infrastructure

Postgres 17 + pgvector, Redis 7, MinIO (**Chainguard's `minio:latest-dev`**, non-root; its volume is
`object-data`), Mailpit. Two roles: `patchgrid_owner` (BYPASSRLS; migrations, tests) and `patchgrid_app`
(neither BYPASSRLS nor CREATE). Three databases: `patchgrid`, `patchgrid_test`, `patchgrid_shadow`.

### `packages/database` — 8 unit, 13 catalog, 15 integration tests

Three migrations: identity and tenancy; the **partitioned `AuditLog`** and the `REMOVED` membership
status; the **`UsageCounter`** quota table (backfilled with seats).

- **`AuditLog`** (ADR-0034): `PARTITION BY RANGE ("createdAt")`, key `(id, createdAt)`, no
  `(orgId, id)` unique (nothing references it). Every partition carries forced RLS and the template
  policy itself, because a query naming a partition is checked against the partition's policies.
  Partitions come from `ensure_audit_log_partition(timestamptz)`, a `SECURITY DEFINER` function the app
  role may execute — it never gains `CREATE`. No default partition.
- `src/lookalikes.ts` — **`seedLookalikes`**: Acme and Globex with the same team names, display names,
  roles and a same-address invitation, plus Dana (admin at Acme, agent at Globex). Used by `db:seed`
  (fixed slugs) and the isolation suite (a suffix per run).
- The catalog assertions exempt partitioned tables from the composite-target rule by catalog fact and
  assert nothing references them.

### `packages/contracts` — 158 tests

Beyond M0's primitives: the auth and identity shapes; **the permission catalog and matrix**
(`permissions.ts`, held cell by cell to `RBAC.md` §6 by a test that parses the document) with
`SCOPE_GRANTS`; the audit catalogue (held to `RBAC.md` §12); members, invitations, teams, me, org
settings, slug change, usage; **`PLAN_LIMITS`** (held to `TENANCY.md` §8); **`PRIORITY_MATRIX`** and
**`DEFAULT_SLA_TARGETS`** (held to `DOMAIN.md` §3 and §4.1); the session cookie names; `suggestSlug`.

### `apps/api` — 585 unit, 61 integration, 31 tenancy tests

M1's spine (tenancy context, crossings, resolution guard, sessions, identity, mail, throttling,
provisioning — see the module headers) plus, this session:

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

### `apps/app` — 28 tests

- `lib/routing.ts` — **the proxy's whole decision as a pure, table-tested function**; `proxy.ts` applies
  it. `app.` serves the tenant-less pages; a workspace host sends no-session browsers to login on `app.`
  with the way back, and expiring sessions through `/session/refresh` (ADR-0035).
- `lib/api/` — `serverApi` forwards only this workspace's access cookie and `pg_id`, names the tenant in
  `X-Patchgrid-Tenant`, redirects on 401, renders not-found on 403/404; `clientApi` refreshes once on a
  401 (one refresh shared by concurrent 401s) and retries once; `anonymous` calls get their 401 back.
- Pages: login, reset, verify-email, invite, picker, create workspace (pre-filled from the marketing
  signup), `/session/refresh`; the `(tenant)` layout with `TenantProvider` and the shell; admin
  settings — workspace, members and invitations, teams, audit log.

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

## Decisions made this session

| Decision | Where |
| --- | --- |
| Passwords 12–128, length only, never checked on login; reset links 30 min | ADR-0032 |
| `REMOVED` is terminal and keeps the row; memberships created at acceptance; inviting at admin+ needs an owner; a requester joins no team | ADR-0033 |
| Audit partitions carry their own forced RLS; a narrow security-definer function makes them; no default partition; detach only past the longest retention | ADR-0034 |
| The browser owns the refresh; the Next server never sees a refresh token | ADR-0035 |
| A seat is an active human at agent or above; point-in-time metrics use period `current` | `TENANCY.md` §8 |
| The authz core was built before membership, which needed its permissions | `FEATURES.md` |
| A workspace page whose data the role may not read is the not-found page | `lib/api/server.ts` |
| Member actions in the admin UI are offered by role-level permission; the API's refusal is shown | `members-admin.tsx` |

The M0/M1 decision table from the previous handoff still holds; its entries live in the ADRs and in the
module headers they point to.

---

## Recommended next steps — M2

`FEATURES.md` §M2, in order: the data (tickets, categories, SLA policies, comments, watchers — each with
policy, composite keys, coverage), then the ticket service with the transition table, then transitions
returning `availableActions` and `capabilities` (`PermissionService.capabilitiesFor` arrives here),
comments, watchers, `scopeFor` plumbed into the list queries as `UNION ALL`, search, the portal and
console, the seed's categories and incidents. Also due with M2:

- `tenant-dispatch` (the dispatcher) and the isolation suite's remaining clause.
- Provisioning seeds the default categories and the eight SLA policies from `DEFAULT_SLA_TARGETS`.
- The shared `Idempotency-Key` interceptor; `POST /orgs`, `/teams` and `/invitations` already send keys.
- `TICKETS_CREATED` consumed in the ticket-create transaction.

---

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **TM-1** attachment host is same-site | M5 | `files.` receives session cookies; needs its own registrable domain |
| **TM-2** platform actor resolved from the host | M8 | Same inversion ADR-0024 fixed for tenants |
| Unverified login re-sending the verification mail | any time | Today: the uniform 401 and nothing else |
| Per-member capabilities in the admin UI | M2 | Member actions are offered by role; a `capabilities` block per member would let the UI hide what the API would refuse |
| `next-themes` inline-script warning under React 19.2 | any time | Dev-only console issue from the theme provider |
| Doc formatting drift | any time | Docs and API code are not Prettier-clean at 80 cols; commits skip the format hook. The apps are clean |

## Running it

```bash
cp .env.example .env
pnpm install
docker compose up -d && docker compose up minio-init
pnpm db:bootstrap && pnpm db:migrate && pnpm db:generate
pnpm db:doctor                   # 6/6
pnpm db:seed                     # acme + globex; every password "patchgrid-demo"
pnpm test:schema                 # 13
pnpm test:tenancy                # 13 + 27 (3 pointers, 1 todo)
pnpm test:authz
pnpm --filter @patchgrid/api run test:integration   # 61 — with no other API process running
pnpm dev                         # www :3000, app :3001, api :4000
```

`pnpm turbo lint typecheck test build` should be 22/22. Sign in at `http://app.lvh.me:3001` as
`dana@patchgrid.test` to see two workspaces.

## Gotchas paid for this session

- **A running API steals the integration specs' mail.** It consumes the same Redis queues, so its worker
  takes the specs' jobs before their recording provider sees them. Stop any `pnpm dev` API first.
- **A constant imported into a server component from a `"use client"` module is a client reference,
  not its value.** Shared constants live in `lib/`.
- **`crypto.randomUUID` exists only in secure contexts**; development is plain http on lvh.me. Use
  `getRandomValues`.
- **Next 16 refuses dev assets to hosts outside `allowedDevOrigins`** — nothing hydrates on
  `*.lvh.me` without it — and the proxy matcher must exclude all of `/_next/` or HMR gets a 404.
- **Next's dev server writes `AGENTS.md`/`CLAUDE.md` into each app**; `agentRules: false` turns it off.
- **`request.nextUrl.origin` is normalised to localhost in dev**; build the way back from `Host`.
- **supertest binds a non-listening server per request and closes it after**, so concurrent requests
  could hit `ECONNREFUSED`. Specs call `app.listen(0)`.
- **A fake repository must return copies.** A service that reads its target after writing it saw its
  own write through a shared object and audited the wrong diff — in the fake only.
- **Prisma 7 introspects a partitioned parent as a plain model and hides its partitions**, so drift stays
  clean; the hand edit is `PARTITION BY RANGE` on the generated `CREATE TABLE`.
- **commitlint wants every subject lower-case**, including identifiers: `apiFetch`, `JWT`, `randomUUID`
  are all rejected.
- **The epoch's second-precision tie** means a session reopened in the same second as a bump is refused
  by design; specs step an injected clock instead of sleeping.

Older gotchas (Prisma 7, pnpm, Nest, BullMQ, throttler) are in the previous handoffs in git history and
in the module headers where they bite.
