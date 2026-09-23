# Patchgrid — Agent Conventions

Start with `docs/HANDOFF.md` — it is the state of play at the current milestone boundary: what is built, what is deliberately not, and what comes next. Then read `docs/PROJECT.md`, `docs/TENANCY.md`, `docs/RBAC.md`, `docs/DOMAIN.md`, `docs/ARCHITECTURE.md`, `docs/ENGINEERING.md`, `docs/DNS.md`, `docs/FEATURES.md` and `docs/THREAT-MODEL.md` if you haven't loaded them this session. They are the working spec. Reasoning lives in `docs/decisions/`; start with the reading order at the bottom of `docs/decisions/README.md`. Don't re-derive or contradict any of it without flagging it first.

Patchgrid is a **multi-tenant SaaS**: three deployables (`apps/www` marketing, `apps/app` tenant workspace, `apps/api` NestJS), tenants addressed by subdomain, tenant data isolated by Postgres RLS **and** by a schema shape in which a cross-tenant reference cannot be expressed.

## Non-negotiable rules

### Tenancy (the ones that matter most — a mistake here leaks another company's data)

- **The tenant comes from the credential, not from user input and not from the `Host`.** The access token or API token carries `orgId`; `Origin` (or `X-Patchgrid-Tenant` server-side) is a cross-check, not the source. `api.patchgrid.xyz` has no slug in its host — anything that tries to parse one is wrong (ADR-0024). No endpoint accepts `orgId` in a body or query string. Tenant-less routes are explicitly marked `@TenantOptional`.
- **Every tenant-owned table has `orgId`, an RLS policy, `@@unique([orgId, id])`, and `orgId`-first indexes.** A new tenant-owned model is incomplete until its policy migration and its entry in the schema-coverage test exist.
- **Every foreign key between two tenant-owned tables is composite on `orgId`** — `references: [orgId, id]`, never a bare id. PostgreSQL runs referential-integrity checks with row security _disabled_, so a single-column FK lets a correctly-tenanted row point at another tenant's row and no layer objects (ADR-0023).
- **Rows reference people by `membershipId`, never `userId`** — except `Notification.userId` (delivery) and platform-class tables. This is what makes "the assignee is a member of this org" a constraint rather than a hope.
- **Every repository method for a tenant-owned model takes an explicit `orgId`** and filters on it — even though RLS would also catch it. Defense in depth is the design, not redundancy to optimise away.
- **Never bypass tenant scope.** `runAsTenant(orgId, fn)` points the ordinary mechanism at a known org and is _not_ a bypass; `runAsPlatform(fn)` runs with no tenant context and can therefore only reach platform-class tables. Import paths are restricted by module (ADR-0022) — check the ESLint rule, don't count call sites.
- **The app role never gets `BYPASSRLS`.** If something seems to need it, the answer is a projection table or `runAsTenant`, not a privilege.
- **Never make `set_config('app.current_org_id', …)` session-level.** It must stay transaction-local (`true`), or pooled connections leak tenants.
- **No raw SQL outside `packages/database`** and the hand-written policy migrations. Raw queries may skip the Prisma client extension entirely.
- **Every background job on a tenant queue carries `orgId`** and runs inside `runAsTenant`. Sweeps are dispatcher → per-tenant jobs, never one global scan.
- **Roles live on `Membership`, never on `User`.** Resolve permissions against the caller's membership for the current org.
- Uniqueness is per-org for ticket numbers, team names, asset serials and KB slugs. **Category names are unique per _parent_** — a real taxonomy has `Hardware → Other` and `Software → Other`. Only `User.email` and `Organization.slug` are globally unique.

### Authorization (`docs/RBAC.md`)

