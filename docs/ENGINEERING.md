# Patchgrid — Engineering Conventions

How the code is written, tested, and shipped. `ARCHITECTURE.md` says what the pieces are; this says how we work on them.

## Repository hygiene

- **pnpm only.** `pnpm@10` pinned via `packageManager`. Never commit an npm/yarn lockfile.
- **Root scripts delegate with an explicit `run`**: `pnpm --filter <pkg> run <script>`. Without it, pnpm
  resolves its own builtins first — `pnpm --filter x doctor` invokes `pnpm doctor`, not the package's
  script, and fails with `Unknown option: 'recursive'`. The same trap waits on `test` and `start`.
- **Pin Prisma to an exact version, never `latest`.** As of 2026-09-22 Prisma's `latest` dist-tag points
  at `8.0.0-rc.15` — a *release candidate* — while the last stable is `7.10.0` (tagged `prev`). A plain
  `pnpm add prisma` installs the RC, and it can resolve to a different major than `@prisma/client`,
  which fails in confusing ways (`prisma validate` does not exist in the 8 RC). `prisma` and
  `@prisma/client` are pinned to the same exact version, upgraded deliberately.
- **pnpm blocks postinstall scripts by default.** Prisma's engines will not download until `prisma`,
  `@prisma/engines` and `esbuild` are listed under `allowBuilds` in `pnpm-workspace.yaml` — the same
  place `sharp` and `unrs-resolver` already are. Symptom without it: `ERR_PNPM_IGNORED_BUILDS`, then
  every Prisma command failing for an unrelated-looking reason.
- Package scope `@patchgrid/*`. Internal deps use `workspace:*`.
- Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:tenancy`, `test:authz`, `test:e2e`,
  `format`, `db:migrate`, `db:seed`, `db:studio`, `db:reset`, `platform:grant`. Every one runs through
  Turborepo where it makes sense.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`), scoped by package
  where useful: `feat(api): ticket state machine`. Enforced by `commitlint` on a `lefthook` commit-msg
  hook — a convention nothing checks is a suggestion.
- Repo furniture is part of the deliverable, not an afterthought: `LICENSE`, `SECURITY.md`,
  `CONTRIBUTING.md`, `CODEOWNERS`, a PR template, `.editorconfig`, `.nvmrc`. A portfolio repository is
  judged on these in the first ten seconds.
- **Every internal package is consumed as source** — `contracts`, `ui`, `database`, and the config
  packages — via `exports` pointing at `.ts`, with `transpilePackages` in Next and SWC in Nest.
  `database` was expected to be the exception, shipping built output because Prisma generation is a build
  step; it is not, because Prisma 7's `prisma-client` generator **emits TypeScript**. Generation is still
  a build step, so `typecheck`, `test` and `build` depend on a `generate` task — but the *output* is
  source like everything else.
- **Source-shipped packages emit nothing**, so the shared base sets `noEmit` and
  `allowImportingTsExtensions`. They carry explicit `.ts` extensions in their imports (NodeNext ESM
  requires them), which means every *consumer* must accept those extensions too — the price of the
  source-consumption decision, and it belongs in the base rather than being rediscovered per package.
- **A package that actually compiles must not use `.ts` in its own relative imports.** `apps/api` builds
  to CommonJS with SWC, and SWC preserves whatever extension it is given: a `.ts` import becomes
  `require("./x.ts")`, which does not exist in `dist/`. The app still needs the flag — it typechecks the
  source packages — but its own imports stay extensionless. The two rules coexist; the distinction is
  "does this package emit?", and it is the kind of thing that only surfaces the first time you run the
  built output.
- `apps/api` is **CommonJS**, Nest's best-supported output. Node 24's `require(esm)` lets it consume the
  ESM TypeScript workspace packages unchanged — verified, not assumed.
