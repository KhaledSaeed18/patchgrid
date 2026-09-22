# Handoff — end of M0, start of M1

Written 2026-09-22, at the milestone boundary. **This file is regenerated at each
boundary, not appended to** — if it disagrees with `FEATURES.md` or an ADR, they are
right and this is stale.

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

**M0 (Foundation) is complete** — 11/11 items, CI green on `main`, and the exit
criteria were verified rather than assumed: one `pnpm dev` serves all three hosts
simultaneously, and `/health/ready` reports database, redis and object-storage up.

**M1 (Tenancy and identity) has not started.** 27 open items in `FEATURES.md`.

Before M0, the entire specification was reviewed line by line across six rounds,
producing 23 findings where the plan described something that no longer exists or
never worked. All are folded into the docs, with dated **Erratum** blocks on the
nine affected ADRs. `docs/SPEC-REVIEW.md` is the audit trail.

---

## What is actually implemented

### Infrastructure — `docker-compose.yml`, `docker/`

Postgres 17 + pgvector, Redis 7, MinIO, Mailpit. All healthchecked, every published
port env-overridable. The Postgres init script creates **two roles**:
`patchgrid_owner` (holds `BYPASSRLS`, used for migrations and the test harness) and
`patchgrid_app` (holds neither `BYPASSRLS` nor `CREATE` on the schema).

### `packages/database`

Prisma **pinned to 7.10.0**. `prisma.config.ts` holds the connection strings and the
client takes a `@prisma/adapter-pg` driver adapter — Prisma 7 removed `url` from the
datasource block. `createPrismaClient()` and `assertAppRoleCannotBypassRls()`.

**The schema has no models yet.** That is M1's first real task.

Scripts: `db:bootstrap` (idempotent, the recovery path for an existing volume),
`db:doctor` (asserts six isolation invariants), `db:generate`, `db:migrate`,
`db:seed`, `db:reset`, `db:studio`.

### `packages/contracts` — 61 tests

ids, slugs + `RESERVED_SLUGS`, Problem Details registry, cursor pagination, ticket
number format/parse, limit constants. Zod-only dependency. `apps/www` renders its
problem pages from this registry, so adding a type here forces the site to explain
it or fail typecheck.

### `apps/api` — 40 tests

NestJS 11 (deliberately — `nestjs-zod` does not support Nest 12), CommonJS, SWC.
Zod-validated config that **refuses to boot** on a bad environment, including when
`DATABASE_URL == DATABASE_MIGRATION_URL`. A typed problem hierarchy services throw
instead of `HttpException`, rendered by one global filter. Slug-aware CORS as a pure
function with 30 tests. Liveness/readiness split. `Clock` and `Tracer` seams.
`@Public` / `@TenantOptional` markers. Boot assertion that the role cannot bypass RLS.

### `apps/app` — 2 tests

Five route groups — `(auth)`, `(select)`, `(portal)`, `(console)`, `(admin)` — with
placeholders naming the milestone each screen arrives in. The tenant-scoped groups
declare `force-dynamic` on the **layout**, so a page added below cannot silently
render one tenant's data into the build output.

### `apps/www` — 2 tests

Landing placeholder, plus 13 statically prerendered `/problems/*` pages so every
Problem Details `type` URI the API emits actually resolves.

### CI — `.github/workflows/ci.yml`

Four jobs, all green: **verify** (lint, typecheck, test, build) · **database**
(service container → bootstrap → doctor, run twice for idempotency) · **smoke** (the
whole Compose stack, API booted, readiness asserted) · **security** (gitleaks over
full history, `pnpm audit --audit-level=high`). Plus CodeQL and grouped Dependabot.

**Lint can fail.** `eslint-plugin-only-warn` was removed and `--max-warnings 0` set;
four architectural boundary rules live in `@patchgrid/eslint-config/boundaries` and
were each verified by planting a deliberate violation.

---

## What is deliberately NOT implemented

So the next session does not go looking for it:

- **No database models.** No `Organization`, no `User`, no `Membership`. M1.
- **No RLS policies.** The template is written in `TENANCY.md` §7 and proven by a
  throwaway spike, but no policy exists in a migration yet.
- **No authentication.** No login, no tokens, no cookies. M1.
- **No `runAsTenant` / `runAsPlatform`.** The ESLint rule restricting their import
  paths exists already, guarding code that has not been written.
- **No repositories, no services beyond health.** The layering rule is enforced by
  lint; there is nothing yet to layer.
