# Handoff — M1 in progress

Written 2026-10-09, mid-M1. **This file is regenerated, not appended to** — at every milestone boundary,
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
items, **8 are done, 19 are open**. CI is green on `main` — five jobs.

| M1 item                                   | State                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Threat model                              | **Done** — `docs/THREAT-MODEL.md`; three of its five findings decided in ADR-0031 |
| Data (the 13 identity and tenancy tables) | **Done** — one migration, with its catalog assertions as a CI gate      |
| RLS                                       | **Done** (2026-10-05) — policies, client extension, the request context in the API, `PrismaService.db` / `transaction()`, `runAsTenant` / `runAsPlatform`, the lint zones, and a live-RLS integration suite in CI |
| Tenant resolution                         | **Done** (2026-10-05) — first global guard; credential locator, Redis-cached lookup, decision table, public `GET /tenants/:slug`; proven over HTTP |
| Auth                                      | **Done** (2026-10-05) — sessions (login, `pg_id`, switcher, refresh + reuse detection, logout, epoch, auth + CSRF guards, `Actor`) and identity (signup `202`, verification link starting the session, resend, reset, change), both proven through the booted app |
| Mail                                      | **Done** (2026-10-05) — `MailProvider` + SMTP, four React templates, the `mail` queue, the processor in tenant context, `WORKER_MODE`; Mailpit round trip |
| Throttling                                | **Done** (2026-10-05) — per address and per email hash before resolution, per org after; Redis Lua counter, fail-open; `429` Problem with `Retry-After` |
| Org provisioning                          | **Done** (2026-10-05) — `POST /orgs` in one transaction inside `runAsTenant`, the advisory slug lock, public `GET /orgs/slug-available`; the two-creator race proven through the booted app |
| Everything else                           | Open — see `FEATURES.md` §M1                                            |

Also since the last handoff: the API's lint boundaries were found to be **silently inert** — flat config
lets a later `no-restricted-imports` object replace an earlier one's options — and were rebuilt as zones
of one custom rule, each proven by a planted violation.

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

### `packages/contracts` — 75 tests

M0 primitives (ids, slugs + `RESERVED_SLUGS`, Problem Details registry, pagination, ticket numbers,
limits), plus M1's tenancy enums in `tenancy.ts`: role, membership status and kind, organization status,
plan, agent visibility. `auth.ts` holds the identity shapes and the password bounds (ADR-0032);
`organizations.ts` the workspace creation request and response and the slug-availability answer,
whose `reason` is compile-time tied to `SlugRejection`.

### `apps/api` — 216 unit, 43 integration tests

M0's NestJS 11 skeleton (Zod config that refuses to boot, Problem Details filter, slug-aware CORS,
health, `Clock`/`Tracer`, `@Public`/`@TenantOptional`, RLS boot assertion), plus
`enum-parity.spec.ts`: each contracts enum and its Prisma twin must be identical, **enforced by
`typecheck`**. M1 added the tenancy spine; there are still no domain modules.

