# Handoff — M1 in progress

Written 2026-09-24, mid-M1. **This file is regenerated, not appended to** — at every milestone boundary,
and whenever enough has landed that the previous version would mislead. If it disagrees with
`FEATURES.md` or an ADR, they are right and this is stale.

Read this first, then `CLAUDE.md`, then the documents it points at.

---

## What Patchgrid is

A **multi-tenant SaaS ITSM platform** — ticketing and operations for IT and security
teams. Not a general project-management tool: it models four ITIL record types
(Incident, Service Request, Problem, Change) with four different lifecycles, and
priority is _computed_ from impact × urgency rather than typed into a dropdown.

It is a learning and portfolio project, built as though it were production: the
interesting part is the architecture, not the CRUD. Three deployables, tenants
addressed by subdomain, tenant data isolated at the database level.

| Host                   | App        | What it is                                       |
| ---------------------- | ---------- | ------------------------------------------------ |
| `patchgrid.xyz`        | `apps/www` | Marketing, docs, signup entry                    |
| `<slug>.patchgrid.xyz` | `apps/app` | A tenant's workspace — the product               |
| `app.patchgrid.xyz`    | `apps/app` | Tenant-less: login, org picker, create workspace |
| `api.patchgrid.xyz`    | `apps/api` | NestJS — all business logic and data access      |

Locally: `lvh.me:3000`, `<slug>.lvh.me:3001`, `api.lvh.me:4000`.

---

## Where we are

**M0 (Foundation) is complete** (2026-09-22). **M1 (Tenancy and identity) is in progress**: of its 27
items, **2 are done, 1 is in progress, 24 are open**. CI is green on `main` — five jobs.

| M1 item                                   | State                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Threat model                              | **Done** — `docs/THREAT-MODEL.md`; three of its five findings decided in ADR-0031 |
| Data (the 13 identity and tenancy tables) | **Done** — one migration, with its catalog assertions as a CI gate      |
| RLS                                       | **In progress** — policies, template and client extension done; `nestjs-cls` context, `runAsTenant` / `runAsPlatform` remain |
| Everything else                           | Open — see `FEATURES.md` §M1                                            |

Between M0 and the M1 work, the shared UI package took the tweakcn "Tangerine" theme (colour tokens,
Open Sans / Source Serif 4 / JetBrains Mono through one `next/font` module, 0.2rem radius) for both
frontends.

---

## What is actually implemented

### Infrastructure — `docker-compose.yml`, `docker/`

Postgres 17 + pgvector, Redis 7, MinIO, Mailpit. All healthchecked, every published port
env-overridable. The Postgres init script (and `pnpm db:bootstrap`, which shares its SQL) creates
**two roles** — `patchgrid_owner` (holds `BYPASSRLS`; migrations and test harness) and `patchgrid_app`
(neither `BYPASSRLS` nor `CREATE`) — and **three databases**: `patchgrid`, `patchgrid_test`, and
`patchgrid_shadow`, a scratch database Prisma wipes while diffing. The owner has no `CREATEDB`; it is
given a database to own instead of the privilege.

### `packages/database` — 8 unit, 12 catalog, 9 integration tests

Prisma **pinned to 7.10.0**, `prisma-client` generator, `@prisma/adapter-pg`, `partialIndexes` preview.

- **Schema** (`prisma/schema.prisma`, one migration `…_identity_and_tenancy`). Platform class:
  `Organization`, `OrganizationSlugHistory`, `User`, `PlatformAdmin`, `RefreshToken`,
  `PasswordResetToken`, `EmailVerification`, and the projections `UserOrgIndex` / `ApiTokenIndex`.
  Tenant-owned: `Membership`, `Team`, `TeamMembership`, `Invitation` — each with `orgId`, `@@unique([orgId,
  id])`, composite `(orgId, …)` foreign keys between them, and the template RLS policy.
- **Hand-written SQL** at the end of that migration: the four policies, and `CHECK`s for slug format,
  lower-cased emails and domains, and `Membership` kind ↔ `userId`.
- `src/table-classes.ts` — **the closed platform list**. Any table not on it is tenant-owned by default.
- `src/rls.ts` — **the one policy template**; `pnpm --filter @patchgrid/database run policy <Table>`
  prints the SQL to append to a new table's migration.