- **Deny by default.** Every controller route either asserts a permission in its service or is explicitly `@Public`/`@TenantOptional`. A CI route-coverage test fails the build otherwise.
- **Authorization decisions belong in the service**, on a resolved subject. Guards are a first filter; the UI is never a control.
- **`PermissionService.can()` stays pure** — role, subject and relationship flags in, boolean out, no I/O. Load what the decision needs into a `Subject` first.
- **Never re-implement scoping per endpoint.** Agent visibility, requester scoping and watcher access come from `scopeFor()`, which returns a **list of branches** (not one `where` object) so repositories can emit index-friendly `UNION ALL` queries.
- **The catalog and the matrix are one table** in `RBAC.md` §6. A new permission adds a row there and to the matrix test in the same PR, or the suite fails.
- **The UI renders from the server's answer.** `GET /me` gives role-level permissions for navigation; `GET /tickets/:id` gives `availableActions` **and** `capabilities` for buttons. A flat permission list cannot express "own, while `NEW`" — never re-derive it client-side.
- **Roles are on `Membership`** and cumulative (`REQUESTER ⊂ AGENT ⊂ ADMIN ⊂ OWNER`). Team lead is `TeamMembership.isLead`, a scoped capability, not a role — and a member can be in several teams.
- **Reads return `404`, actions return `403`.** A read of an entity the actor may not see is `404`; an action on an entity they _can_ see but may not perform is `403`. Nothing is left to taste.
- **`402` is only ever a plan limit.** Suspended orgs are `403`.
- **API tokens are actors, not bypasses**: scope ∩ role via the explicit `SCOPE_GRANTS` map, and never `member:*`, `org:*`, `token:*`, `support:*`, or `comment:read_internal` without the opt-in scope.
- **Platform admins never read tenant content** outside an owner-granted, read-only, audited support session. Never add an impersonation path.
- Authorization never considers `orgId` — by the time it runs, tenancy has already been resolved. Don't conflate the two layers.

### Application

- **Strict TypeScript, no `any`.** Unknown input is `unknown`, narrowed by Zod. No `!` outside tests.
- **Layering in `apps/api`: Controller → Service → Repository.** Controllers hold no business logic. Services import no Prisma. Repositories are the only Prisma importers. About to write `prisma.` in a service? Move it to the repository.
- **Frontends never import `@patchgrid/database`.** All data goes through the API, including server components and server actions.
- **`packages/contracts` (Zod) is the single source of truth for wire shapes.** Infer with `z.infer`; never hand-write parallel interfaces. `RESERVED_SLUGS`, size limits and the permission catalog live there too — one definition each, never restated in prose.
- **Priority is computed, never accepted from the client.** No `priority` on create/update DTOs; if one arrives, `400`.
- **State changes go through `POST /tickets/:id/transitions`** and the per-type transition table. Never set `status` anywhere else.
- **Mutations on `Ticket` and `KnowledgeArticle` carry a `version`**; a mismatch is `409`. Entity-creating `POST`s honour `Idempotency-Key`.
- **Successful responses carry no advisory text.** A soft block is a `409` the client retries with `confirm: true` — there is no `warnings` channel.
- **Audit writes happen in the same transaction as the change.** External side effects (email, SSE, jobs) happen after commit via domain events.
- **Invariants over a set of rows take a row lock**, never read-then-write. Owner counts and quota checks are where this bites.
- **One logical read is one transaction.** Every query runs in its own transaction, so an N+1 becomes N pooled connections. Use `include`/`select`; per-row follow-up queries block review.
- Every datetime column is `@db.Timestamptz(3)`; every id is UUID v7, `@db.Uuid`, and **not a secret**.
- Status codes: `401` unauthenticated, `403` not permitted or tenant mismatch, `402` plan limit, `404` unknown tenant/record, `409` invalid transition, conflict or stale write.
- **pnpm only.** Never emit `npm install` / `yarn` commands or lockfiles.
- **Next.js 16 is not the Next.js you remember.** Read `node_modules/next/dist/docs/` before writing routing, `proxy.ts`, caching or server-action code.

## Build order

Follow `docs/FEATURES.md` milestone by milestone; don't start one until the previous milestone's exit criteria are met. M1 (tenancy + identity) precedes all feature work — retrofitting isolation is not an option. Don't build anything under "out of scope".

## Testing expectations

Every Service method with branching logic (transitions, priority, SLA math, permissions, quotas) gets a unit test in the same PR. The tenancy isolation suite is a CI gate, not an optional extra — if you add a tenant-owned table, add its coverage, its policy, its composite keys and its grants. Integration tests once a module is functionally complete; E2E in M9. Time is injected via `Clock`; tests never sleep.

## When the spec is ambiguous or wrong

Flag it and propose a fix rather than silently picking an interpretation. These docs are the working spec, not fixed law. If the fix is a real decision, write an ADR. If it is a factual error in an accepted ADR, add a dated **Erratum** block under its Status line pointing at the correct rule — never edit the body.

## Commits

Conventional Commits, scoped: `feat(api): …`, `fix(app): …`, `docs: …`, `chore(db): …`. Small PRs, one task each.
