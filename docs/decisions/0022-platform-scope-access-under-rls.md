# 0022 — Platform-scope access under RLS: projections, not bypass

- **Status:** Accepted
- **Date:** 2026-09-22
- **Refines:** [0015](0015-tenant-isolation-rls.md) — the `runAsPlatform` escape hatch, which as written could not work

## Context

ADR-0015 established that the application connects as `patchgrid_app`, a role with **no `BYPASSRLS`**,
and that genuinely cross-tenant work goes through an explicit `runAsPlatform(fn)` helper.

Those two statements are incompatible. Inside `runAsPlatform` there is by definition no
`app.current_org_id`, so `current_setting('app.current_org_id', true)` is `NULL`, every tenant-owned
policy evaluates to `NULL` (filtered), and every read returns zero rows while every write is rejected by
`WITH CHECK`. The escape hatch escapes into a locked room.

Separating the real call sites shows that most of them do not need a bypass at all:

| Operation | Org known before the query? | Needs a true bypass? |
| --- | --- | --- |
| Tenant job dispatcher enqueues per-tenant jobs | reads `Organization` (platform class, no policy) | no |
| Per-tenant job body (`sla-scan:org`, `auto-close`) | yes — it is in the payload | no |
| Org provisioning | yes — the org was just created | no |
| Platform admin: suspend, set plan, restore | `Organization` only | no |
| Support session reads inside a granted session | yes — the session names the org | no |
| `org-purge` hard delete | yes | no |
| **Org picker: "which workspaces am I in?"** | **no — that is the question** | **yes** |
| **Accept an invitation from `app.patchgrid.xyz`** | **no — only a token is presented** | **yes** |
| **Authenticate `Authorization: Bearer pg_…`** | **no — only a prefix is presented** | **yes** |
| **Email intake: resolve `<slug>@inbound…`** (M6) | resolves against `Organization` | no |

So only three operations are genuinely cross-tenant, and all three share one shape: *a credential is
presented and the tenant must be discovered from it*. That is a lookup problem, not an isolation problem.

## Options considered

1. **Give `patchgrid_app` `BYPASSRLS` and rely on `runAsPlatform` discipline.** Destroys the central
   claim of ADR-0015 — that the application cannot disable its own isolation — in exchange for
   convenience. Rejected outright.
2. **A second role `patchgrid_platform` with `BYPASSRLS`**, on its own connection pool, confined to a
   single `PlatformRepository`, guarded by an ESLint import rule and a CI call-site test. This is what
   most production systems do and it is defensible. But the bypass now exists in the process: a mistaken
   injection, a `@Inject` typo, or a future contributor reaching for the convenient client reopens the
   whole failure mode, and no test can prove a negative about future code.
3. **Add a sentinel to the policies** (`OR current_setting('app.platform', true) = 'on'`). Cheapest to
   write and the worst of all worlds: the bypass is now in the *database*, in thirty policies, settable
   by any SQL the app can emit. A single injection anywhere becomes total.
4. **Make the tenant discoverable from the credential**, so the three lookup problems stop being
   cross-tenant problems. Two tiny platform-class projection tables and an org-bearing invite token; no
   bypass anywhere.

## Decision

Option 4. `patchgrid_app` never gets `BYPASSRLS`, and neither does any other role the application
process can reach.

### Two helpers, named apart so they are never confused

```ts
runAsTenant(orgId: string, fn: () => Promise<T>): Promise<T>
```

Establishes tenant context for an organization the *request* is not bound to. Sets
`app.current_org_id = orgId` exactly as a request would, so RLS, repositories and audit logging behave
identically. **This is not a bypass** — it is the ordinary mechanism pointed at a different org. Every
call logs `{ actor, orgId, reason }`. This covers the dispatcher's per-tenant jobs, provisioning,
support-session reads, `org-purge`, and platform admin actions that touch tenant content.

```ts
runAsPlatform(fn: () => Promise<T>): Promise<T>
```