- **`test:tenancy` and `test:authz` do not exist**, and are deliberately absent from
  CI rather than vacuously green.

---

## Decisions that constrain M1 — do not re-derive these

Each was expensive to reach. The ADR has the reasoning; this is the one-line version.

| Rule                                                                 | Why it is not negotiable                                                                                                                                                               | Source           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **The tenant comes from the credential, not the `Host`**             | `api.patchgrid.xyz` has no slug in its host. `Origin` / `X-Patchgrid-Tenant` is a cross-check, never the source                                                                        | ADR-0024         |
| **Composite `(orgId, id)` foreign keys between tenant-owned tables** | PostgreSQL runs referential-integrity checks with row security **off**. Verified: a single-column FK lets a correctly-tenanted row point at another tenant's row, and no layer objects | ADR-0023         |
| **People are referenced by `membershipId`, never `userId`**          | Makes "the assignee is a member of this org" a foreign-key constraint rather than an application check                                                                                 | ADR-0023         |
| **`patchgrid_app` never gets `BYPASSRLS`**                           | If something seems to need it, the answer is a projection table or `runAsTenant`                                                                                                       | ADR-0022         |
| **`runAsTenant` ≠ `runAsPlatform`**                                  | The first points the ordinary mechanism at a known org and is _not_ a bypass. The second has no tenant context and can only reach platform tables                                      | ADR-0022         |
| **Per-tenant session cookies** (`pg_at_<slug>`)                      | A single shared cookie makes two workspaces in two tabs fight each other — the exact drawback subdomains were chosen to avoid                                                          | ADR-0024         |
| **Revocation epoch in Redis**                                        | Without it, "revoke instantly" means "within 15 minutes"                                                                                                                               | ADR-0024         |
| **`scopeFor()` returns a list of branches, not one `where`**         | `OWN_TEAM_ONLY` is an `OR` across four columns that no single index serves                                                                                                             | ADR-0025         |
| **Await _inside_ the tenant context**                                | Prisma promises are lazy; `als.run(s, () => repo.find())` loses the context before the extension runs. Must be `als.run(s, async () => await fn())`. It fails closed, but it fails     | ADR-0015 erratum |
| **Every datetime is `@db.Timestamptz(3)`**                           | Prisma's default is naive `timestamp`, which would make every SLA comparison depend on the connection's zone                                                                           | ADR-0023         |

---

## Recommended next steps, in order

`FEATURES.md` M1 lists all 27 items. The first four are ordering constraints, not
preferences:

1. **Write the threat model** (`docs/THREAT-MODEL.md`) — assets, actors, trust
   boundaries, STRIDE per boundary. One page. It is first on the list on purpose:
   every P0 in the original review would have fallen out of drawing the boundaries
   once. Do it before the schema, not after.

2. **The schema**, with all of ADR-0023 applied from the first table:
   `Organization`, `OrganizationSlugHistory`, `User`, `Membership`, `TeamMembership`,
   `Team`, `Invitation`, `RefreshToken`, `PasswordResetToken`, `EmailVerification`,
   `PlatformAdmin`, plus the two projections `UserOrgIndex` and `ApiTokenIndex`.
   The exact field lists are in `ARCHITECTURE.md` §Data model.

3. **The five CI schema assertions, written alongside the first tenant-owned table** —
   RLS policy coverage, composite tenant foreign keys, `timestamptz`-only, `uuid`
   ids, `patchgrid_app` grants. Writing them now means the gate can never be
   retrofitted, and `.github/workflows/ci.yml` has a `TODO (M1)` block listing them.

4. **RLS**: the hand-written policy migrations from one template, the tenant Prisma
   client extension with CLS-aware nesting, `runAsTenant` / `runAsPlatform`.

Then auth, provisioning, membership, the `authz` module, `GET /me`, and the two test
suites that become CI gates.

**A working reference exists for step 4.** The isolation spike proved the whole
mechanism — policy template, extension shape, the batched
`$transaction([set_config, query])`, the lazy-promise trap. Its findings are in
`SPEC-REVIEW.md` §"Round 2 — isolation spike" and in the ADR-0015 / ADR-0023
**Verified** blocks. The code itself was thrown away, as a spike should be.

---

## Where to look