- One PR per milestone task, small enough to review in ten minutes. `main` is always green and always deployable-in-principle.
- `.env.example` is the authoritative list of env vars; `apps/api/src/config/env.ts` validates them with
  Zod at boot. Note that `.gitignore` carries `.env*` **and** a `!.env.example` negation — without the
  negation the authoritative list is itself ignored, which is easy to miss and annoying to diagnose.

## TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` in the shared base
  tsconfig. `exactOptionalPropertyTypes` fights Prisma's generated types (which emit `field?: T | null`)
  and will make you reach for a small `Exact`/`Prettify` helper in the repository layer. That is the cost
  of the flag, not a reason to turn it off — it is the flag that stops `{ assigneeMembershipId: undefined }` from
  silently meaning "clear the assignee".
- No `any`. Unknown input is `unknown` and gets narrowed (usually by a Zod schema).
- No non-null assertions (`!`) outside tests. Prefer narrowing or throwing a typed error.
- No enums in application code; use Zod enums / `as const` unions. Prisma-generated enums stay inside the repository layer.
- Domain types are inferred from Zod (`z.infer`), never hand-written twice.

## API conventions

- Base path `/api/v1` on `api.patchgrid.xyz`. Version bumps only on breaking wire changes (unlikely in v1).
- **The tenant is never a request parameter.** It comes from the credential and is cross-checked against
  `Origin` or `X-Patchgrid-Tenant` (`TENANCY.md` §6, ADR-0024). An endpoint that accepts an `orgId` in a
  body or query string is a bug — the only exceptions are the tenant-less auth/provisioning routes, which
  are marked `@TenantOptional` and reviewed as such.
- Resource-oriented routes; **state transitions are explicit sub-resources**, not `PATCH status`:
  `POST /tickets/:id/transitions { action: "resolve", comment: "..." }`. This keeps the state machine in
  one service method and makes the audit log trivial.
- Request bodies and query strings are validated by `nestjs-zod` using schemas from
  `@patchgrid/contracts`. Responses are parsed by the same schemas on the web side; the API additionally
  validates responses in development to catch drift early.
- Errors follow **RFC 9457 Problem Details** (`application/problem+json`):
  `{ type, title, status, detail, instance, errors? }`. `type` is
  `https://patchgrid.xyz/problems/<slug>`, and **those URLs resolve** — `apps/www` serves one short page
  per problem type, which costs an MDX file and turns every error into self-documenting output. A global
  exception filter maps: Zod → 400 with `errors[]`; not-authenticated → 401; not-permitted → 403;
  not-found → 404; invalid transition / uniqueness / stale write → 409; plan limit → 402; throttled →
  429; everything else → 500 with a correlation id and no internals.
- **Successful responses never carry advisory text.** There is no `warnings` channel. A soft block (such
  as starting a Change before its planned window) is a `409` that the client retries with
  `confirm: true` — which gives the UI a real dialog instead of a message nobody reads.
- **Entity-creating `POST`s accept an `Idempotency-Key` header.** The first response is stored in Redis
  under `idem:<orgId>:<key>` for 24 h and replayed on repeat. Without it, a double-clicked "Submit
  ticket" on a slow connection creates two incidents, two numbers, two SLA clocks and two notifications.
- **Mutations on `Ticket` and `KnowledgeArticle` carry a `version`.** A mismatch is `409` with
  `type: …/stale-write`, which the UI renders as "someone else changed this". `updatedAt` is not
  sufficient — millisecond collisions and clock skew are real.
- Lists are **cursor-paginated**: `?cursor=&limit=` (default 25, max 100) returning `{ items, nextCursor }`.
  The cursor is an opaque base64 of `(sortValue, id)` and every supported `sort` value has a matching
  index — a sort without an index is not a supported sort. Filters are flat query params
  (`?status=OPEN&teamId=…&priority=…`). **Full-text search is the one documented exception** and returns
  a ranked, capped result set rather than a cursor (`DOMAIN.md` §9.1).
- IDs are UUID v7 strings and are **not secrets**. Ticket `number` is for humans; every route uses `id`.
- Timestamps are ISO-8601 with an explicit UTC offset on the wire; columns are `timestamptz`
  (ADR-0023). The UI formats in the viewer's timezone.