- `src/tenant-client.ts` — **isolation layer 3**. `withTenantIsolation(client, readContext)` sets
  `app.current_org_id` transaction-locally before every tenant-owned query, throws
  `NoTenantContextError` with no context, and passes platform models through. `tenantTransaction(db,
  orgId, fn)` scopes an interactive transaction; inside it (context `inTransaction`) the extension
  passes through instead of nesting.
- `test/schema.test.ts` (`pnpm test:schema`) — the five catalog assertions: RLS enabled + forced with
  exactly the template policy; composite tenant FKs plus an `orgId` anchor to `Organization`; zero naive
  timestamps; `uuid` ids; full DML grants to `patchgrid_app` and no ownership by it.
- `test/tenant-client.int.test.ts` (`test:integration`) — the extension with RLS live underneath, on a
  one-connection pool so a leaked setting would be seen.
- `scripts/migration-safety.ts` (`migrations:check`) — no `DROP TABLE`/`COLUMN` without a `-- safe:`
  annotation. `migrations:drift` — the migrations must reproduce `schema.prisma` exactly.

Every one of these gates was **proven by planting the defect it guards against** and watching it fail.

### `packages/contracts` — 61 tests

M0 primitives (ids, slugs + `RESERVED_SLUGS`, Problem Details registry, pagination, ticket numbers,
limits), plus M1's tenancy enums in `tenancy.ts`: role, membership status and kind, organization status,
plan, agent visibility.

### `apps/api` — 46 tests

M0's NestJS 11 skeleton (Zod config that refuses to boot, Problem Details filter, slug-aware CORS,
health, `Clock`/`Tracer`, `@Public`/`@TenantOptional`, RLS boot assertion), plus
`enum-parity.spec.ts`: each contracts enum and its Prisma twin must be identical, **enforced by
`typecheck`**. There are still no modules beyond health.

### `apps/app`, `apps/www`, `packages/ui` — 2 + 2 tests

Route-group placeholders and the `/problems/*` pages from M0, now on the shared Tangerine theme:
`packages/ui/src/styles/globals.css` holds every token; `packages/ui/src/lib/fonts.ts` is the one
font definition both layouts use.

### CI — `.github/workflows/ci.yml`

**verify** (lint, typecheck, test, build) · **database** (bootstrap → doctor, twice) · **schema**
(migration safety → migrate deploy → catalog assertions → tenant client → drift) · **smoke** (full
Compose stack, API readiness) · **security** (gitleaks, `pnpm audit`). Plus CodeQL and Dependabot.

---

## What is deliberately NOT implemented yet

- **No tenant context in the API.** `nestjs-cls` is not installed; nothing calls `withTenantIsolation`
  outside its tests. `runAsTenant` / `runAsPlatform` do not exist — the ESLint rule restricting their
  imports is still guarding code that has not been written.
- **No authentication.** No login, tokens, cookies, Argon2id. ADR-0031 has settled its shape.
- **No repositories or services** beyond health, so nothing yet exercises the layering lint rules.
- **No seed data.** `scripts/seed.ts` is still a stub; the two lookalike orgs arrive with provisioning.
- **`test:tenancy` and `test:authz` do not exist**, and stay absent from CI rather than vacuously green.
  The database-level isolation assertions they will include are already proven in `test:integration`.
- Tables from later M1 items — `UsageCounter`, `AuditLog`, `ApiToken`, `SupportSession` — are not in
  the schema. Each lands with the item that needs it.

---

## Decisions that constrain the rest of M1 — do not re-derive these

The M0 table still holds — credential carries the tenant (ADR-0024), composite tenant FKs (ADR-0023),
people by `membershipId`, no `BYPASSRLS` for the app, `runAsTenant` ≠ `runAsPlatform` (ADR-0022),
per-tenant cookies and the Redis revocation epoch (ADR-0024), branch-shaped `scopeFor()` (ADR-0025),
await inside the tenant context, `timestamptz` everywhere. Added since:

| Rule                                                                   | Why                                                                                                   | Source       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| **An invitation binds to its email**                                   | A forwarded `ADMIN` invite must not admit whoever clicks it                                           | ADR-0031     |
| **Anonymous identity endpoints answer uniformly** — status, body, timing | "Does this person use Patchgrid?" is reconnaissance. So signup cannot start a session: the verification link does | ADR-0031 |
| **`pg_id` is a `RefreshToken` row with `orgId = NULL`**                | It can mint a session for every workspace; it must rotate and be revocable. Minting re-reads `Membership`, never `UserOrgIndex` | ADR-0031 |
| **Tenant-owned is the default**                                        | A table is covered by every isolation check unless deliberately added to the platform list           | `table-classes.ts` |
| **Policies go at the end of the `migration.sql` that creates the table** | Prisma only runs `migration.sql`; a separate `rls.sql` would never execute                           | `ARCHITECTURE.md` |
| **Partial unique indexes are modelled in Prisma**, never hand-written  | A hand-written one looks like drift and is dropped by the next generated migration                    | `schema.prisma` |
| **Optional composite relations are `onDelete: Restrict`**              | The default `SET NULL` on `(orgId, teamId)` would null `orgId` too                                     | `schema.prisma` |
| **`RefreshToken.orgId` cascades on delete**                            | `SET NULL` would turn a tenant refresh token into an org-less one — a `pg_id`                          | `schema.prisma` |
| **Random 256-bit tokens are hashed with SHA-256**, looked up by hash   | Argon2id is for low-entropy secrets: passwords, and API tokens looked up by prefix                     | `schema.prisma` |
| **`Membership.userId` is null exactly for service accounts**           | An API token's actor has no human account (ADR-0021); a `CHECK` enforces it                           | migration    |

---

## Recommended next steps, in order

1. **Finish RLS** — the only in-progress item. Install `nestjs-cls`; feed `withTenantIsolation` from it
   (`{ orgId, inTransaction }`); write `runAsTenant(orgId, fn)` and `runAsPlatform(fn)` in the paths the
   ESLint rule already allows, each logging actor, reason and target. Keep "await inside the context".
2. **Tenant resolution middleware** — credential → org, `Origin` / `X-Patchgrid-Tenant` cross-check,
   Redis-cached lookup, slug-history 302s, suspended / pending-deletion handling (ADR-0024).
3. **Auth** — with ADR-0031 applied from the first endpoint: uniform responses, the dummy-hash timing
   equaliser, invite–email binding, `pg_id` as a rotating `RefreshToken`.
4. Then provisioning (with the slug lock below), membership, teams, `authz`, `GET /me`, and the
   `test:tenancy` / `test:authz` gates.

---

## Where to look

| Path                          | What it is                                                                   | Read it when                           |
| ----------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| `CLAUDE.md`                   | Agent conventions — the non-negotiable rules, condensed                      | **First, always**                      |
| `docs/THREAT-MODEL.md`        | Assets, actors, boundaries, STRIDE; accepted risks; open findings            | **Before any auth or tenancy code**    |
| `docs/TENANCY.md`             | Isolation, sessions, provisioning, plans, jobs — now with ADR-0031's rules   | **All of M1**                          |
| `docs/RBAC.md`                | Actors, the catalog/matrix table, platform admin, support sessions, tokens   | **All of M1**                          |
| `docs/ARCHITECTURE.md`        | Stack, request pipeline, the data model, how policies ship                   | Schema work                            |
| `docs/ENGINEERING.md`         | Conventions, transactions, testing, CI, local dev                            | Constantly                             |
| `docs/DOMAIN.md`              | ITSM rules — state machines, priority, SLA                                   | M2 onward                              |
| `docs/DNS.md`                 | Hostnames, wildcard TLS, mail DNS                                            | M10; §2 explains tenant resolution     |
| `docs/FEATURES.md`            | **The backlog**, with per-item progress notes                                | Every session                          |
| `docs/decisions/README.md`    | ADR index (31) and the reading order                                          | When a rule seems arbitrary            |
| `docs/SPEC-REVIEW.md`         | The pre-M0 review audit trail                                                | When something looks wrong             |

**ADRs that matter most for the rest of M1**, in dependency order:
0015 → **0023** → **0022** → **0024** → **0031** → 0017 → 0019 → 0025.

**Code worth reading before writing more:**

- `packages/database/src/tenant-client.ts` — layer 3, and the contract `runAsTenant` must honour
- `packages/database/test/tenant-client.int.test.ts` — what "isolated" is proven to mean
- `packages/database/test/schema.test.ts` — what every new table must satisfy
- `packages/database/prisma/migrations/*/migration.sql` — the tail shows how a policy ships
- `packages/eslint-config/boundaries.js` — the rules the next step must fit inside

