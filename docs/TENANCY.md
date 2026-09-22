# Patchgrid — Tenancy Model

The rules that make one deployment safely serve many unrelated companies. Decisions behind this file:
ADR-0013 (multi-tenant SaaS), ADR-0014 (subdomain routing), ADR-0015 (isolation), ADR-0017 (signup and
membership), ADR-0018 (jobs and events), ADR-0022 (platform-scope access), ADR-0023 (tenant-safe keys),
ADR-0024 (sessions), ADR-0025 (teams).

## 1. Entities

The authoritative field lists live in `ARCHITECTURE.md` §Data model. What matters here is the shape:

```
Organization    a tenant, addressed by slug                     platform class
User            a global identity: one email, one account       platform class
Membership      a user's role inside one organization           tenant-owned
TeamMembership  which teams that membership works in            tenant-owned
PlatformAdmin   an operator, outside all tenancy                platform class
UserOrgIndex    derived: which orgs a user may enter            platform class  (ADR-0022)
ApiTokenIndex   derived: which org a token prefix belongs to    platform class  (ADR-0022)
```

- A `User` is global: one email, one password, one account, many memberships.
- Unique: `(orgId, userId)` on `Membership`; `slug` on `Organization`; `email` on `User`.
- **`role` is never on `User`.** Every permission check resolves the caller's membership *for the current
  organization*.
- **Rows reference people by `membershipId`, not `userId`** (ADR-0023). "This person is a member of this
  org" is therefore a foreign-key constraint, not an application check.
- The two `*Index` tables are **derived projections**, written in the same transaction as their source
  rows and read only to answer "which tenant?" before a tenant is known. They are never read to authorize
  anything (ADR-0022).

## 2. Slugs and subdomains

- Format: 3–30 chars, lowercase `[a-z0-9]` with single internal hyphens; no leading/trailing hyphen; no
  `--`; not reserved; unique. One Zod schema in `@patchgrid/contracts` validates it for the signup form,
  the API and tenant resolution alike.
- **The reserved list has exactly one definition**: `RESERVED_SLUGS` in `@patchgrid/contracts`, grouped
  and commented (infrastructure, mail, auth, brand, product surfaces). It is not restated in prose
  anywhere, including here. **Any PR that introduces a new public hostname adds its label to that set in
  the same PR** — `inbound.patchgrid.xyz` (email intake) and `files.patchgrid.xyz` (attachments) are in
  it for exactly this reason.
- Changing a slug: `OWNER` only, at most once per 30 days.
- **A released slug is never reusable.** `OrganizationSlugHistory` rows are kept forever and excluded
  from availability. Reassigning a slug would hand a new company another company's bookmarks, emailed
  deep links and cached redirects — a phishing position, and a cookie-tossing one given the shared cookie
  domain. The storage cost of keeping the rows is nil.
- The old slug **302**-redirects for 30 days, never 301: a 301 is cached by the browser permanently, and
  nothing that permanent should describe a mutable mapping. After 30 days the redirect stops; the
  reservation does not.
- Resolution order at request time: exact slug → slug history (redirect, if within the window) → 404.
  Unknown, suspended and pending-deletion tenants never reach application code.

## 3. Organization lifecycle

| Status | Meaning | Behaviour |
| --- | --- | --- |
| `ACTIVE` | Normal | Everything works |
| `SUSPENDED` | Set by a platform admin (abuse, non-payment later) | Subdomain serves a 403 page; the API returns `403` with `type: …/organization-suspended`; background jobs skip the tenant |
| `PENDING_DELETION` | Owner requested deletion | Subdomain 404s, data retained for 30 days, restorable by a platform admin |

`402` is reserved exclusively for plan limits (§8). A suspended organization is never `402`.

Hard deletion runs as a job after 30 days: tenant rows are removed, object-storage keys under
`org/<orgId>/` are purged, and an anonymised platform record of the deletion is kept for audit. The purge
runs under `runAsTenant(orgId)` — RLS stays *enforcing* during the most destructive operation in the
product, so a bug in the purge cannot reach a neighbouring tenant.

## 4. Signup and provisioning

1. Visitor clicks a CTA on `patchgrid.xyz` → account creation (email + password) or login if the email
   exists.
2. Email verification is sent but does **not** block. Until verified: no outbound email is sent on the
   user's behalf, they cannot invite members, and they may own **at most one** organization — which is
   what stops the signup form being used to squat subdomains in bulk. Link expires in 24 h.
3. Workspace creation: name, slug (live availability check), optional email domain.
4. **Provisioning transaction**: `Organization` + owner `Membership` + its `UserOrgIndex` row + default
   teams (IT Support, Network, Security) + default category tree + **eight** default SLA policies (four
   priorities × two ticket types, per `DOMAIN.md` §4.1) + starter KB articles.
5. Anything slower — sample data, search warm-up — runs as an idempotent background job keyed by `orgId`.
6. Redirect to `https://<slug>.patchgrid.xyz`.

Provisioning is idempotent: retrying a failed job never double-seeds.

## 5. Joining an existing organization