- Status codes carry meaning the UI depends on: `401` not authenticated, `403` authenticated but not
  permitted (including tenant mismatch and suspended org), `402` blocked by a plan limit **and nothing
  else**, `404` unknown tenant or record — including records the actor may not see (`RBAC.md` §11),
  `409` invalid transition, uniqueness conflict or stale write.
- OpenAPI is generated from the Zod schemas (`nestjs-zod` + `@nestjs/swagger`) and served at `/api/docs`
  in non-production.
- **`/health` and `/health/ready` are outside the contract.** They sit outside the `/api/v1` prefix and
  are exempt from Problem Details: a failed readiness check is a `503` whose body names the indicator
  that is down, which is what an orchestrator reads. Rewriting that as a Problem Details `500` discards
  the detail and says "the app is broken" when the truth is "do not route here yet".
- **Liveness touches nothing external.** A dependency outage must never fail liveness, because that turns
  one outage into a crash loop. Readiness checks everything a request needs and, when it fails, removes
  the instance from rotation while leaving it running.

## Transactions and side effects

- A service method that mutates a ticket runs in one Prisma interactive transaction: the mutation + the
  `AuditLog` row(s) + any counter increment. The repository exposes a `withTransaction(fn)` helper;
  services never see the Prisma client, only the transaction-scoped repository set.
- **How nesting actually works**, because "wrap every query in a transaction" and "services open
  transactions" collide otherwise: CLS holds `{ orgId, tx? }`. `withTransaction` opens `$transaction`,
  immediately runs `SELECT set_config('app.current_org_id', $1, true)`, stores the transaction client in
  CLS, runs `fn`, then clears it. The `$allOperations` extension **checks CLS first**: if a transaction
  is already active it passes through untouched; only with no active transaction does it open its own.
  Prisma's transaction client does not expose `$transaction`, so an extension that wrapped
  unconditionally would throw at runtime.
- **Await inside the tenant context, never outside it.** Prisma model calls return *lazy*
  `PrismaPromise`s: the client extension's callback fires when the promise is **awaited**, not when the
  method is called. So `als.run({ orgId }, () => repo.findMany())` — a synchronous callback returning an
  un-awaited promise — exits the context the instant it returns, and the extension sees no tenant. The
  helper must be `als.run({ orgId }, async () => await fn())`. This is verified behaviour, not caution:
  it is the one thing the isolation spike got wrong on the first run, and it fails **closed** (the
  extension throws `NO_TENANT_CONTEXT`) rather than leaking — which is why the design survives the
  mistake. `nestjs-cls` wraps a whole request so the hazard does not arise there; it arises in
  `runAsTenant`, in job processors, and in tests.
- The `true` in `set_config` makes the setting transaction-local. It must never be "optimised" to
  session level — that breaks under connection pooling — and the code carries a comment pointing at
  ADR-0015. The fail-closed property is deliberate: outside a transaction the setting applies only to the
  current statement, so if the extension ever failed to open one, RLS would return zero rows rather than
  everything.
- **Raw SQL is banned outside `packages/database` and the hand-written policy migrations**, enforced by
  ESLint. Confirmed by spike: a raw query reaches the extension with `model === undefined`, so the
  tenant-model guard cannot fire and **layer 3 is genuinely skipped**. RLS still returns zero rows, so
  the failure is safe — but raw SQL is protected by one layer instead of two, which is the whole reason
  for the ban. The isolation suite asserts the zero-row result.
- **One logical read is one repository call is one transaction.** Because every query runs in its own
  transaction, an N+1 in a list endpoint becomes N transactions, each holding a pooled connection for a
  full round trip, each subject to Prisma's `maxWait`/`timeout`. List endpoints use `include`/`select`;
  per-row follow-up queries are a review-blocking defect, not a performance nit.