Runs with **no** tenant context. It can therefore only touch **platform-class** tables — `Organization`,
`User`, `PlatformAdmin`, `OrganizationSlugHistory`, `RefreshToken`, `PasswordResetToken`,
`EmailVerification`, and the two projections below. If it touches a tenant-owned table it gets zero rows,
which is the correct and loud failure.

### Two projection tables, platform class

```
P  UserOrgIndex   { userId, orgId, role, status, orgSlug, orgName, orgStatus, updatedAt }
                    -- PK (userId, orgId)
P  ApiTokenIndex  { prefix (unique), orgId, revokedAt? }
```

Both are **derived**, written in the same transaction as the row they mirror, and never read for
authorization — only to answer "which tenant?". Concretely:

- `UserOrgIndex` is written whenever a `Membership` is created, has its role or status changed, or is
  removed, and whenever the org's slug, name or status changes. It answers exactly one question — *list
  the workspaces this user can enter* — for the org picker at `app.patchgrid.xyz` and for the post-login
  redirect. Once an org is chosen, the token binds to it and every subsequent query is ordinary
  tenant-scoped work. **The role stored here is never used to authorize anything**; the authoritative
  role is read from `Membership` inside tenant context on every request. It exists only so the picker can
  render a badge without N tenant round-trips.
- `ApiTokenIndex` maps a token prefix to an org so the bearer strategy can call
  `runAsTenant(orgId, …)` and then verify the Argon2id secret against the real `ApiToken` row — which
  stays tenant-owned, with its policy intact. The index holds a prefix and an org id: no secret, no hash,
  no scopes.

A consistency job (`projection-reconcile`, nightly, per tenant) recomputes both from source and reports
drift. Drift is a bug, not an expected state.

### Invitations carry their org

The invitation token becomes `<orgId-base36>.<secret>`. The API parses the org id, calls
`runAsTenant(orgId, …)`, then verifies `secret` against `Invitation.tokenHash`. A wrong or forged org id
finds no row and returns the same generic "invalid or expired invitation" as a wrong secret. `Invitation`
needs no projection and stays tenant-owned.

The same pattern is available to any future credential that must self-identify its tenant.

### Where the helpers may be imported

Replaces the "exactly three places" rule, which was already wrong (it omitted token auth, support
sessions, purge and email intake):

> `runAsPlatform` may be imported only by `src/platform/**`, `src/auth/**` and `src/jobs/dispatcher/**`.
> `runAsTenant` may additionally be imported by `src/jobs/**` and `src/orgs/provisioning/**`.
> Every other module reaches another tenant not at all.

Enforced by `no-restricted-imports` with explicit path allow-lists, and by a test that enumerates call
sites — a rule about modules, which does not need editing every time a legitimate call site appears.

### Boot assertion

On startup the API asserts `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` is `false`
and refuses to start otherwise. A catastrophic misconfiguration becomes a failed deploy instead of a
silent, total loss of isolation.

## Consequences

- The strongest claim in ADR-0015 survives intact: **the application process holds no credential capable
  of reading another tenant's data.** That is now true without qualification, and it is provable — the
  role simply lacks the privilege.
- Cost: two derived tables and the discipline of writing them transactionally. `UserOrgIndex` is the only
  denormalisation in the schema; it is four meaningful columns plus three display columns, and it is
  reconciled nightly.
- The projections are a new class of bug (drift) in exchange for removing a class of bug (total isolation
  failure). That is a good trade, and drift is detectable, bounded and non-confidential.
- `UserOrgIndex` duplicating `role`/`status` is a real hazard — a future contributor will be tempted to
  authorize against it. Mitigations: the columns are named `roleForDisplay` / `statusForDisplay`, the
  repository exposes only `listWorkspacesForUser()`, and an authorization test asserts that revoking a
  `Membership` denies access even when the projection is stale.
- Support sessions and `org-purge` are strictly better off: they run `runAsTenant`, so RLS is *enforcing*
  during the most sensitive operations in the product rather than switched off for them.
- If a future operation genuinely needs an unbounded cross-tenant scan of tenant data (a platform-wide
  analytics job, a migration), it is a new ADR and it does **not** get a shared credential — it runs
  per-tenant over `Organization`, or it runs offline against a replica.