- **Invitation** (default): an `ADMIN`/`OWNER` invites an email with a role and optional team.
  Single-use, hashed at rest, expires in 7 days. The token is `<orgId-base36>.<secret>` so the API can
  establish tenant context before looking the invitation up (ADR-0022) — a wrong org id and a wrong
  secret produce the same generic failure. If the email already has an account, acceptance adds a
  `Membership`; it never creates a second `User`.
- **Verified-domain auto-join** (opt-in, off by default): if `Organization.domain` is proven by a DNS TXT
  record and `allowDomainJoin` is on, a user whose email is verified at that domain may join directly
  with `defaultJoinRole` (normally `REQUESTER`).
  - Free and disposable mail domains are on an explicit denylist. They cannot be DNS-verified in
    practice, but the denylist documents the intent and guards against a verification bug.
  - A domain may be verified by **one** organization. First verified wins; a second org attempting the
    same domain gets an admin-visible conflict message rather than a silent second claim.
- There is no open self-join. Ever.

## 6. Sessions, tenant resolution and revocation

Full reasoning in ADR-0024.

**The credential carries the tenant; the host corroborates it.** Resolution order on every API request:

1. `Authorization: Bearer pg_…` → the tenant is the token's org. Cookies are ignored.
2. Otherwise the access-token cookie's `orgId` **is** the tenant. This is authoritative.
3. If `Origin` is present it must resolve to that same org, else `403`. This is the CSRF and
   cookie-tossing check, not the resolution mechanism.
4. If `Origin` is absent (server-side `apiFetch`), `X-Patchgrid-Tenant: <slug>` must be present and match
   — a consistency assertion, never a trust input.
5. `@TenantOptional` routes skip all of it.

**Cookies are per tenant**, so two workspaces can genuinely be open in two tabs:

```
pg_at_<slug>   access,   Domain=.patchgrid.xyz, httpOnly, SameSite=Lax, Secure
pg_rt_<slug>   refresh,  Domain=.patchgrid.xyz, Path=/api/v1/auth
pg_id          identity, tenant-less — used by app.patchgrid.xyz and read by www
```

- The access token carries `{ sub: userId, org: orgId, mem: membershipId, role, iat }` and is bound to
  **exactly one** organization.
- `app.patchgrid.xyz` is tenant-less: it lists the caller's workspaces from `UserOrgIndex` and mints a
  tenant cookie pair on selection, then redirects to that subdomain. Existing pairs are untouched.
- On mint, prune to the 5 most recently used tenant pairs to stay inside the per-domain cookie budget.
- A slug change re-mints under the new cookie name and expires the old one in the same response.
- **Revocation epoch**: Redis `rev:<membershipId>` holds a timestamp; a token whose `iat` predates it is
  rejected. Bumped on membership disable/remove, role change, team change, org suspension, password
  change, "log out everywhere", API-token revoke, and support-session revoke or expiry. This is what
  makes revocation actually immediate rather than immediate-in-15-minutes. On a Redis outage the check
  fails **closed for mutations and open for reads** — a deliberate availability trade.
- Disabling a membership revokes that organization's sessions only; the user's account and other
  memberships are untouched.

**Residual risk, recorded rather than hidden:** any tenant subdomain can set cookies for
`.patchgrid.xyz` ("cookie tossing"). Tokens are signed, so a tossed cookie cannot forge a session — the
ceiling is logging the victim out. Per-tenant names mean an attacker cannot silently change *which*
tenant a user is acting in, which is the dangerous version. The structural fix is the Public Suffix List,
deferred to the DNS ADR.

## 7. Isolation (summary — full reasoning in ADR-0015, ADR-0022, ADR-0023)

Five layers. No single mistake is sufficient to leak data.