- **Invariants over a *set* of rows take a row lock, never read-then-write.** Owner counts, seat counts
  and monthly ticket counts take `SELECT … FROM "Organization" WHERE id = :orgId FOR UPDATE` inside the
  mutating transaction, or use a conditional `UPDATE … WHERE value < :limit RETURNING`. Two concurrent
  requests that each observe "not the last owner" are how an org ends up with zero owners.
- Anything with an external side effect (email, SSE push, triage, automation) is emitted as a **domain
  event after commit**. Events are typed objects in `apps/api/src/common/events`. Handlers that may fail
  or be slow enqueue BullMQ jobs; handlers that must be immediate and cheap (SSE push) run in-process.
- Jobs are idempotent and carry the ids they need, never full payloads that could go stale. Every job on
  a tenant-owned queue carries `orgId` and runs inside `runAsTenant(orgId)`; job ids are
  `<queue>:<orgId>:<entityId>:<discriminator>` (ADR-0018).
- `runAsTenant(orgId, fn)` and `runAsPlatform(fn)` are the only cross-tenant helpers (ADR-0022), and
  their import paths are restricted by ESLint to named modules rather than by a count of call sites.

## Schema changes

Every migration is **additive in the release that introduces it**, so `main` stays deployable and a
rollback never strands the database ahead of the code.

- Renames are add-column → backfill → dual-write → switch reads → drop, across at least two releases.
- `NOT NULL` is added as `CHECK (col IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT` once the
  backfill completes — never as a rewriting `SET NOT NULL` on a populated table.
- A migration that takes `ACCESS EXCLUSIVE` on a large table names the fact in a `-- lock:` comment and
  is reviewed for it. New indexes on populated tables are `CREATE INDEX CONCURRENTLY`, which means they
  live in their own migration with no transaction.
- **RLS policies, composite-key uniques, `CHECK` constraints, partitions and generated `tsvector` columns
  ship in the same migration as the table they protect.** A tenant-owned table without a policy cannot
  reach `main` — the coverage test fails first.
- CI fails a migration containing `DROP COLUMN` or `DROP TABLE` unless it carries a `-- safe:` annotation
  explaining which earlier release stopped reading it.

## Testing

| Level | Tool | Scope | Where |
| --- | --- | --- | --- |
| Unit | Vitest | pure services: priority matrix, transition table, SLA clock math, RBAC decisions, rule conditions. Repositories are replaced by in-memory fakes implementing the same interface | `apps/api/src/**/*.spec.ts` |
| Integration | Vitest + Supertest | Nest app booted against the real `patchgrid_test` Postgres (migrated + truncated per test file); covers controllers, guards, repositories, transactions, the Problem Details filter | `apps/api/test/**/*.int-spec.ts` |
| Contract | Vitest | every contract schema has round-trip examples; the web `apiFetch` is tested against recorded API responses | `packages/contracts`, `apps/app` |
| E2E | Playwright | signup → provisioning → invite → full ticket lifecycle in the browser, SLA breach with a shortened policy, Change approval, and a cross-tenant negative test | `apps/app/e2e` |
| Worker | Vitest | BullMQ processors with a fake clock (`vi.useFakeTimers`) | `apps/api/src/jobs` |
| **Tenancy** | Vitest + Supertest + raw SQL | the isolation suite — see below. Runs as its own `pnpm test:tenancy` target and blocks CI | `apps/api/test/tenancy/**` |
| **Authorization** | Vitest | the exhaustive permission matrix, scope filters, escalation negatives, and the route-coverage reflection test (`RBAC.md` §13) | `apps/api/src/authz`, `apps/api/test/authz/**` |

Rules:

- Every service method with branching logic gets a unit test **in the same PR**. No exceptions for
  "obvious" branches — transition tables and permission rules are where regressions hide.
- A new permission must appear in the catalog/matrix table, or the suite fails. A new controller route
  must assert a permission or be explicitly marked public, or the route-coverage test fails.