---

## Running it

```bash
cp .env.example .env            # ports are overridable; 5432 is often already taken
pnpm install
docker compose up -d            # postgres, redis, minio, mailpit
pnpm db:bootstrap               # roles, grants, the three databases, extensions
pnpm db:migrate                 # applies migrations (needs DATABASE_SHADOW_URL)
pnpm db:generate                # Prisma client — migrate dev no longer does this in Prisma 7
pnpm db:doctor                  # expect 6/6
pnpm test:schema                # expect 12/12
pnpm --filter @patchgrid/database run test:integration   # expect 9/9
pnpm dev                        # www :3000, app :3001, api :4000
```

`pnpm turbo lint typecheck test build` should be 21/21.

An `.env` from before M1 lacks `DATABASE_SHADOW_URL` — copy that line from `.env.example` (adjust the
port) and re-run `pnpm db:bootstrap` to create the shadow database.

---

## Still open

| Item                                                  | Needed by | Notes                                                                                                   |
| ----------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| **TM-1** attachment host is same-site                 | M5        | `files.patchgrid.xyz` receives session cookies; needs a separate registrable domain (`THREAT-MODEL.md`)  |
| **TM-2** platform actor resolved from the host        | M8        | Same inversion ADR-0024 fixed for tenants; needs its own credential                                     |
| **Refresh cookie vs server-side refresh**             | M1 auth   | `pg_rt_<slug>` is `Path=/api/v1/auth`, so the Next server never receives it and `apiFetch`'s server-side refresh-and-retry cannot work as written. Decide before building `apiFetch` |
| **Slug reuse race**                                   | M1 provisioning | Retired slugs live in another table, so "never reuse" is not a constraint. Provisioning and slug change must take a lock on the slug |
| **Doc formatting drift**                              | any time  | The docs and most code are not Prettier-clean at `printWidth: 80`; the pre-commit hook would reformat whole files. Either one formatting commit or a `.prettierrc` that matches the house style |
| R-4 `.vscode/` git-ignored                            | —         | Commit shared settings or delete                                                                        |
| D-6 ADR-0015 mentions a `Plan` table never built      | —         | Too minor for an erratum                                                                                |

## Gotchas already paid for

From M0 (full detail in `SPEC-REVIEW.md`): `prisma@latest` is an 8.0 RC — pin exactly · pnpm blocks
postinstall outside `allowBuilds` · `pnpm --filter x <name>` hits builtins; use `run` · MinIO is on
quay.io and its CORS is a server setting · `compose up --wait` fails on a one-shot initialiser · no `.ts`
extensions in a compiling package's own imports · no `import.meta` in CommonJS · Terminus signals failure
by throwing a 503 · Testing Library cleanup needs Vitest globals · `exactOptionalPropertyTypes` stays on.

From M1 so far:

- **Prisma 7's `migrate dev` does not regenerate the client.** Run `pnpm db:generate` after it.
- **Prisma refuses `migrate reset` when an AI agent runs it.** Reverse test-database changes by hand.
- **Prisma's default for an optional relation is `ON DELETE SET NULL`** — wrong for composite keys and
  for anything whose `NULL` means something else. Read every generated FK.
- **A turbo task's `"dependsOn": ["generate"]` means the package's own `generate`.** A consumer needs
  `"^generate"` as well, or its tests race the generator on a clean checkout (it broke CI once).
- **`next/font` in a shared package** needs `next` as a peer dependency and `Bundler` module resolution
  in that package's tsconfig: `next` ships no `exports` map, so `NodeNext` cannot see `next/font/google`.
- **The desktop app's browser pane blocks every `/_next/*` request on `lvh.me`** (`ERR_BLOCKED_BY_CLIENT`),
  so pages render unstyled there. Use `localhost` in the pane, or a real browser. Tenant subdomains need
  a real browser once host parsing lands.
- **commitlint allows only these scopes**: api, app, www, db, contracts, ui, ts, lint, config, deps, ci,
  docs, agents, test, security. A rejected commit leaves its files staged for the next one.
- **The pre-commit hook's Prettier step reformats whole files** (see "Doc formatting drift"). Commits so
  far skip it with `LEFTHOOK_EXCLUDE=format`; commitlint still runs.