- `src/tenancy/` — **isolation layer 1.** `TenancyModule` mounts the `nestjs-cls` middleware on every
  route, keyed by pino's request id. `request-context.ts` is the typed store: `tenant: { orgId,
  inTransaction }`, extended by other modules through declaration merging. `TenantContextService` is the
  read side — `current()`, `requireOrgId()`, `organization()`, `requestId()` — and **has no setter**.
- `src/tenancy/` — **tenant resolution (pipeline step 4)**, as the first global guard
  (`tenant-resolution.guard.ts`): `credential-locator.ts` parses `Authorization`, the access cookie
  named by the asserted slug (`Origin` or `X-Patchgrid-Tenant`) and peeks its `org` claim unverified;
  `tenant-resolver.ts` is the decision table (bearer → cookie → state; 404 / 401 / 403 exactly as
  ADR-0024 assigns them); `organization-lookup.service.ts` is a 60 s Redis read-through with negative
  caching and fall-through on outage; `tenants.controller.ts` serves public `GET /tenants/:slug`.
  `@Public` and `@TenantOptional` routes skip the guard. Everything is proven over HTTP with supertest
  against a probe controller, with the real pipe and filter in place.
- `src/platform/repositories/` — the first repositories: `OrganizationRepository` (summary by id /
  slug, retired slugs) and `ApiTokenIndexRepository` (prefix → org), both platform class and read with
  no tenant. `PlatformModule` exports them; `CommonModule` (global) now provides `Clock` and `Tracer`.
- `src/auth/` — **pipeline step 7 and sessions** (ADR-0004, ADR-0024, ADR-0031). `tokens/` signs and
  verifies the HS256 access token through `jose` with an injected clock, and holds the one definition of
  `pg_at_<slug>` / `pg_rt_<slug>` / `pg_id` and the claims (`peekOrgClaim` reads without verifying, for
  resolution). `passwords/` is Argon2id with a dummy-hash timing equaliser. `revocation/` is the Redis
  epoch, `null` on outage. `sessions/session.service.ts` is login (one 401, one Argon2id cost, whether
  the address exists), `pg_id` as a `RefreshToken` with no org, the org switcher re-reading `Membership`
  inside `runAsTenant`, refresh with rotation and chain revocation on reuse, logout and
  logout-everywhere. `auth.guard.ts` (third global guard) verifies the cookie the resolved slug names,
  refuses another org's claim with 403, applies the epoch (reads proceed, writes 503 when Redis is
  down) and re-reads the membership inside the tenant; `requested-with.guard.ts` (second) refuses
  cookie-borne mutations without `X-Requested-With: patchgrid`. `actor.ts` is the `Actor` and the
  read-only `ActorService`. `auth.controller.ts`: `POST /auth/login|sessions|refresh|logout`.
  `identity/identity.service.ts` is signup (`202` always, the password hashed on both paths so the time
  does not differ; a verified address gets `account-exists`, an unverified one gets the link again and
  keeps its first password), `verifyEmail` (burns the token, marks verified, hands the account to
  `startIdentity`), resend, `requestPasswordReset` (verified accounts only, thirty-minute token) and
  `confirmPasswordReset` / `changePassword` (set, mark verified, `revokeEverywhere`).
  `identity.controller.ts`: `POST /auth/signup|verify-email|resend-verification|password-reset|
  password-reset/confirm|password`. One-time tokens are 256-bit secrets stored as SHA-256 in
  `EmailVerification` / `PasswordResetToken` through `one-time-token.repository.ts`; issuing voids the
  ones outstanding.
- `src/orgs/` — **workspace provisioning** (ADR-0017, TENANCY.md §4). `provisioning.service.ts` mints
  the org id with UUID v7 *before* anything exists, so the whole creation runs inside `runAsTenant` on
  it — the first write through a crossing. It refuses an unverified or anonymised account (`401`),
  invalidates the org lookup cache for the new slug, and opens the new workspace's session through
  `SessionService.open`. `organization-provisioning.repository.ts` is the transaction: a
  `pg_advisory_xact_lock(hashtext('slug:<slug>'))`, then the current-and-retired check, then
  `Organization`, the `OWNER` membership, the `UserOrgIndex` row and the three default teams.
  `orgs.controller.ts`: `POST /orgs` (`@TenantOptional`, `201` with cookies) and public
  `GET /orgs/slug-available` (30/min per address), which answers "not a slug" as `available: false`
  with the reason, never a 400.
- `test/orgs/provisioning.int-spec.ts` — the slug check including a retired slug, creation and the
  session working on the new tenant, `409` for taken and retired slugs, and two simultaneous creators
  of one slug ending with exactly one workspace.
- `src/memberships/repositories/membership.repository.ts` — the first tenant-owned repository: explicit
  `orgId` on every method, the team facts the actor carries.
- `src/throttling/` — **pipeline steps 3 and 6.** `throttlers.ts` names the limits: `ip` 300/min
  (tightened by `@Throttle` to 20 on the session routes, 10 on the identity routes, 30 on slug lookup),
  `email` 5/min per email hash on any route whose body names an address, `org` 600/min. One throttler
  guard runs at one point in the chain, so `throttler.guards.ts` has two: `IpThrottlerGuard` (first
  of all, `ip` + `email`) and `OrgThrottlerGuard` (right after resolution, in `TenancyModule`). Both
  throw `RateLimitedProblem` with a plain `Retry-After`. `redis-throttler.storage.ts` is a fixed-window
  Lua counter on the existing ioredis client that fails open with a log line. `SkipAllThrottling()` is
  on health; `THROTTLE_ENABLED=false` is set only by the integration specs' env.
- `src/jobs/` — the BullMQ root (`JobsModule`, connection parsed from `REDIS_URL` by
  `redis-connection.ts`; completed jobs dropped, failed ones kept), `job-id.ts`
  (`queue:org:entity:discriminator`, `platform` for no org) and `dispatcher/run-job.ts`, the processor
  wrapper that opens the tenant context a job names — the one place in the jobs tree allowed to run
  with none (ADR-0022). `src/common/urls.ts` (`PublicUrls`) is the one definition of app, workspace and
  marketing links in development and production.
- `src/mail/` — `mail-provider.ts` (the port), `providers/smtp-mail.provider.ts` (nodemailer → Mailpit)
  and `recording-mail.provider.ts` (tests); `templates/` — verify-email, account-exists, invite,
  reset-password as React elements in one table-layout frame, a Zod registry (`mailJobSchema`) that
  validates payloads on dequeue and admits only http(s) links, `renderMail` → subject, html, text;
  `mail.service.ts` enqueues (never sends — ADR-0031's timing) under an idempotent per-tenant id;
  `mail.processor.ts` renders and sends inside `runJob`, unrecoverable on an unreadable payload,
  retried with backoff on a provider failure, running only when `WORKER_MODE` is `all` or `worker`.
- `test/mail/smtp-mail.provider.int-spec.ts` — through SMTP to a real Mailpit, found via its API;
  skipped, and says so, without `MAILPIT_URL`.
- `test/auth/identity-lifecycle.int-spec.ts` — signup → link (read back from a recording mail provider,
  through the real queue and worker) → verify → login → reset → change, through the booted app.
- `test/auth/session-lifecycle.int-spec.ts` — the booted `AppModule` against Postgres and Redis, driven
  over HTTP like a browser: CSRF on login, identical 401s, cookies, a member actor on a tenant route,
  the acme session refused on globex, rotation and chain revocation, a disabled member out on the next
  request, logout everywhere leaving no live token and refusing the still-unexpired access token.
- `src/prisma/prisma.service.ts` — **layer 3 in the API.** Wraps the client in `withTenantIsolation`,
  fed from the context at await time. Repositories read **`db`**: the open transaction when one was
  opened **for the current tenant**, else the extended client. `transaction(fn)` opens an interactive
  transaction whose first statement sets the tenant, stores `{ orgId, client }` in a child context for
  the duration, joins an already-open one instead of nesting, and runs platform-only with no tenant.
- `src/platform/run-as-tenant.ts`, `run-as-platform.ts` — the two crossings (ADR-0022), as plain
  functions on the shared CLS instance. Each runs its callback in a child context that hides the
  caller's tenant and open transaction, restores them on return, validates the id, and logs `{ actor,
  reason, from, orgId }`.
- The request logger now carries `orgId` on the completion line, read from the context.
- `test/tenancy/tenant-scope.int-spec.ts` (`test:integration`, CI `schema` job) — the above against
  live RLS as `patchgrid_app`: no context throws; a crossing sees only its org with no `where`; a
  crossing *inside* an open transaction runs outside it, scoped to the other org, and the outer
  transaction resumes with its uncommitted work; a foreign `orgId` rolls the whole transaction back.
- `test/platform/organization.repository.int-spec.ts` — the platform repositories read as
  `patchgrid_app` with an empty context, including a retired slug inside and outside its window.

### `packages/eslint-config` — 1 test (27 cases)

`rules/import-zones.js` is a custom rule: one options object, many zones, each with `files`, `except`
and forbidden `imports` (by package name or regex). `boundaries.js` exports `apiBoundaries` — layering,
the two crossings with their *different* allow-lists, and `nestjs-cls` confined to `src/tenancy`,
`src/prisma`, `src/platform` — and `noRawSql`. `boundaries.test.js` proves every zone with the violation
it names and the module allowed to make it.

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

- **No per-token throttling.** The `org` throttler covers a workspace; per API token (step 6's other
  half) arrives with the M8 api-tokens item, where tokens first authenticate.
- **No invitation mail is enqueued yet.** The `invite` template exists; the membership item sends it.
- **No Resend provider.** `MAIL_PROVIDER` is bound to SMTP everywhere; the production implementation is
  an M10 deploy concern, selected by env when it exists.
- **API tokens resolve but do not authenticate.** A `pg_` bearer whose prefix is in `ApiTokenIndex`
  reaches the auth guard and gets a deliberate 401 until the M8 api-tokens item (`ApiToken` table,
  Argon2id verification inside `runAsTenant`, scope ∩ role).
- **No tenant-bound routes yet.** The auth guard is proven against probe controllers; the first real
  one (`GET /me`) arrives with the authz item.
- **No seed data.** `scripts/seed.ts` is still a stub; the two lookalike orgs arrive with the seed item,
  which can now call provisioning instead of writing rows by hand.
- **No `provision-org` job and only teams as defaults.** Categories, SLA policies and KB articles join
  the provisioning transaction with their M2 tables; the job arrives when something is slow enough to
  need it.
- **No `Idempotency-Key` on `POST /orgs`.** A retried create with the same slug gets `409`, which is
  safe but unfriendly; the shared idempotency interceptor is an M2 concern, where ticket creation
  needs it, and `POST /orgs` adopts it then.
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
| **The context is written in four places only** — tenancy, prisma, platform, auth | `TenantContextService` and `ActorService` have no setters and `nestjs-cls` imports nowhere else, so pointing a query at another tenant means going through a confined helper | `boundaries.js` |
| **`db` hands out a transaction only for the tenant it was opened for**  | A `runAsTenant` inside an open transaction must never reuse it; the getter checks, whether or not the helper cleared the slot | `prisma.service.ts` |
| **Boundaries are zones of one rule**                                   | Flat config replaces, not merges, options for the same rule across objects; separate objects guarded only the last one | `ENGINEERING.md` §CI |
| **Step 4 is a guard, not middleware**                                  | Exemption is by route decorator, which middleware cannot see; guards run inside the CLS context anyway | `ARCHITECTURE.md` §Request pipeline |
| **"Not a slug" is the same 404 as "no such slug"**                      | A 400 for a malformed label tells a prober which labels to skip                                        | `tenant-lookup.service.ts` |
| **A cookie for another tenant is never a fallback**                     | The asserted slug picks `pg_at_<slug>`; nothing else is read (ADR-0024 §2)                            | `credential-locator.ts` |
| **Epoch ties go to the revocation**                                     | `iat` is seconds; a token minted in the bump's second must not survive "log out everywhere"           | `revocation-epoch.service.ts` |
| **The auth guard re-reads `Membership` per request**                    | Team facts for the actor, and a disabled member is out on the next request even with Redis down      | `auth.guard.ts` |
| **`X-Requested-With: patchgrid` on every cookie-borne mutation, login included** | Subdomains are same-site; login CSRF logs a victim into the attacker's account (ADR-0024 §4)     | `requested-with.guard.ts` |
| **Password policy is length-only, 12–128**                               | NIST 800-63B; not applied to login attempts, where "too short" is an oracle on the policy | ADR-0032 |
| **Login never says why**                                                | Unknown, wrong password, unverified and anonymised are one 401 at one Argon2id cost (ADR-0031)         | `session.service.ts` |
| **Mail is enqueued, never sent inline**                                 | The anonymous endpoints must take the same time whether or not the address exists (ADR-0031)           | `mail.service.ts` |
| **A mail payload carries its finished URL, token included**             | The token row stores only a hash, so the link cannot be rebuilt later; completed jobs are removed from Redis, and this is the one accepted secret in a job | `templates/index.tsx` |
| **Processors never import the crossing helpers**                        | `runJob` in `src/jobs/dispatcher` opens the context; a processor says which tenant, not how            | `run-job.ts` |
| **Mail templates are plain React, not `@react-email/components`**       | npm marks the widget set unsupported; `@react-email/render` over plain elements gives the same HTML   | `templates/` |
| **Signup hashes the password on both paths**                            | The response is `202` either way; the time taken must be too (ADR-0031)                                | `identity.service.ts` |
| **A second signup for an unverified address keeps the first password**  | Nobody has proved they own the address; the first claimant's password stands until a verified owner resets it | `identity.service.ts` |
| **Reset links live thirty minutes; verification links twenty-four hours** | A reset link replaces the password; a verification link only proves an address | ADR-0032 |
| **Following a reset link also verifies the address**                    | A link delivered to the inbox proves control of it — the same reasoning ADR-0031 applies to invitations | `identity.service.ts` |
| **Job id parts are joined with `/`**                                    | BullMQ reserves `:` and refuses a custom id containing one (ADR-0018 erratum)                          | `job-id.ts` |
| **Rate limiting fails open**                                            | Defence in depth; taking the API down with Redis is the worse failure, and the epoch already decides what fails closed | `redis-throttler.storage.ts` |
| **Two throttler guards, one per pipeline point**                        | One guard runs at one point, and per-org limits need the org resolution produces                       | `throttler.guards.ts` |
| **The per-email limit tracks the hash, never the address**              | No PII in Redis keys any more than in logs (ADR-0031 names the limit; ENGINEERING.md the rule)         | `throttlers.ts` |
| **The new org's id is minted before its row exists**                    | So provisioning runs inside `runAsTenant` and writes tenant-owned rows under RLS like any request      | `provisioning.service.ts` |
| **Slug uniqueness is decided under an advisory lock on the slug**       | "Never reuse" spans `Organization` and `OrganizationSlugHistory`; no constraint holds it. Slug change must take the same lock key | `organization-provisioning.repository.ts` |
| **Unverified accounts create no workspace**                             | Stricter than FEATURES.md's "one per unverified user": nobody has proved the address yet               | `provisioning.service.ts` |
| **The slug check never 400s**                                           | "Not a slug" is `available: false` with the reason, so the form can say why                            | `orgs.controller.ts` |

---

## Recommended next steps, in order

1. **Membership** (`src/memberships/`) — invite (sending the `invite` template, the token
   `<orgId-base36>.<secret>`), accept (bound to the invited address, ADR-0031), disable, remove, change
   role, last-owner protection under a row lock, epoch bumps on every change. Tenant-owned repositories
   follow `MembershipRepository`: read `prisma.db`, take an explicit `orgId`, never open `$transaction`
   themselves. Accepting an invite writes `UserOrgIndex` in the same transaction, as provisioning does.
2. Then teams, `authz`, `GET /me`, and the `test:tenancy` / `test:authz` gates.
3. Decide whether an unverified account's login attempt should re-send the verification mail (today:
   the uniform 401 and nothing else), and settle the refresh-cookie question below before `apiFetch`.

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
| `docs/decisions/README.md`    | ADR index (32) and the reading order                                          | When a rule seems arbitrary            |
| `docs/SPEC-REVIEW.md`         | The pre-M0 review audit trail                                                | When something looks wrong             |

**ADRs that matter most for the rest of M1**, in dependency order:
0015 → **0023** → **0022** → **0024** → **0031** → 0017 → 0019 → 0025.

**Code worth reading before writing more:**

- `apps/api/src/auth/sessions/session.service.ts` — every session rule in one place; the shape a service takes here
- `apps/api/src/auth/auth.guard.ts` — what a verified request looks like by the time a handler runs
- `apps/api/test/auth/session-lifecycle.int-spec.ts` — how to boot the real app in a test and drive it
- `apps/api/src/tenancy/tenant-resolver.ts` — the decision table auth sits behind; what `via` means
- `apps/api/src/tenancy/tenant-resolution.guard.spec.ts` — how a guard is proven over HTTP here
- `apps/api/src/prisma/prisma.service.ts` — `db` and `transaction()`; how a repository will see the client
- `apps/api/src/platform/run-as-tenant.ts` — the shape of a crossing, and why it validates and logs
- `apps/api/test/tenancy/tenant-scope.int-spec.ts` — what "isolated" is proven to mean in the API
- `packages/database/src/tenant-client.ts` — layer 3, the extension underneath
- `packages/database/test/schema.test.ts` — what every new table must satisfy
- `packages/database/prisma/migrations/*/migration.sql` — the tail shows how a policy ships
- `packages/eslint-config/boundaries.js` — the zones the next modules must fit inside

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
pnpm --filter @patchgrid/api run test:integration        # expect 43/43 (needs Redis; Mailpit for one)
pnpm dev                        # www :3000, app :3001, api :4000
```

`pnpm turbo lint typecheck test build` should be 22/22.

An `.env` from before M1 lacks `DATABASE_SHADOW_URL` — copy that line from `.env.example` (adjust the
port) and re-run `pnpm db:bootstrap` to create the shadow database.

---

## Still open

| Item                                                  | Needed by | Notes                                                                                                   |
| ----------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| **TM-1** attachment host is same-site                 | M5        | `files.patchgrid.xyz` receives session cookies; needs a separate registrable domain (`THREAT-MODEL.md`)  |
| **TM-2** platform actor resolved from the host        | M8        | Same inversion ADR-0024 fixed for tenants; needs its own credential                                     |
| **Refresh cookie vs server-side refresh**             | M1 auth   | `pg_rt_<slug>` is `Path=/api/v1/auth`, so the Next server never receives it and `apiFetch`'s server-side refresh-and-retry cannot work as written. Decide before building `apiFetch` |
| **Slug reuse race**                                   | M1 slug change | Provisioning takes `pg_advisory_xact_lock(hashtext('slug:<slug>'))`; the slug-change endpoint (admin UI item) must take the same key for both the old and the new slug |
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
  far skip it with `LEFTHOOK_EXCLUDE=format`; commitlint still runs. commitlint also wants a
  **lower-case subject** — `add runAsTenant` is rejected, `add the two tenant crossing helpers` is not.
- **Flat config replaces rule options across objects.** Two config objects that both set
  `no-restricted-imports` (or `no-restricted-syntax`) for overlapping files do not merge — the later one
  wins, and the earlier boundary is gone without a warning. Put every boundary in one rule.
- **minimatch's `**` does not match `..`.** A glob written to catch `../../platform/run-as-tenant`
  catches nothing; use a regex for relative imports.
- **vitest cannot print a Prisma client proxy.** `expect(prisma.db).toBe(tx)` reports a `TypeError`
  from the proxy's `ownKeys` trap when it fails, not the mismatch. Compare identities as booleans:
  `expect(prisma.db === tx).toBe(true)`.
- **A crossing inside an open transaction needs a second connection.** The transaction holds one for its
  duration; `runAsTenant` inside it queries on another. A pool capped at one deadlocks until Prisma's
  transaction timeout.
- **`ClsService.set(key, undefined)` is how a child context hides a parent value** — `inherit` copies the
  store shallowly, so deleting is not an option, and a missing key would fall through to the parent's.
- **The global Zod pipe refuses a bare `@Param("x") x: string`.** `strictSchemaDeclaration` throws
  `ZodSchemaDeclarationException` — a 500 — for any argument no DTO declares. Every param, query and
  body is a `createZodDto` class, even a one-field one. The unit specs did not catch it because the
  probe controller had no params; the boot-and-curl did.
- **`AppModule` is not global.** A provider declared there (`CLOCK` was) is invisible to sibling
  modules and fails at boot with "can't resolve dependencies". Shared seams live in `CommonModule`.
- **Boot the built API and curl it before committing a module.** DI resolution and the strict pipe
  only fail at runtime; the unit and HTTP specs with hand-assembled TestingModules pass right through.
  Better still: the lifecycle spec boots the real `AppModule`, so a DI mistake fails `test:integration`.
- **curl's cookie jar is domain-scoped.** Cookies set for `Domain=.lvh.me` are not sent back to
  `localhost:4000`; drive the API at `http://api.lvh.me:4000` or every authenticated step is a 401 that
  looks like a bug.
- **`@node-rs/argon2`'s `Algorithm` is an ambient const enum**, unusable at runtime under
  `isolatedModules`; Argon2id is the value 2, and the spec asserts the produced hash says `$argon2id$`.
- **A TestingModule that imports `AppModule` does not see its modules' exports.** A probe controller
  injecting `ActorService` needs `AuthModule` imported into the test module too.
- **The Nest SWC builder compiles `.ts` only.** A `.tsx` template is silently absent from `dist/` and
  the app fails at boot with `MODULE_NOT_FOUND`; `nest-cli.json` sets the builder's `extensions`.
  vitest's `unplugin-swc` handled `.tsx` without being told.
- **`@nestjs/bullmq` creates the worker after `onModuleInit`.** A processor that wants to start itself
  (`autorun: false`) does it in `onApplicationBootstrap`, or `this.worker` is undefined.
- **Spec files are compiled into `dist/`.** Harmless today; excluding `**/*.spec.ts` from the build is
  a small cleanup waiting for a quiet moment.
- **BullMQ refuses a custom job id containing `:`** — its own key separator. The unit specs with a fake
  queue passed; the first real enqueue through the booted app threw. Another reason the full-stack
  specs exist.
- **`@SkipThrottle()` with no argument skips only a throttler named `default`.** Ours are named, so the
  bare decorator skipped nothing; `SkipAllThrottling()` names them all. Likewise the base guard's header
  is `Retry-After-<name>`, not `Retry-After`; the plain one is set by hand.
- **`@nestjs/throttler` does not export its storage record type from the root.** Derive it:
  `Awaited<ReturnType<ThrottlerStorage["increment"]>>`.