- Time is injected (`Clock` provider) so SLA tests never sleep.
- Test data comes from typed factories (`test/factories`), not hand-written JSON.
- **Integration tests get a database each.** Vitest runs test files in parallel, so a single shared
  `patchgrid_test` with truncate-between-files races nondeterministically — and the failures look exactly
  like isolation bugs, which is the worst possible false signal in this repo. Each worker clones a
  migrated template: `CREATE DATABASE patchgrid_test_w<N> TEMPLATE patchgrid_test_template`. Instant, and
  fully isolated.
- **The test harness connects as the owner role; the application under test connects as
  `patchgrid_app`.** `TRUNCATE` requires ownership, and `FORCE ROW LEVEL SECURITY` means ownership alone
  does not exempt the owner from policies — so both connection strings exist in tests too.
- **Shared enums are asserted at compile time.** A type-level test proves each Zod union and its Prisma
  enum are mutually assignable, so adding `KNOWN_ERROR` to one and forgetting the other fails
  `pnpm typecheck` — CI step 2, before any test runs.
- E2E and the full integration suite are written once a milestone's feature is functionally complete,
  not before.
- Coverage is reported, not gated. The gate is: tests exist for the rules in `DOMAIN.md`, `TENANCY.md`
  and `RBAC.md`.

### The tenancy isolation suite

Non-negotiable, and the most valuable tests in the repo. Two organizations (`acme`, `globex`) are seeded with deliberately similar data plus one user who is a member of both. The suite asserts:

1. Every list endpoint returns only the caller's org, for every role.
2. Fetching a known id belonging to the other org returns `404`, not `403` (no existence leak).
3. A token minted for org A, presented on org B's subdomain, returns `403`.
4. **RLS actually works**: a deliberately unscoped raw query, run on the app's connection with the other tenant's context set, returns zero rows — proving the database enforces isolation even when the repository does not.
5. `WITH CHECK` rejects writing a row with a foreign `orgId`.
6. A tenant-owned model queried with no tenant context throws rather than running unscoped.
7. Schema introspection enumerates every table classified tenant-owned and fails if it lacks `relrowsecurity`/`relforcerowsecurity` and a policy — so a new table without a policy cannot reach `main`.
8. Background jobs: a job whose payload lacks `orgId` on a tenant queue is rejected; the dispatcher fans out one job per active org and skips suspended ones.
9. Quota checks return `402` at the limit under **concurrency** — two simultaneous creates at the
   boundary cannot both succeed — and counters are per org.
10. **Every foreign key whose two endpoints are both tenant-owned is composite on `orgId`**, enumerated
    from `information_schema`. This is what makes a cross-tenant reference unrepresentable, and PostgreSQL
    runs referential-integrity checks with row security *disabled*, so without it the other layers do not
    see the violation (ADR-0023).
11. Physical-schema assertions: zero `timestamp without time zone` columns; every id column is `uuid`;
    `patchgrid_app` holds `SELECT` on every tenant-owned table (the missing-`GRANT` failure mode).
12. A raw query issued with no tenant context returns zero rows, and one issued with the GUC set to an
    empty string returns zero rows rather than raising.
13. Two browser sessions for the same user on two different tenants both keep working — the per-tenant
    cookie property (ADR-0024), exercised through the dual-member seed account.

## Local development

```bash
cp .env.example .env            # ports are overridable; 5432 is often already taken
pnpm install
docker compose up -d            # postgres, redis, minio, mailpit
pnpm db:bootstrap               # roles, grants, default privileges, extensions
pnpm db:doctor                  # asserts the above actually took effect
pnpm db:migrate && pnpm db:seed # schema + RLS policies + two demo orgs
pnpm dev                        # www :3000, app :3001, api :4000
```

`db:doctor` is not decoration: it asserts that the app role holds neither `BYPASSRLS` nor `CREATE` on
the schema, that `ALTER DEFAULT PRIVILEGES` is in place, that pgvector is installed and that the session
is UTC. Each is a way the isolation model fails *silently* if it drifts, and each is far cheaper to
learn about at setup time than from a confusing error three hours later.