| Path                       | What it is                                                                      | Read it when                           |
| -------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| `CLAUDE.md`                | Agent conventions — the non-negotiable rules, condensed                         | **First, always**                      |
| `docs/PROJECT.md`          | What we are building and what we deliberately are not                           | Orienting                              |
| `docs/TENANCY.md`          | Isolation, sessions, provisioning, plans, jobs                                  | **All of M1**                          |
| `docs/RBAC.md`             | Actors, the catalog/matrix table, platform admin, support sessions, tokens      | **All of M1**                          |
| `docs/ARCHITECTURE.md`     | Stack, request pipeline, **the data model**, indexes                            | **Step 2**                             |
| `docs/ENGINEERING.md`      | Conventions, API rules, transactions, testing, CI, local dev                    | Constantly                             |
| `docs/DOMAIN.md`           | ITSM rules — state machines, priority, SLA                                      | M2 onward                              |
| `docs/DNS.md`              | Hostnames, wildcard TLS, mail DNS, custom domains                               | M10, but §2 explains tenant resolution |
| `docs/FEATURES.md`         | **The backlog.** Milestone by milestone, with exit criteria                     | Every session                          |
| `docs/decisions/README.md` | ADR index, with a reading order for newcomers at the bottom                     | When a rule seems arbitrary            |
| `docs/SPEC-REVIEW.md`      | The review audit trail — 23 findings across six rounds, plus what is still open | When something in the docs looks wrong |
| `docs/HANDOFF.md`          | This file                                                                       | At a milestone boundary                |

**The ADRs that matter most for M1**, in dependency order:
0013 (it is a SaaS) → 0014 (addressing) → 0015 (isolation) → **0023** (schema shape)
→ **0022** (crossing tenants) → **0024** (sessions) → 0017 (signup) → 0019 (RBAC) →
0025 (teams).

**Code worth reading before writing more:**

- `packages/database/scripts/doctor.ts` — the invariants, as executable assertions
- `packages/database/sql/bootstrap.sql` — roles, grants, and the `ALTER DEFAULT
PRIVILEGES` line everyone forgets
- `apps/api/src/config/env.schema.ts` — the boot-time refusal pattern
- `apps/api/src/common/problems/` — how services signal failure
- `apps/api/src/common/http/origin-policy.ts` — a security rule written as a pure,
  tested function rather than an inline regex
- `packages/eslint-config/boundaries.js` — the architectural rules, already guarding
  code that does not exist yet

---

## Running it

```bash
cp .env.example .env            # ports are overridable; 5432 is often already taken
pnpm install
docker compose up -d            # postgres, redis, minio, mailpit
pnpm db:bootstrap               # roles, grants, default privileges, extensions
pnpm db:generate                # Prisma client
pnpm db:doctor                  # asserts the above actually took effect — expect 6/6
pnpm dev                        # www :3000, app :3001, api :4000
```

`pnpm turbo lint typecheck test build` should be 20/20.

If `db:doctor` fails, read what it says — each check names the invariant it guards
and how to fix it. If a port is taken, override it in `.env` rather than editing
`docker-compose.yml`.

---

## Still open

Two items, neither blocking:

- **R-4** — `.vscode/` exists but is git-ignored. Decide: commit shared settings
  (reasonable for a portfolio repo) or delete it.
- **D-6** — ADR-0015 lists a `Plan` table that was never built. The closed
  platform-class list in `TENANCY.md` §7 omits it, so the schema is unambiguous; the
  ADR body is immutable and this is too minor for an erratum.

## Gotchas already paid for

Distilled from six review rounds — full detail in `SPEC-REVIEW.md`. These bit once
already; they do not need to bite again.

- `prisma@latest` resolves to an **8.0 release candidate**. Pin exactly.
- pnpm blocks postinstall scripts; anything needing one goes in `allowBuilds`.
- `pnpm --filter x <name>` resolves pnpm's **builtins** first — always use `run`.
- `docker.io/minio/minio` is not publicly pullable; the image comes from quay.io.
- MinIO CORS is a **server** setting, not a bucket one.
- `docker compose up --wait` treats a one-shot initialiser's clean exit as failure.
- A compiling package must not use `.ts` in its own relative imports; SWC preserves
  the extension and `dist/` then requires a file that does not exist.
- `import.meta` is unavailable in CommonJS output.
- Terminus signals a failed readiness check by **throwing a 503** carrying the
  per-indicator detail — a global `@Catch()` filter will swallow it into a 500.
- Testing Library's auto-cleanup only registers when Vitest globals are enabled.
- `exactOptionalPropertyTypes` has caught `undefined` being passed for an absent
  property three separate times. It is doing its job; do not turn it off.