| Layer | Mechanism | Fails how |
| --- | --- | --- |
| 0. Schema shape | Composite foreign keys on `(orgId, id)`; people referenced by `membershipId` (ADR-0023) | A cross-tenant reference is *unrepresentable* — rejected by the constraint, not by code |
| 1. Request context | Credential → org, cross-checked against `Origin`/tenant header, stored in `AsyncLocalStorage` (`nestjs-cls`) | Wrong or missing tenant → 403/404 before any handler runs |
| 2. Repository arguments | Every repository method takes an explicit `orgId` and filters on it | Visible in code review and unit tests |
| 3. Prisma client extension | Wraps every operation in a transaction that sets `app.current_org_id` transaction-locally; throws if a tenant-owned model is queried with no context | Loud runtime error, never a silent unscoped query |
| 4. Postgres RLS | `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `USING`/`WITH CHECK` policy on every tenant-owned table; the app connects as a non-superuser role without `BYPASSRLS` | The database returns nothing and refuses foreign-tenant writes |

Layer 0 is new and matters because layers 1–4 all inspect rows *individually*. PostgreSQL performs
referential-integrity checks with row security disabled, so before ADR-0023 a correctly-tenanted
`Comment` could legally point at another tenant's `Ticket` and no layer would object.

The policy expression is generated from one template for every tenant-owned table:

```sql
USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
```

The `NULLIF` matters: an unset GUC yields `NULL` and filters everything (fail-closed, correct), but an
*empty string* would raise `invalid input syntax for type uuid` and turn every query into a 500.

**Table classes.** The schema is the source of truth and a coverage test enumerates it; only the
platform-class list is closed and worth writing down:

> `Organization`, `User`, `PlatformAdmin`, `OrganizationSlugHistory`, `RefreshToken`,
> `PasswordResetToken`, `EmailVerification`, `UserOrgIndex`, `ApiTokenIndex`.

Everything else is tenant-owned: it carries `orgId`, has a policy, has `orgId`-first indexes, and appears
in the schema-coverage test. Join tables carry `orgId` too, even when derivable, so a policy can be
written directly on them.

**Crossing tenants** uses two helpers, deliberately named apart (ADR-0022):

- `runAsTenant(orgId, fn)` — establishes context for a *known* org the request is not bound to. Not a
  bypass; the ordinary mechanism pointed elsewhere. Used by per-tenant jobs, provisioning, support
  sessions, org purge, and platform admin actions on tenant content.
- `runAsPlatform(fn)` — no tenant context at all, so it can only reach platform-class tables. Used by the
  job dispatcher, login/org-picker, and API-token authentication.

Import paths are restricted by ESLint: `runAsPlatform` to `src/platform/**`, `src/auth/**` and
`src/jobs/dispatcher/**`; `runAsTenant` additionally to `src/jobs/**` and `src/orgs/provisioning/**`.
The API asserts at boot that its own role lacks `BYPASSRLS` and refuses to start otherwise.

**What a platform admin may actually do inside a tenant** is deliberately narrow and is specified in
`RBAC.md` §8–9: metadata and lifecycle always; tenant *content* only during an owner-granted, read-only,
time-boxed support session whose reads are written to the tenant's own audit log. There is no
impersonation.

## 8. Plans and limits

`Plan` is `FREE | PRO`, set manually by a platform admin in v1 (no payment processing).

| | FREE | PRO |
| --- | --- | --- |
| Agent seats (`AGENT`/`ADMIN`/`OWNER`) | 3 | 25 |
| Requesters | unlimited | unlimited |
| Tickets per calendar month (UTC) | 200 | 10 000 |
| Attachment storage | 1 GB | 25 GB |
| Automation rules | 3 | 50 |
| Knowledge articles | 25 | unlimited |
| LLM triage | off | on |

`QuotaService` returns `402` with a Problem Details `type` the UI maps to an upgrade prompt. Three rules
make the numbers mean something:

- **Postgres is the source of truth.** `UsageCounter` holds the authoritative value; Redis is a
  read-through cache for *display* only. A flushed or evicted Redis must never grant free quota.
- **Enforcement is atomic, never check-then-act.** The increment is
  `UPDATE "UsageCounter" SET value = value + 1 WHERE … AND value < :limit RETURNING value`, inside the
  same transaction as the thing being created. Zero rows returned means over limit, `402`, and the
  transaction rolls back with the row that was not created. Two concurrent creates at the limit cannot
  both succeed.
- **Invariants over a set of rows take a row lock first.** Seat counts, owner counts and any other
  "how many are there" rule take `SELECT … FROM "Organization" WHERE id = :orgId FOR UPDATE` inside the
  mutating transaction. Read-then-write races are how an org ends up with zero owners.

`period` is `YYYY-MM` in **UTC**. Metrics: `tickets_created` (cumulative per period),
`agent_seats`, `storage_bytes`, `automation_rules`, `kb_articles` (point-in-time, therefore
recomputable). The nightly `usage-reconcile` job recomputes the point-in-time metrics from source and
reports drift on the cumulative one.

**Downgrade below current usage** never destroys data: the downgrade is allowed, *new* creation is
blocked with `402`, and an over-limit banner appears for admins and owners until usage fits.

## 9. Tenant-aware background work

- Every job payload carries `orgId`; the processor wrapper calls `runAsTenant(orgId)` so RLS, repositories
  and audit logging behave exactly as they would in a request.
- Sweeping work is **two-stage**: a dispatcher uses `runAsPlatform` to list active organizations from
  `Organization` (platform class) and enqueues one job per tenant. No job scans all tenants at once.
- Per-tenant job priority derives from plan and recent volume, so one large tenant cannot starve others.
- Job ids are `<queue>:<orgId>:<entityId>:<discriminator>` — idempotent per tenant, collision-free across
  tenants.
- SSE channels are namespaced `org:<orgId>:notifications`; a subscriber can only subscribe to its own
  token's org, and the fan-out applies the same `scopeFor()` filter as a list query, so an
  `OWN_TEAM_ONLY` agent never receives an event for a ticket they cannot read.
- Outbound email renders in tenant context, links to `https://<slug>.patchgrid.xyz/...`, uses the org name
  as the `From` display name with a Patchgrid envelope sender.

## 10. What the seed must contain

The development and demo seed creates **two** organizations (`acme`, `globex`) with deliberately similar
data — same category names, overlapping ticket titles, same team names — plus one user who is a member of
both with different roles. This is what makes isolation bugs visible immediately, in development and in
the test suite. It is also what exercises per-tenant cookies (§6): the dual-member account must be able
to hold both workspaces open at once.