`db:reset` runs `prisma migrate reset` **then** `db:bootstrap` — in that order, because resetting drops
and recreates the `public` schema, taking the ownership and default privileges with it.

Local URLs use **`lvh.me`**, a public domain whose wildcard DNS resolves to `127.0.0.1`, so tenant
subdomains and shared cookies behave exactly as in production with no `/etc/hosts` editing (ADR-0014):

| Surface | URL |
| --- | --- |
| Marketing | `http://lvh.me:3000` |
| Org picker / login | `http://app.lvh.me:3001` |
| Tenant workspace | `http://acme.lvh.me:3001`, `http://globex.lvh.me:3001` |
| API | `http://api.lvh.me:4000` (docs at `/api/docs`) |
| Mailpit | `http://localhost:8025` |
| MinIO console | `http://localhost:9001` |

Cookies are issued for `Domain=.lvh.me` in development, per tenant (`pg_at_acme`, `pg_at_globex`) so two
workspaces can be open at once (ADR-0024).

`lvh.me` is a third-party domain on the critical path — it has lapsed before — so there are three tiers,
in order of preference:

1. **`lvh.me`** (default). Prettiest; `sslip.io` and `nip.io` are equivalents.
2. **`*.localhost`** — Chrome and Firefox resolve it to loopback natively, so `acme.localhost:3001` and
   `api.localhost:4000` work with **zero** external dependency and no `/etc/hosts` edit. Cookies on
   `Domain=.localhost` are accepted by Chrome and Firefox; Safari is the holdout.
3. **`/etc/hosts` + `patchgrid.test`** — works offline and in Safari. Add
   `127.0.0.1 patchgrid.test app.patchgrid.test api.patchgrid.test acme.patchgrid.test globex.patchgrid.test`
   and set `COOKIE_DOMAIN=.patchgrid.test`. `.test` is reserved by RFC 6761 for exactly this, which is why
   it is used rather than `.local` (which collides with mDNS).

**Seeded data** (dev only, passwords printed by the seed script): two organizations, `acme` and `globex`, with deliberately similar tickets, teams and categories; `owner@acme.test`, `admin@acme.test`, `agent@acme.test`, `lead@acme.test`, `user@acme.test`, the equivalents for `globex`, and `both@acme.test` who is an Admin in `acme` and a Requester in `globex`. That last account is how org switching and isolation get exercised by hand.

`pnpm db:reset` drops, re-migrates (including RLS policies) and re-seeds. The seed is idempotent and is the same script that will reset the public demo nightly later.

The database init script creates two roles: the migration owner (which **does** hold `BYPASSRLS`, so
data migrations and the test harness can operate — `FORCE ROW LEVEL SECURITY` means ownership alone does
not exempt it), and `patchgrid_app` (no `BYPASSRLS`, no table ownership) which the application uses.
`DATABASE_URL` points at `patchgrid_app`; `DATABASE_MIGRATION_URL` at the owner. The config validator
refuses to start if they are the same, and the API asserts at boot that its own role lacks `BYPASSRLS`.

The same script issues the grants the app depends on — including the line people forget:

```sql
GRANT USAGE ON SCHEMA public TO patchgrid_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO patchgrid_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO patchgrid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE patchgrid_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO patchgrid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE patchgrid_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO patchgrid_app;
```

Grants apply only to objects that exist when they are issued, so without `ALTER DEFAULT PRIVILEGES` every
future migration ships a table the application cannot read — and only in whichever environment ran the
migration. Compose init scripts run **only against an empty volume**, so the same SQL ships as an
idempotent file executed by `db:migrate`, and the tenancy suite asserts the privilege for every
tenant-owned table.

## CI (GitHub Actions)

On every PR and on `main`:

1. `pnpm install --frozen-lockfile`
2. `turbo lint typecheck` — includes the compile-time Zod↔Prisma enum assertions
3. `turbo test` — unit + contract tests, no services needed
4. Integration tests against `postgres` + `redis` service containers, with both database roles created
   exactly as locally
