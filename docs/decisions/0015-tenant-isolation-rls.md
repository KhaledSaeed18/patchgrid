# 0015 — Tenant isolation: shared schema, `orgId`, and Postgres Row-Level Security

- **Status:** Accepted — refined by [0022](0022-platform-scope-access-under-rls.md) (the escape hatch) and [0023](0023-identity-keys-and-tenant-safe-foreign-keys.md) (the schema layer below this one)
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** Consequences, bullet 3 states that migrations and seeds run as the owner role
> "which bypasses RLS by ownership". That is wrong: `FORCE ROW LEVEL SECURITY` — specified in the
> Decision above — exists precisely to subject the table owner to policies. Only superusers and roles
> holding `BYPASSRLS` are exempt. The migration owner is therefore granted `BYPASSRLS` explicitly
> (`ENGINEERING.md` §Local development); the seed still sets tenant context per org, as stated.
>
> Two further omissions are corrected by later ADRs: `runAsPlatform` as described could not read
> tenant-owned tables at all (see ADR-0022), and the policy expression must be
> `NULLIF(current_setting('app.current_org_id', true), '')::uuid` — an empty-string GUC would raise
> rather than filter (see `TENANCY.md` §7).

## Context

With many unrelated companies in one database, a single forgotten `WHERE orgId = …` leaks one customer's tickets to another. That is the failure mode that ends SaaS products, so isolation needs to be enforced somewhere that cannot be forgotten — not only in application code that a tired developer writes at 1 a.m.

## Options considered

1. **Shared schema, filtering in the repository layer only** — fast and simple; correctness rests entirely on developer discipline, with no backstop. One missed filter, one raw query, one clever `include`, and data crosses tenants silently.
2. **Database per tenant** — strongest isolation and simplest mental model; operationally heavy (N databases to migrate, back up and monitor; connection-pool explosion; provisioning a tenant becomes a database operation). Appropriate at enterprise scale, absurd for this project.
3. **Schema per tenant** — one database, N Postgres schemas. Often described as the "advanced" choice, but with Prisma it is the worst of both worlds: the schema is defined once yet migrations must run per tenant, `search_path` has to be set per connection (fragile with pooling), cross-tenant platform queries need dynamic SQL, and Prisma's type generation assumes a single schema. High complexity, little transferable learning.
4. **Shared schema + `orgId` + Postgres Row-Level Security**, with the tenant supplied as a transaction-scoped session variable and the application connecting as a non-superuser role that cannot bypass RLS — the database itself refuses to return another tenant's rows, regardless of what the application asks for.

## Decision

Option 4, implemented as **four independent layers** so that no single mistake is sufficient to leak data:

**Layer 1 — Request context.** A Nest middleware resolves the tenant from the host (ADR-0014), verifies it against the token's `orgId`, and stores `{ orgId, userId, membershipRole }` in an `AsyncLocalStorage` store (`nestjs-cls`). Nothing downstream passes it by hand through every function signature.

**Layer 2 — Explicit repository arguments.** Every repository method still takes an explicit `orgId` (or a `TenantContext`) and includes it in the `where` clause. Redundant with layers 3 and 4 by design: it keeps the constraint visible in the code and in code review, and it keeps unit tests honest.

**Layer 3 — Prisma client extension.** A `$allOperations` extension wraps every query in a transaction that first runs `SELECT set_config('app.current_org_id', $1, true)` — the `true` makes the setting **transaction-local**, which is what makes this safe under connection pooling, where a pooled connection is shared between requests. The extension throws if no tenant context exists and the model is tenant-owned, so a query issued outside a request without an explicit context fails loudly instead of running unscoped.

**Layer 4 — Row-Level Security in Postgres.** Every tenant-owned table has `ENABLE ROW LEVEL SECURITY` plus `FORCE ROW LEVEL SECURITY` (so even the table owner is subject to it) and a policy:

```sql
CREATE POLICY tenant_isolation ON "Ticket"
  USING      ("orgId" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("orgId" = current_setting('app.current_org_id', true)::uuid);
```

`USING` filters reads, updates and deletes; `WITH CHECK` prevents writing a row into another tenant. The application connects as `patchgrid_app`, a role with **no** `BYPASSRLS` and no ownership of the tables. Migrations run as a separate owner role from a different connection string.

**Table classes.** Every table is explicitly labelled in the schema:
- *Tenant-owned* (`Ticket`, `Comment`, `Asset`, `Category`, `Team`, `Membership`, `AuditLog`, …) — `orgId` + RLS.
- *Platform* (`Organization`, `User`, `Plan`, `PlatformAdmin`) — no tenant policy; accessed through a dedicated `PlatformRepository` that the extension allows to run without tenant context, with access confined to auth, provisioning and platform admin code paths.
- *Join tables* carry `orgId` too, even when derivable, so a policy can be written on them directly.

**Escape hatch.** Genuinely cross-tenant work (platform admin, nightly maintenance) uses an explicit `runAsPlatform(fn)` helper that is loud, logged, and greppable. There is no silent bypass.

## Consequences

- **Every query runs inside a transaction.** This is the real cost: slightly more connection overhead and no implicit query batching outside transactions. Acceptable at this scale, and measured before it is optimised.
- **Connection pooling must be correct.** Transaction-local `set_config` is safe with a transaction-mode pooler; session-level settings would not be. Documented so nobody "optimises" the `true` away.
- **Migrations and seeds** run as the owner role, which bypasses RLS by ownership; the seed sets tenant context explicitly per org so it exercises the same path the app does.
- **Testing is the point.** A dedicated isolation suite seeds two organizations with identical-looking data and asserts: every list endpoint returns only its own org; a deliberately unscoped raw query still returns nothing for the wrong tenant (proving RLS, not just the repository); writing a row with a foreign `orgId` is rejected by `WITH CHECK`; a token from org A on org B's subdomain gets 403. A new tenant-owned table without a policy fails a schema-introspection test that enumerates tables and checks `relrowsecurity`.
- **If we ever need stronger isolation** for an enterprise tier, the path is: keep this design for the shared pool, and add a `databaseUrl` override per organization so a premium tenant gets its own database, resolved at connection time. That is a new ADR; nothing here blocks it.