5. `pnpm test:tenancy` and `pnpm test:authz` — isolation and authorization suites, treated as release
   gates, not optional extras
6. **Schema assertions** as their own job so a failure names the actual problem: RLS policy coverage,
   composite tenant foreign keys, `timestamptz`-only, `uuid` ids, `patchgrid_app` grants
7. `turbo build` — all three apps
8. `prisma migrate diff` to fail on schema/migration drift; migration-safety check (`DROP` without a
   `-- safe:` annotation fails)
9. **Security**: `gitleaks` secret scan, `pnpm audit --audit-level=high`, CodeQL for JS/TS
10. (later) Playwright E2E against the built apps, on `main` only; Docker image builds

Node version comes from `.nvmrc`/`engines` (pinned to 24.x). Dependabot for weekly grouped updates.

## Logging and observability

- `nestjs-pino`: one structured line per request with `reqId`, method, route, status, duration,
  `userId`, `membershipId`, `orgId`, `orgSlug`, and the transaction count for the request. `orgId` on
  every line is what makes "which tenant is slow / erroring" answerable; the transaction count is what
  catches an N+1 before it exhausts the connection pool (§Transactions).
- Domain events of interest (transition, SLA warning/breach, rule executed, triage result) are logged at
  `info` with ids only.
- **No PII in logs** — never emails, ticket bodies or tokens. Failed logins log `emailHash8`, a truncated
  SHA-256, so abuse is still correlatable without storing the address.
- `GET /health` (liveness) and `GET /health/ready` (Postgres, Redis, MinIO reachability) via
  `@nestjs/terminus`, in the first milestone — not deferred.
- **The instrumentation seam exists from M0**, even though the implementation is later: a `Tracer`
  provider with a no-op implementation, injected wherever a span would start. Retrofitting OpenTelemetry
  through 200 files is the reason most projects never add it. The real implementation, per-tenant metrics
  and the local collector are an M9 item with their own ADR.
- No error-tracking SaaS in the local stage; the Problem Details filter logs every 5xx with its
  correlation id.

## Frontend conventions

- Applies to `apps/app`; `apps/www` additionally owns the SEO surface (metadata, OG images, sitemap, robots, JSON-LD) and must never render tenant data or be built with tenant-specific output.
- Server components by default; `"use client"` only for interactivity. Data enters through `apiFetch` (server) or TanStack Query hooks in `apps/app/lib/queries/` (client) — components never call `fetch` directly.
- URL is the source of truth for list state (filters, sort, cursor, selected ticket) so views are shareable — and because the host already identifies the tenant, a shared link works for any colleague in the same workspace.
- Role-dependent UI reads the permission list from `GET /me` via `TenantProvider`, never from a re-derived role check. Hiding a button is a convenience; the API is the authority (ADR-0019).
- Forms use `react-hook-form` + the contract schema; server validation errors from Problem Details are mapped back onto fields.
- Accessibility is not optional: shadcn primitives, visible focus, keyboard-operable tables, `aria-live` for the SLA countdown.
- Ticket lists and the SLA countdown render relative times client-side with a stable server-rendered fallback to avoid hydration mismatches.

## Documentation

- Any change to a rule in `DOMAIN.md`/`TENANCY.md` or a boundary in `ARCHITECTURE.md` ships in the same PR as the code.
- A new non-obvious decision gets an ADR (`docs/decisions/NNNN-title.md`) using the template in
  `0000-template.md`. **The Context, Options, Decision and Consequences sections are never edited after
  acceptance** — a changed mind is a new ADR. The Status line *is* updated, to record supersession, and
  `decisions/README.md` is updated in the same PR.
- The root `README.md` is portfolio-facing: what it is, screenshots, architecture diagram, "why these decisions" linking to ADRs, how to run locally. It is written in the final milestone but kept honest as features land.
