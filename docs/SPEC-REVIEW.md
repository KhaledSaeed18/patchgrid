# Patchgrid — Specification Review (round 1)

Review date: 2026-09-22. Scope: `docs/*.md` and `docs/decisions/*.md`, read line by line, plus the
current repository state.

This is a **working document**, not a permanent one. Every finding gets resolved into the real docs
(or into a new ADR) and then struck from here; when the list is empty the file is deleted.

Severity:

- **P0 — blocking.** Changes the schema, the request pipeline or the security model. Must be settled
  before M0, because retrofitting is expensive or impossible.
- **P1 — must fix before the milestone that touches it.** A real bug or hole, but localised.
- **P2 — improvement.** Makes the design better / more production-grade. Optional but recommended.
- **Q — open question.** Needs a decision from you; I have a recommendation for each.

Counts: **14 P0** · **36 P1** · **15 cross-document contradictions** · **11 P2** (plus 17 minor) · **6 repo-state** · **9 open questions**.
Round 2 (isolation spike, same date) added **5 findings** and closed the `uuid(7)` question empirically.

---

---

# Resolution status — round 1 closed 2026-09-22

Every finding below has been resolved into the specification, or is listed here as still open. The
detailed write-ups after this section are kept as the reasoning record; they are not a to-do list any
more. **When the "still open" table is empty, delete this file.**

## Decisions taken

| Fork | Chosen |
| --- | --- |
| Q-1 platform scope under RLS | Projection tables, `patchgrid_app` never gets `BYPASSRLS` → **ADR-0022** |
| Q-2 session cookies | Per-tenant cookie names → **ADR-0024** |
| Q-3 teams | `TeamMembership` join table → **ADR-0025** |
| Q-4 person references | `membershipId` everywhere + composite FKs → **ADR-0023** |
| Q-5 MFA | Build it (TOTP + step-up), M9 → **ADR-0029** |
| Q-6 plan downgrade | Allow, block new creation, never delete data → `TENANCY.md` §8 |
| Q-7 released slugs | Permanently reserved, 302 not 301 → `TENANCY.md` §2 |
| Q-8 DNS/TLS design now | Yes → **`docs/DNS.md`**, ADR-0026, ADR-0027 |
| Q-9 milestone split | M8 platform / M9 hardening / M10 ship; threat model moved to M1 → `FEATURES.md` |

## New documents

| Document | Covers |
| --- | --- |
| [ADR-0022](decisions/0022-platform-scope-access-under-rls.md) | `runAsTenant` vs `runAsPlatform`, `UserOrgIndex`, `ApiTokenIndex`, org-bearing invite tokens, boot assertion |
| [ADR-0023](decisions/0023-identity-keys-and-tenant-safe-foreign-keys.md) | Composite tenant FKs, membership references, UUIDv7, `@db.Uuid`, `timestamptz`, four CI introspection assertions |
| [ADR-0024](decisions/0024-per-tenant-cookies-and-api-tenant-resolution.md) | Tenant resolution order, per-tenant cookies, cookie tossing, revocation epoch |
| [ADR-0025](decisions/0025-multi-team-membership.md) | `TeamMembership`, `isLead`, branch-shaped `ScopeFilter` |
| [ADR-0026](decisions/0026-wildcard-tls-and-dns-operations.md) | DNS-01, `_acme-challenge` delegation, CAA, CT privacy, the PSL question |
| [ADR-0027](decisions/0027-email-dns-and-inbound-sender-authentication.md) | SPF/DKIM/DMARC alignment, inbound sender authentication, thread-injection fix |
| [ADR-0028](decisions/0028-data-protection-export-erasure-retention.md) | Tenant export, pseudonymised erasure, retention windows |
| [ADR-0029](decisions/0029-mfa-and-step-up-authentication.md) | TOTP, recovery codes, step-up for irreversible actions |
| [ADR-0030](decisions/0030-observability-opentelemetry-per-tenant.md) | OTel seam from M0, per-tenant spans and metrics, cardinality discipline |
| [DNS.md](DNS.md) | Zone contents, TLS, mail, custom domains, subdomain takeover, local tiers |

Nine accepted ADRs (0005, 0012, 0014, 0015, 0017, 0018, 0019, 0020, 0021) carry dated **Erratum** blocks
under their Status lines. Their bodies are unchanged — the correction convention is now written into
`ENGINEERING.md` §Documentation and `decisions/README.md`.

## Where each finding landed

| Findings | Resolved in |
| --- | --- |
| P0-1, P0-2, P1-18 | ADR-0024 · `TENANCY.md` §6 · `ARCHITECTURE.md` §Request pipeline |
| P0-3, P1-36 | ADR-0022 · `TENANCY.md` §7 · ESLint module rule |
| P0-4, P0-5, P0-8, P0-9 | ADR-0023 · `ARCHITECTURE.md` §Data model |
| P0-6, P0-7 | ADR-0015 erratum · `ENGINEERING.md` §Local development (grants + `ALTER DEFAULT PRIVILEGES`) |
| P0-10, P0-11 | `TENANCY.md` §7 (`NULLIF` template) · `ENGINEERING.md` §Transactions (CLS-aware nesting) |
| P0-12 | `ARCHITECTURE.md` §Data model · `CLAUDE.md` |
| P0-13, P0-14 | ADR-0005 erratum · `ARCHITECTURE.md` §Security posture · `DOMAIN.md` §7 |
| P1-1 … P1-10 | `DOMAIN.md` §1, §2, §4, §7 — clock origins, split warnings, transition guards, link directions, comment lifecycle |
| P1-11, P1-12 | `TENANCY.md` §8 · `ENGINEERING.md` §Transactions (row locks, atomic counters) |
| P1-13, P1-14 | `TENANCY.md` §2 · `RESERVED_SLUGS` in `@patchgrid/contracts` · `DNS.md` §6 |
| P1-15, P1-16 | `DOMAIN.md` §9.1 · `ARCHITECTURE.md` §Indexes |
| P1-17, P1-35 | `ENGINEERING.md` §API conventions (`version`, `Idempotency-Key`) |
| P1-19 … P1-23 | `DOMAIN.md` §2.1, §4.2, §7, §9.2 · `ARCHITECTURE.md` §Data model |
| P1-24 | ADR-0027 · `FEATURES.md` M6 |
| P1-25, P1-26 | `RBAC.md` §8, §9 · ADR-0020 erratum |
| P1-27 | ADR-0029 · `FEATURES.md` M9 |
| P1-28 … P1-31 | `RBAC.md` §6 (one table), §7 (`capabilities`), §10 (`SCOPE_GRANTS`) |
| P1-32 | `ARCHITECTURE.md` §Request pipeline (throttle first, one token verification) |
| P1-33, P1-34 | `ENGINEERING.md` §Testing (per-worker template clones, owner role, enum assertions) |
| D-1 … D-15 | Each doc, at the noted line. D-11 remains a repo task |
| P2-1 … P2-8 | `ARCHITECTURE.md`, `ENGINEERING.md` §Schema changes, ADR-0028/0029/0030, `DNS.md` |
| P2-9, P2-10 | `FEATURES.md` — M8/M9/M10 split, sequencing, threat model to M1 |
| P2-11 a–q | Folded into the relevant sections |

## Round 2 — isolation spike, 2026-09-22

A throwaway spike against PostgreSQL 17 + Prisma 7.10.0 exercised the mechanism the plan rests on.
Eleven assertions, all passing, each confirmed against the actual database error rather than a loose
regex. Findings folded into the docs; the spike itself was deleted, as a spike should be.

**Confirmed as designed** — RLS read filtering · `WITH CHECK` rejecting a foreign-tenant write
(`42501`) · no-context queries throwing rather than running unscoped · the `NULLIF` policy template
returning zero rows for an empty GUC instead of raising · `withTransaction` nesting without a
nested-transaction error · `ALTER DEFAULT PRIVILEGES` covering tables created after the grants ·
`@db.Timestamptz(3)` leaving zero naive timestamps · the app role's `rolbypassrls` being `false`.

**P0-4 proven, including the counterfactual.** Composite FKs generate as
`FOREIGN KEY ("orgId","ticketId") REFERENCES "Ticket"("orgId", id)` and reject a cross-tenant reference
with `P2003`. With a **single-column** FK the identical insert *succeeded* — an org-B row written
pointing at an org-A ticket, past `WITH CHECK` and past RLS. The hole ADR-0023 exists to close is real.

**Five things the plan had wrong or unstated:**

| # | Finding | Folded into |
| --- | --- | --- |
| S-1 | Prisma's `latest` dist-tag points at `8.0.0-rc.15`, a **release candidate**; stable is `7.10.0` (`prev`). `pnpm add prisma` installs the RC, possibly at a different major than `@prisma/client` | `ENGINEERING.md` §Repository hygiene · `FEATURES.md` M0 |
| S-2 | **Prisma 7 removed `url` from the datasource block.** Connection strings go in `prisma.config.ts`; the client takes a `@prisma/adapter-pg` driver adapter; the generator provider is `prisma-client`. Two adapters give the two roles two pools — better than the old single-URL model | `ARCHITECTURE.md` §Stack · ADR-0023 · `FEATURES.md` M0 |
| S-3 | **Lazy `PrismaPromise` defeats naive `AsyncLocalStorage`.** `als.run(s, () => repo.find())` loses the context before the extension runs; it must be `als.run(s, async () => await fn())`. Fails closed, but fails — and it is the one thing the spike got wrong on its first run | `ENGINEERING.md` §Transactions · ADR-0015 |
| S-4 | The extension **cannot** redirect `query(args)` to a transaction client. It batches `$transaction([set_config, query(args)])` per operation and passes through when a transaction is already open | `ENGINEERING.md` §Transactions · ADR-0015 |
| S-5 | Raw queries reach the extension with `model === undefined`, so **layer 3 is genuinely skipped** for raw SQL — RLS alone catches it. Confirms the ban rather than softening it | `ENGINEERING.md` §Transactions |

Also noted: pnpm blocks Prisma's postinstall until `allowBuilds` lists it, and Prisma 7 ships an
agent-consent guard on `db push --accept-data-loss` (it was not needed — the database was empty).

## Round 3 — M0 infrastructure, 2026-09-22

Building Compose and `packages/database` against the real registries and the real toolchain turned up
six more places where the plan described something that no longer exists. All folded in.

| # | Finding | Folded into |
| --- | --- | --- |
| S-6 | **`docker.io/minio/minio` is not publicly pullable** ("pull access denied"). The working source is `quay.io/minio/minio`, and likewise `quay.io/minio/mc` | `ARCHITECTURE.md` §Local infrastructure |
| S-7 | **MinIO CORS is a server setting, not a bucket one.** `mc cors set` returns "functionality that is not implemented"; a JSON body fails earlier still, since the command expects XML. `MINIO_API_CORS_ALLOW_ORIGIN` works, verified by preflight from a tenant subdomain and rejection of a foreign origin | ADR-0005 erratum · `ARCHITECTURE.md` |
| S-8 | Prisma's `extensions` datasource property needs a preview feature **and** would emit `CREATE EXTENSION` into migrations run by `patchgrid_owner`, which is not a superuser. Extension lifecycle belongs to the superuser bootstrap | `packages/database/prisma/schema.prisma` |
| S-9 | **`pnpm --filter <pkg> <name>` resolves pnpm's builtins first.** `--filter x doctor` runs `pnpm doctor` and fails with `Unknown option: 'recursive'`. Every root script uses an explicit `run` | `ENGINEERING.md` §Repository hygiene |
| S-10 | `globalDotEnv` is not a Turborepo 2 key — it is `globalDependencies`, and env vars that affect task output must be declared in `globalEnv` or the lint plugin flags them | `turbo.json` |
| S-11 | `.gitignore` carried `.env*`, which silently ignores `.env.example` — the file `ENGINEERING.md` calls the authoritative list of variables | `.gitignore`, `ENGINEERING.md` |

Also corrected: `exactOptionalPropertyTypes` was **missing** from the shared base tsconfig despite
`ENGINEERING.md` §TypeScript mandating it. Enabling it immediately caught `prisma.config.ts` passing
`undefined` where the type says "absent" — exactly the class of bug the flag exists for.

The Postgres image creates `POSTGRES_DB` owned by the superuser, so both bootstrap paths now transfer
database and schema ownership to `patchgrid_owner`; without it `prisma migrate reset` cannot recreate
the `public` schema.

## Round 4 — apps/api, 2026-09-22

| # | Finding | Folded into |
| --- | --- | --- |
| S-12 | **NestJS 12 is released, but `nestjs-zod@5.5.0` peers `@nestjs/common ^10 \|\| ^11`.** Staying on Nest 11 is now a recorded decision rather than a stale number. `nestjs-zod` does support Zod 4 | `ARCHITECTURE.md` §Stack |
| S-13 | **A compiling package must not use `.ts` in its own relative imports.** SWC preserves the extension, so `require("./app.module.ts")` reaches `dist/` and fails at boot. Source-shipped packages still need it. Both rules are true; the distinction is whether the package emits | `ENGINEERING.md` §Repository hygiene |
| S-14 | `import.meta` is unavailable in CommonJS output — tsc rejects it even though SWC silently rewrites it. `apps/api` uses `__dirname` | `apps/api/src/main.ts` |
| S-15 | **Terminus signals a failed readiness check by throwing a 503 carrying the per-indicator detail.** A global `@Catch()` Problem Details filter swallows it into a generic 500, discarding exactly what an orchestrator needs. Health is now exempt from the filter — found only by actually stopping Redis | `ENGINEERING.md` §API conventions · filter spec |
| S-16 | Locating the `.env` by a fixed `../../..` worked only because `src/` and `dist/` sit at the same depth. Replaced with an upward search plus an `ENV_FILE` override | `apps/api/src/main.ts` |

Verified against the running stack: liveness stays `200` while Redis is down and readiness returns `503`
naming it; CORS allows `acme.lvh.me:3001` and blocks `acme.lvh.me.evil.com:3001`, a wrong port, a
two-label host and a malformed slug; an unknown route renders Problem Details with
`application/problem+json` and an `x-request-id`; the boot assertion confirms the app role cannot bypass
RLS.

## Round 5 — CI, 2026-09-22

| # | Finding | Folded into |
| --- | --- | --- |
| S-17 | **The lint gate had no teeth.** The scaffold's shared ESLint config included `eslint-plugin-only-warn`, which downgrades every error to a warning; ESLint exits 0 on warnings, so `turbo lint` passed regardless of what it found. Removed, with `--max-warnings 0` everywhere. Discovered while adding the boundary rules — which would have been decorative | `packages/eslint-config/base.js` · `ENGINEERING.md` §CI |
| S-18 | A fresh install carried **19 high-severity advisories**, so the audit gate would have been red on arrival. Resolved to zero with targeted `pnpm.overrides`, each annotated: `multer` (real, via `@nestjs/platform-express`), and `mysql2`/`deepmerge-ts` (Prisma CLI adapters we never load — unreachable, but an unreachable advisory still fails a gate). Five moderates remain, all transitive build tooling | `package.json` `pnpm.overrides` |
| S-19 | `docker compose up -d --wait` treats a one-shot initialiser's **clean exit as a failure**, so `minio-init` broke the wait. Long-running services are waited on explicitly and the initialiser runs afterwards in the foreground | `.github/workflows/ci.yml` · `ENGINEERING.md` |

The boundary rules were verified by planting deliberate violations — a frontend
importing `@patchgrid/database`, and raw SQL in an API service — confirming each
fails with a message naming the document it comes from, then removing them.

## Still open

| # | Item | Why it is not closed |
| --- | --- | --- |
| **R-4** | `.vscode/` exists but is git-ignored | Decide: commit shared settings, or delete |
| **D-6** | ADR-0015 lists a `Plan` table that was never built | The closed platform-class list in `TENANCY.md` §7 omits it, so the schema is unambiguous; the ADR body is immutable and this is too minor for an erratum |

# Part 0 — What is genuinely good

Worth stating before the criticism, because these should not be "improved" away:

- The four-layer isolation model (`TENANCY.md` §7) with RLS as the backstop is the right call, and
  layer 2 (explicit `orgId` in every repository method) being *deliberately redundant* is correct
  reasoning that most people get wrong.
- `PermissionService.can()` being **pure** is the single best decision in `RBAC.md`. It is what makes
  the exhaustive matrix test possible, and it is what a policy engine would give you anyway.
- The route-coverage reflection test (`RBAC.md` §13.3) is the real protection against an unguarded
  endpoint. Most codebases have nothing equivalent.
- Two-stage job dispatch (ADR-0018) instead of a global scan.
- Consent-based support access (ADR-0020). Almost nobody does this; it is the most distinctive thing
  in the whole spec.
- Seeding two lookalike orgs plus a dual-member user (`TENANCY.md` §10) so isolation bugs are visible
  by construction.
- `REOPENED` as an action rather than a status (ADR-0002).

None of the findings below dispute any of that.

---

# Part 1 — P0: blocking design defects

## P0-1 · The API cannot resolve the tenant from its own `Host` header

`ARCHITECTURE.md:70` — "host → slug → Organization (Redis-cached 60s)"
`TENANCY.md:55` — "Tenant resolution middleware compares the host's organization against the token's `org`"
`ADR-0014:29` — "Tenant resolved from the `Origin`/`Referer` host **and** cross-checked against the token"

These three contradict each other, and the first two are unimplementable. Every API request arrives at
`api.patchgrid.xyz`. Its `Host` header is `api.patchgrid.xyz` — there is no slug in it. There is no
`acme.api.patchgrid.xyz`.

So the tenant must come from somewhere else, and the three candidate sources behave differently:

| Caller | `Origin` present? | Cookie present? | Notes |
| --- | --- | --- | --- |
| Browser, client component (`fetch`/TanStack Query) | yes | yes | `Origin: https://acme.patchgrid.xyz` |
| Browser, `EventSource` (SSE) | yes | yes | GET only, cannot set headers |
| Next.js **server** component / server action via `apiFetch` | **no** | forwarded manually | server-to-server fetch sends no `Origin` |
| API token (curl, monitoring system) | usually no | no | token is the only binding |

`ADR-0007` makes server components first-class callers, so the "no `Origin`" row is not an edge case —
it is the majority of page loads.

**Recommendation.** State one resolution order explicitly and put it in `ARCHITECTURE.md` §Request
pipeline, replacing "host → slug":

1. If `Authorization: Bearer pg_…` → tenant is the token's org. `Origin`, if present, must match that
   org's host, else `403`.
2. Else, the access-token cookie's `orgId` **is** the tenant. This is the authoritative binding.
3. Additionally, if `Origin` is present, it must resolve to the same org → else `403`. (This is the
   CSRF/cookie-tossing check, not the resolution mechanism.)
4. Server-side callers with no `Origin` send `X-Patchgrid-Tenant: <slug>` from `apiFetch`, which must
   also match the token's org. This is a consistency assertion, not a trust input.
5. `@TenantOptional` routes skip all of it.

The important reframing: **the token is the tenant; the host is a cross-check.** The current docs have
it backwards, and that inversion is load-bearing everywhere else.

## P0-2 · One shared cookie means two tenants cannot be open in two tabs

`ADR-0014:15` justifies subdomain-per-tenant partly because "two tenants can be open in two tabs" and
criticises the single-host option for "multiple sessions in one browser fight over one cookie".

`ADR-0014:39` then issues the session cookie with `Domain=.patchgrid.xyz` — a single cookie for all
subdomains. The stated advantage is therefore not delivered; the stated drawback is reproduced exactly.

Concrete failure, deterministic: a user is a member of `acme` and `globex`.

1. Tab A on `acme.patchgrid.xyz`, cookie holds an acme-bound token.
2. Tab B on `globex.patchgrid.xyz` → token org ≠ host org → `403` → redirect to org picker → new token
   minted for globex, **overwriting the same cookie**.
3. Tab A's next request now presents a globex token on acme's host → `403` → redirect to picker → mints
   an acme token → tab B breaks.

Infinite ping-pong. This is not theoretical; it is the first thing your own `both@acme.test` seed user
will hit (`ENGINEERING.md:102`).

**Recommendation.** Name the cookie per tenant, keep `Domain=.patchgrid.xyz` so `api.` can read it:

```
pg_at_<slug>      access,  Domain=.patchgrid.xyz, httpOnly, SameSite=Lax, Secure
pg_rt_<slug>      refresh, Domain=.patchgrid.xyz, Path=/api/v1/auth, httpOnly
pg_id             identity-only (userId), tenant-less, used by app.patchgrid.xyz and www
```

The API picks the cookie matching the tenant resolved in P0-1. Add a cap (e.g. prune to the 5 most
recently used tenant cookies on mint) so a user in 30 orgs does not blow the 4 KB / per-domain cookie
budget. Note the consequence for `apps/www`: it reads `pg_id`, not a tenant cookie, to decide whether
to show "Go to your workspace".

Also record the residual risk: any tenant subdomain can *set* cookies for `.patchgrid.xyz`
("cookie tossing"), so a malicious tenant can overwrite another's cookie. Per-tenant names plus signed
tokens reduce this to a denial-of-service, not a takeover. `__Host-` prefixes cannot be used because
they forbid a `Domain` attribute.

## P0-3 · `runAsPlatform()` cannot read tenant-owned tables — RLS will filter them out

`TENANCY.md:76` / `ADR-0015:42` present `runAsPlatform(fn)` as the one crossing point. But the app
connects as `patchgrid_app`, which has **no `BYPASSRLS`** (`ARCHITECTURE.md:264`). Inside
`runAsPlatform` there is by definition no `app.current_org_id`, so every tenant-owned table returns
zero rows and every write is rejected by `WITH CHECK`.

Everything that actually needs the escape hatch touches tenant-owned tables:

| Operation | Table | Class | Org known in advance? |
| --- | --- | --- | --- |
| Org picker: list my memberships | `Membership` | T | **no** — that's the question being asked |
| Accept an invite from `app.patchgrid.xyz` | `Invitation` | T | **no** — only the token is known |
| Authenticate `Authorization: Bearer pg_…` | `ApiToken` | T | **no** — only the prefix is known |
| Support session lookup for the banner | `SupportSession` | T | yes |
| `org-purge` hard delete | all T tables | T | yes |
| Platform admin reading content in a session | all T tables | T | yes |

The last three are fine — the org is known, so `runAsPlatform` can simply *set the context to that org*
and everything works with no bypass at all. The first three are genuine chicken-and-egg: you need a
cross-tenant read to discover which tenant you are in.

**Recommendation** — two mechanisms, named differently so they are not confused:

- **`runAsTenant(orgId, fn)`** — sets `app.current_org_id` to an org the caller is not bound to by the
  request. Covers purge, support sessions, per-tenant dispatch, provisioning. **No bypass, no second
  role.** This should be the overwhelmingly common case and should be the one that is "allowed in three
  places".
- **The three lookup problems are solved by making the org discoverable from the credential**, not by a
  bypass:
  - *Invitations*: token is `<orgId-b36>.<secret>`; the API parses the org, calls
    `runAsTenant(orgId, …)`, then verifies the secret against `tokenHash`. Wrong org ⇒ no row ⇒ generic
    "invalid or expired invite".
  - *API tokens*: same shape — `pg_<orgSlugOrId>_<prefix>_<secret>`, or keep `pg_<prefix>_<secret>` and
    add a tiny **platform-class** index table `ApiTokenIndex { prefix (unique), orgId }` written in the
    same transaction as the `ApiToken` row. The index leaks nothing (a prefix and an org id), and
    `ApiToken` itself stays tenant-owned with its policy intact.
  - *Membership list for the org picker*: this one genuinely needs a cross-tenant read of a tenant-owned
    table. Cleanest fix: **reclassify `Membership` as platform-class with a policy** —
    `USING (orgId = current_setting(...)::uuid OR current_setting('app.platform_scope', true) = 'membership')`
    is ugly. Better: keep `Membership` tenant-owned and add a narrow platform-class projection
    `UserOrgIndex { userId, orgId, role, status }` maintained in the same transaction as `Membership`.
    Login reads only that. It is denormalisation, but it is the *only* denormalisation, it is 4 columns,
    and it keeps `patchgrid_app` free of `BYPASSRLS` — which is the property the whole ADR-0015 story
    rests on.

If you would rather not carry two projection tables, the alternative is a second DB role
`patchgrid_platform` **with** `BYPASSRLS`, used by exactly one injectable (`PlatformRepository`), on a
separate connection pool, with an ESLint rule and a CI test on its call sites. That is the pragmatic
industry answer. It is weaker — the app *can* now disable its own isolation — so it needs its own ADR
stating that trade honestly.

**Either way this needs an ADR (0022) before M1.** It is the single largest unresolved question in the
spec.

## P0-4 · Foreign keys bypass RLS, so cross-tenant references are possible

Not mentioned anywhere in `ADR-0015` or `TENANCY.md` §7.

PostgreSQL performs referential-integrity checks with the privileges of the referenced table's owner and
**with row security disabled**. That is documented behaviour, and it punches a hole in the four-layer
model:

```sql
-- as patchgrid_app, with app.current_org_id = <org B>
INSERT INTO "Comment" ("orgId", "ticketId", "authorId", body, visibility)
VALUES ('<org B>', '<a ticket id belonging to org A>', '<me>', 'hello', 'PUBLIC');
```

- The FK check on `ticketId` → `Ticket(id)` **passes** (RI ignores RLS).
- `WITH CHECK` on `Comment` **passes** (`orgId` is my own org).

The row is written: a comment in org B attached to org A's ticket. RLS never sees a violation because
every individual row is correctly tenanted. A later `include: { ticket: true }` returns `null` for the
ticket and the UI shows an orphan; a badly written raw join leaks content.

It is also an existence oracle: FK violations vs. successes tell you which ticket ids exist in other
tenants.

**Recommendation — composite foreign keys everywhere.** Every tenant-owned parent gets
`@@unique([orgId, id])`, and every child references the pair:

```prisma
model Ticket {
  id    String @db.Uuid
  orgId String @db.Uuid
  // ...
  @@id([id])
  @@unique([orgId, id])          // makes the composite FK target legal
}

model Comment {
  orgId    String @db.Uuid
  ticketId String @db.Uuid
  ticket   Ticket @relation(fields: [orgId, ticketId], references: [orgId, id])
  // ...
}
```

Now the database *structurally* cannot hold a cross-tenant reference — no policy, no trigger, no
application code involved. This is the piece that turns "four layers of filtering" into "the shape of
the data is correct by construction", and it is exactly the advanced-schema-design work you asked for.

Apply it to: `Comment`, `Attachment`, `TicketLink` (both ends), `TicketAsset`, `TicketWatcher`,
`ProblemDetails`, `ChangeDetails`, `ChangeApproval`, `Category.parentId`, `Category.defaultTeamId`,
`Ticket.categoryId`, `Ticket.teamId`, `Ticket.slaPolicyId`, `Membership.teamId`, `Team.leadId`,
`Invitation.teamId`, `Notification.ticketId`, `KnowledgeArticle.categoryId`, `ApiToken.membershipId`,
and every later-milestone table keyed by `ticketId`.

Add assertion #10 to the isolation suite: *every FK between two tenant-owned tables is composite on
`orgId`* — enumerable from `information_schema`, so it is a one-off test that can never silently rot.

## P0-5 · People are referenced by `User.id`, so nothing enforces "is a member of this org"

`ARCHITECTURE.md:169-199` — `Ticket.requesterId`, `Ticket.assigneeId`, `Comment.authorId`,
`TicketWatcher.userId`, `Asset.ownerId`, `Notification.userId`, `AuditLog.actorId`,
`ChangeApproval.approverId`, `KnowledgeArticle.authorId` all point at `User`, which is a **platform**
table with no RLS policy.

Two consequences:

1. **Nothing prevents assigning a ticket to a non-member.** `User` is global. A repository bug, a
   crafted request that slips past validation, or an id copied from another tenant will happily write
   `assigneeId = <someone in another company>`. RLS cannot catch it (the `Ticket` row's own `orgId` is
   correct). P0-4's composite FKs do not catch it either, because `User` has no `orgId`.
2. **Any join to `User` is unprotected.** A forgotten `where` on a `User` query returns every user of
   every customer, with emails. `User` is the one table where a leak is maximally embarrassing.

**Recommendation.** Reference **`Membership`**, not `User`, wherever the field means "a person *in this
org*" — which is all of them except `AuditLog.actorId` when the actor is a platform admin:

- `Ticket.requesterMembershipId`, `assigneeMembershipId` → composite FK `(orgId, id)` on `Membership`.
- Same for `Comment.authorMembershipId`, `TicketWatcher.membershipId`, `ChangeApproval.approverMembershipId`,
  `Asset.ownerMembershipId`, `KnowledgeArticle.authorMembershipId`.
- `Notification` keeps `userId` (delivery is to a person) **and** gains `membershipId`.
- `AuditLog` gets `actorMembershipId?` **plus** `actorPlatformAdminId?` plus `actorKind` — never a bare
  `userId`, so "who did this" is unambiguous for humans, service accounts and platform admins alike.

Now "the assignee is a member of this org" is a foreign-key constraint, not a hope. It also makes the
service-account story from ADR-0021 fall out for free: a token is bound to a `Membership`, so it can be
a requester/assignee/comment author with zero special-casing.

Cost: displaying a name requires joining `Membership → User`. That join is now always org-scoped, which
is the point. Keep a denormalised `Membership.displayName` if you want to avoid the `User` join on hot
list queries — and that also fixes the "deleted user" display problem.

**This and P0-4 together are the single highest-value change in this review.** They convert two whole
classes of bug from "caught by tests if we remember" to "rejected by the database".

## P0-6 · `FORCE ROW LEVEL SECURITY` means the owner does *not* bypass RLS

`ADR-0015:48` — "Migrations and seeds run as the owner role, **which bypasses RLS by ownership**".

This is factually wrong given `ADR-0015:31`, which (correctly) specifies `FORCE ROW LEVEL SECURITY`.
`FORCE` exists precisely to make the table owner subject to policies. Only superusers and roles with
`BYPASSRLS` are exempt, and the migration owner is neither by default.

Consequences if left as written:

- Any data migration (backfill, column rename with a copy step) silently affects **zero rows**.
- `TRUNCATE` in the integration-test harness (`ENGINEERING.md:50`) fails or no-ops.
- The seed works only because `ADR-0015:48` also says it sets tenant context per org — but the
  justification given for why it *could* work without that is wrong, and someone will rely on it.

**Recommendation.** Fix the sentence, and decide explicitly:

- Give the migration owner role `BYPASSRLS` (it is a break-glass role used from a separate
  `DATABASE_MIGRATION_URL`, never by the app) — simplest and honest; **or**
- Keep it without `BYPASSRLS` and require every data migration to loop per org setting the context —
  more faithful, materially more painful.

Recommend the first, and add to `ENGINEERING.md` that the config validator already refuses to start when
`DATABASE_URL == DATABASE_MIGRATION_URL` (`ENGINEERING.md:106` — good, keep it) and that the app role is
asserted at boot to lack `BYPASSRLS` (`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`).
That boot assertion is cheap and turns a catastrophic misconfiguration into a startup failure.

## P0-7 · `patchgrid_app` will not see tables created by future migrations

Nowhere in `ARCHITECTURE.md:254`, `ENGINEERING.md:106` or `ADR-0015`.

The app role owns nothing, so it needs explicit `GRANT`s. Grants apply to tables that exist *at the time
they are issued*. Every `prisma migrate` that adds a table creates it owned by the migration role, with
no privileges for `patchgrid_app` — so the app gets `permission denied for table X` the moment the
feature ships, and only in whichever environment ran the migration.

**Recommendation.** In the Postgres init script, alongside role creation:

```sql
GRANT USAGE ON SCHEMA public TO patchgrid_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO patchgrid_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO patchgrid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE patchgrid_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO patchgrid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE patchgrid_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO patchgrid_app;
```

`ALTER DEFAULT PRIVILEGES` is the line that makes it survive future migrations, and it must name the
role that *creates* the objects. Add an isolation-suite assertion: for every tenant-owned table,
`has_table_privilege('patchgrid_app', t, 'SELECT')` is true — so a missing grant fails CI rather than
production.

Also note: the Compose init script only runs on an **empty** data volume. Developers with an existing
volume will not get these. Ship the same statements as an idempotent SQL file run by `db:migrate` too.

## P0-8 · Prisma `DateTime` is not `timestamptz`

`DOMAIN.md:100` — "All timestamps UTC". `ENGINEERING.md:32` — "Timestamps are ISO-8601 UTC strings on
the wire."

Prisma's default mapping for `DateTime` on PostgreSQL is `timestamp(3)` — **without** time zone. Every
SLA comparison, every `pausedAt` arithmetic, every `now() >= resolveBy` in the scanner then depends on
the session `TimeZone` of whichever connection ran it, and on the server's local time in raw SQL.

**Recommendation.** Every datetime column is `@db.Timestamptz(3)`, stated once in `ENGINEERING.md` as a
rule and enforced by an introspection test (`SELECT ... FROM information_schema.columns WHERE data_type
= 'timestamp without time zone'` must return zero rows). Also set `TimeZone=UTC` on both connection
strings. This is a five-minute fix now and a data-corruption archaeology project later.

## P0-9 · UUID v7 has no generation story on PostgreSQL 17

`ARCHITECTURE.md:145` — "Every table has `id` (UUID v7)". `ARCHITECTURE.md:13` — PostgreSQL 17.

Native `uuidv7()` landed in PostgreSQL **18**. On 17 there is no built-in generator, so ids must come
from the application, which means `@default(dbgenerated("gen_random_uuid()"))` (v4, not v7 — loses the
time-ordering that is the entire reason to pick v7) or an app-side generator.

**Recommendation.** Decide and write it down:

- Pin whether the Prisma version you use supports `@default(uuid(7))` (it is a recent addition —
  **verify against the version you install, do not assume**), and if so use it; otherwise generate in
  the repository layer with the `uuidv7` package and forbid `@default(uuid())`.
- Declare every id `String @db.Uuid` — not `text`. The RLS policies cast `current_setting(...)::uuid`,
  so a `text` `orgId` column would compare `text = uuid` and fail to plan against the index.
- Write it up as a short ADR (id strategy + `timestamptz` + `@db.Uuid`) so the three decisions travel
  together.

Also worth stating the *reason* for v7 explicitly, since it is a real design point: time-ordered ids
keep B-tree inserts at the right edge (no page splits across the whole index) and make
`(orgId, createdAt DESC, id DESC)` cursors monotonic.

## P0-10 · The RLS policy expression throws on an empty-string setting

`ADR-0015:31`:

```sql
USING ("orgId" = current_setting('app.current_org_id', true)::uuid)
```

`current_setting(x, true)` returns `NULL` when the GUC was never set → `NULL::uuid` is `NULL` →
comparison is `NULL` → no rows. **Fail-closed, correct.**

But if anything ever calls `set_config('app.current_org_id', '', true)` — which is exactly what a
`?? ''` or a `String(undefined ?? '')` in the extension produces — then `''::uuid` raises
`invalid input syntax for type uuid: ""`, and every query in that transaction dies with a 500 instead of
returning zero rows.

**Recommendation.** Write the policy defensively and standardise it:

```sql
USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
```

Generate the policies from a single template so all ~30 tables are identical, and add the exact template
to `ADR-0015`. Add an isolation-suite case: with the GUC set to `''`, tenant-owned reads return zero rows
(not an error).

## P0-11 · "Wrap every query in a transaction" collides with `withTransaction`

`ADR-0015:25` — the extension wraps **every** operation in a transaction.
`ENGINEERING.md:39-40` — services call `withTransaction(fn)`; "nested `withTransaction` calls reuse the
outer one".

Prisma's interactive-transaction client (`tx`) does **not** expose `$transaction`. So if the extension
runs on a tx-scoped client it will try to open a nested transaction and throw at runtime. The docs say
nesting is reused but never say *how the extension knows*.

**Recommendation.** Specify the mechanism in `ADR-0015`:

- CLS holds `{ orgId, tx?: Prisma.TransactionClient }`.
- `withTransaction(fn)` opens `$transaction`, immediately runs
  `SELECT set_config('app.current_org_id', $1, true)`, stores the tx client in CLS, runs `fn`, clears it.
- The `$allOperations` extension checks CLS: if a tx is already active it **passes through untouched**;
  only if there is none does it open its own single-statement transaction (and set the GUC first).

Three more things to write down while you are there:

1. **Raw queries.** Verify in your Prisma version whether `$queryRaw` / `$executeRaw` pass through a
   `query: { $allOperations }` extension. If they do not, raw SQL silently skips layer 3 and is protected
   only by RLS. Either way, ban raw SQL outside `packages/database` and the RLS migrations with an ESLint
   rule, and add an isolation-suite case that a raw query without context returns zero rows.
2. **Connection cost.** One interactive transaction per query means one pooled connection held for the
   full round trip, and Prisma's defaults (`maxWait: 2000ms`, `timeout: 5000ms`) now apply to *every*
   query. An N+1 in a list endpoint becomes N transactions and will exhaust the pool long before it
   becomes slow. Mitigation to state as a rule: **one logical read = one repository call = one
   transaction**; list endpoints use `include`/`select`, never per-row follow-ups. Add `p95 queries per
   request` to the log line so regressions are visible.
3. **Fail-closed property is worth stating.** `set_config(..., true)` outside a transaction applies only
   to the current statement, so if the extension ever fails to open a transaction, the GUC evaporates and
   RLS returns zero rows rather than everything. That is the behaviour you want; say so, so nobody
   "fixes" it.

## P0-12 · Category names cannot be unique per org

`CLAUDE.md` and `ARCHITECTURE.md:214` — "Uniqueness is per-org … for ticket numbers, team names,
**category names**, asset serials and KB slugs."
`DOMAIN.md:143` — a 3-level tree, `Hardware → Laptop → Screen Replacement`.

A real 3-level taxonomy has `Hardware → Other`, `Software → Other`, `Access → Other`. A per-org unique
constraint on `name` makes that illegal, which will be discovered while writing the default category
tree in M1 provisioning.

**Recommendation.** `@@unique([orgId, parentId, name])`. Note the Postgres subtlety: `NULL` parents (root
categories) do not collide under a plain unique index, because `NULL != NULL`. Either use a sentinel
root, or add a partial unique index for roots:

```sql
CREATE UNIQUE INDEX category_root_name ON "Category" ("orgId", name) WHERE "parentId" IS NULL;
```

Fix the sentence in `ARCHITECTURE.md:214` and in `CLAUDE.md` at the same time — both currently state the
wrong rule.

## P0-13 · Presigned **PUT** cannot enforce a content-length *range*

`ADR-0005:21` — "returns a presigned PUT (5-minute TTL, content-type and **content-length conditions**)".

S3 presigned **PUT** URLs sign headers; they cannot express a *range*. `content-length-range` is a
condition of a presigned **POST policy** (the multipart form flavour), not of `PUT`. As written, the
plan implies a guarantee the mechanism cannot give: a client can PUT a 5 GB file to a URL issued for a
2 MB upload, and you discover it at the `HEAD` in step 3 — after the bytes are already stored and paid
for.

**Recommendation.** Pick one and state it precisely:

- **Sign an exact `Content-Length`** (the client already declares `sizeBytes` in the presign request).
  Signing the header makes that exact value mandatory — not a range, but a hard bound, which is what you
  actually want. Also sign `Content-Type` so the declared MIME cannot be swapped.
- Or switch to **presigned POST** with a real `content-length-range` policy.

Keep the `HEAD` verification in step 3 regardless. Also add: the `PENDING`-cleanup job must delete the
*object* as well as the row, and the storage `UsageCounter` must decrement on attachment delete and on
ticket/org purge — neither is currently specified anywhere.

## P0-14 · The attachment MIME allow-list permits stored XSS

`DOMAIN.md:165` — "allow-listed MIME types (images, PDF, text/log, office docs, `.zip`)".
`ADR-0005:33` — "Inline image preview in comments uses the same presigned GET".

`image/svg+xml` is an image. An SVG is an HTML document that can execute script. Served from the MinIO /
S3 origin with a presigned GET and rendered inline, it is stored XSS — and in an ITSM product the
attachments are, by design, *files users were suspicious of* (see the phishing-report feature).

**Recommendation.**

- Exclude `image/svg+xml` from the allow-list explicitly (and `text/html`, `application/xhtml+xml`).
- Sniff the actual bytes server-side at the `complete` step (magic-number check) instead of trusting the
  declared `Content-Type`; reject on mismatch.
- Set `response-content-disposition=attachment` on every presigned GET **except** for a small inline
  allow-list (`image/png|jpeg|gif|webp`), and set `response-content-type` to the sniffed type rather than
  the stored one.
- Serve attachments from a dedicated origin (`files.patchgrid.xyz` / the MinIO host), never from
  `*.patchgrid.xyz` — otherwise an HTML attachment is same-site with the session cookie. Worth adding
  `files` to the reserved-subdomain list.
- Record the deferred item: antivirus scanning (ClamAV in Compose, scan on `PENDING → READY`). For a tool
  whose users upload suspected-malicious files, "we never scan uploads" deserves to be an explicit,
  written non-goal with a reason, not an omission.

---

# Part 2 — P1: correctness bugs in the domain rules

## P1-1 · A priority change after a reopen silently wipes the fresh SLA clock

`DOMAIN.md:125` — priority change: `resolveBy = createdAt + newResolutionTarget + pausedMinutes`
`DOMAIN.md:127` — reopen: "fresh clock: `resolveBy = now + resolutionTarget`, `pausedMinutes = 0`"

Sequence: ticket created day 1 → resolved → reopened day 30 (fresh 24 h clock from now) → an agent
raises the urgency. The recompute rule resets `resolveBy` to `createdAt + newTarget + 0`, i.e. day 2 —
**29 days in the past**. The ticket is instantly, permanently breached and the scanner fires a breach
notification for a ticket that was reopened four minutes ago.

Root cause: two rules use different clock origins (`createdAt` vs `now`) and neither stores which one is
current.

**Recommendation.** Add `resolutionClockStartedAt` (and `responseClockStartedAt`) to `Ticket`, defaulting
to `createdAt` and reset to `now` on reopen. Then **every** rule is uniform:

```
resolveBy = resolutionClockStartedAt + resolutionTargetMinutes + pausedMinutes
respondBy = responseClockStartedAt  + responseTargetMinutes
```

The priority-change row, the reopen row and the pause-resume row all become the same formula, which also
makes the pure SLA function trivially testable. Update `DOMAIN.md` §4.2 to state the invariant once and
derive each row from it, rather than listing six independent recipes.

## P1-2 · One `warningThresholdMinutes` for two clocks at different scales

`DOMAIN.md:105,110-115` — a single `warningThresholdMinutes` per policy, seeded as 15 min for Critical
(response target 15 min, resolution target 4 h) and 120 min for Low (response 4 h, resolution 72 h).

For Critical the response warning fires at t=0 — the moment the ticket is created, `now >= respondBy -
15min` is already true. The first thing a Critical incident does is emit a warning notification for a
clock that has not started ticking. For Low, the response warning fires 2 h into a 4 h target while the
resolution warning fires 2 h before a 72 h target; the same number means completely different things.

**Recommendation.** Split into `responseWarningMinutes` and `resolutionWarningMinutes`, or express the
warning as a percentage of target (e.g. 80 %). Percentages scale automatically and are one field.
Suggested defaults if you keep absolute minutes:

| Priority | Response | Resp. warn | Resolution | Res. warn |
| --- | --- | --- | --- | --- |
| Critical | 15 min | 5 min | 4 h | 45 min |
| High | 30 min | 10 min | 8 h | 1 h |
| Medium | 1 h | 15 min | 24 h | 2 h |
| Low | 4 h | 1 h | 72 h | 4 h |

Also add the guard explicitly: never warn when `warningAt <= createdAt`.

## P1-3 · "Four default SLA policies" contradicts the uniqueness key

`DOMAIN.md:108` — unique `(orgId, ticketType, priority)`; §4 applies to `INCIDENT` **and**
`SERVICE_REQUEST` → 2 types × 4 priorities = **8** policies.
`TENANCY.md:40` and `ADR-0017:30` — provisioning seeds "the **four** default SLA policies".

Pick one. Recommend seeding all 8 (same numbers for both types initially) — it makes the per-type key
meaningful and lets an admin loosen SR targets without touching incidents, which is the normal real-world
first customisation.

## P1-4 · The Incident/SR transition table omits `IN_PROGRESS → CANCELLED`

`DOMAIN.md:32` (diagram) implies cancel from `NEW`, `ASSIGNED` and a third column;
`DOMAIN.md:44` (table) lists only `NEW / ASSIGNED / PENDING → CANCELLED`.

So an agent who starts work and then discovers the ticket is spam, a duplicate, or was raised by mistake
has no exit except resolving it — which pollutes SLA and resolution statistics, the exact numbers the
product exists to report on. Also note that duplicate-merge (`DOMAIN.md:198`) explicitly closes the
duplicate as `CANCELLED`, and a duplicate is usually spotted *while working it*.

**Recommendation.** Allow `IN_PROGRESS → CANCELLED` for Agent/Admin with a required reason comment. While
you are in there, settle the rest of the table's silent denials explicitly rather than by omission:
`PENDING → RESOLVED` (recommend: deny, must resume first), `RESOLVED → CANCELLED` (deny),
`CANCELLED → anything` (deny — terminal, full stop), `CLOSED → CANCELLED` (deny).

## P1-5 · The 30-day reopen window is stated in prose but absent from the transition table

`DOMAIN.md:43` — `RESOLVED / CLOSED → IN_PROGRESS (via reopen)` with no time bound.
`DOMAIN.md:84` — "`CLOSED` Incidents / Service Requests can be reopened within **30 days** of `closedAt`".

The transition table is the thing that becomes code (ADR-0002: `TRANSITIONS: Record<...>`), so a guard
that lives only in prose will not be implemented. Add `closedAt + 30d >= now` as an explicit **guard**
column on that row, and make the table's shape uniform: `(type, from, action, to, actors, guards,
effects)`. Every other type's rules should be expressed in the same table — §2.2 (Problem) is currently
prose-only, which is a rigour gap in the one document that maps 1:1 to a data structure.

## P1-6 · Changes can deadlock in a small organisation

`DOMAIN.md:73` — approval by "**Admin, or the lead of the change's team** — never the change's own
requester or assignee".

In a freshly provisioned org there is exactly one member: the OWNER. They create a Change. There is no
other Admin and no team lead. The Change can never leave `AWAITING_APPROVAL`. The same deadlock occurs in
any org with a single admin, which is most orgs on the FREE plan (3 agent seats).

Also unspecified: a Change with **no team** has no lead, so only Admins can approve it — fine, but say so.

**Recommendation.** Add an explicit escape and audit it loudly:

- If no eligible approver other than the requester exists in the org, an `OWNER` may self-approve, and
  the `ChangeApproval` row records `selfApproved: true`. The UI shows it as such; it appears in the audit
  log as a distinct action. That is how real CAB-less shops operate, and it is more honest than a hidden
  bypass.
- Alternatively, block *submission* with a 409 explaining that a second admin is required. Worse UX;
  it makes the very first Change in a new workspace fail.

Recommend the first. Either way `DOMAIN.md` §2.3 and the `ticket:approve_change` matrix row must say it.

## P1-7 · "Warn, don't block" on early change start has no mechanism

`DOMAIN.md:75` — "`APPROVED → IN_PROGRESS` … Not before `plannedStart` minus 1 hour (warn, don't block,
in v1)".

There is no way for a `200 OK` in the current API contract to carry a warning. Problem Details is for
errors only (ADR-0012).

**Recommendation.** Either drop the warning in v1 (cleanest), or add a general mechanism you will want
anyway: successful mutation responses may carry `warnings: [{ code, detail }]`, declared once in
`packages/contracts`. A `confirm: true` body flag that turns a soft block into an accepted action is the
other standard pattern, and is more useful — it gives the UI a real "start early?" dialog. Pick one and
put it in `ENGINEERING.md` §API conventions.

## P1-8 · `TicketLink` has inverse relations, no uniqueness, no self-link guard

`ARCHITECTURE.md:183` — `relation: CAUSED_BY|CAUSES|RELATES_TO|RESOLVED_BY|DUPLICATE_OF`, no constraints.

Problems, all concrete:

- `CAUSES` and `CAUSED_BY` are the same fact in two directions. Nothing stops both rows existing, or
  existing with contradictory endpoints. Every query must then check both directions.
- No `@@unique([orgId, fromTicketId, toTicketId, relation])` → the same link can be added ten times.
- No `fromTicketId != toTicketId` check → a ticket can be its own cause.
- `DUPLICATE_OF` can form cycles (A dup of B, B dup of A) — the merge feature in `DOMAIN.md:198` would
  loop.
- `RELATES_TO` is symmetric; storing it once and rendering both sides is correct, storing it twice is not.

**Recommendation.**

- Store one **canonical direction per relation** and derive the inverse for display. Concretely: keep
  `CAUSED_BY` (incident → problem), `RESOLVED_BY` (problem → change), `DUPLICATE_OF` (duplicate →
  survivor), `RELATES_TO` (symmetric, stored with `fromTicketId < toTicketId` as a normalisation rule).
  Delete `CAUSES` from the enum — it is `CAUSED_BY` read backwards. Update `DOMAIN.md:11-14` which
  currently lists both.
- Add the unique constraint, a `CHECK (fromTicketId <> toTicketId)`, and a service-level guard that
  `DUPLICATE_OF` targets are not themselves duplicates (follow to the survivor instead).
- Composite FKs on both ends per P0-4.

## P1-9 · `Comment.authorId` is non-nullable but system comments have no author

`ARCHITECTURE.md:186` — `Comment { …, authorId, …, isSystem }`.

`isSystem` comments (the merge note in `DOMAIN.md:198`, automation's `ADD_INTERNAL_NOTE` in
`DOMAIN.md:199`, the auto-close note) have no human author. Either they get a fake author (which then
appears in the UI as a person who did not write it — and, under P0-5, must be a real membership), or
`authorId` must be nullable.

**Recommendation.** `authorMembershipId String?` plus a non-null `authorKind: MEMBER | SERVICE | SYSTEM |
AUTOMATION`, and a `CHECK` that `authorKind = 'MEMBER'` implies the membership is present. The same shape
should be used for `AuditLog.actorId` (already nullable — good) so "who did this" is one consistent
pattern across the schema.

## P1-10 · Comment editing has no `editedAt`, and deletion has no shape

`RBAC.md:100` — `comment:update_own` with a 15-minute window.
`RBAC.md:101` — `comment:delete` for Admin/Owner.
`DOMAIN.md:166` — the audit log records "comment added (id only, not body)".

Missing from the data model and the rules:

- No `editedAt` / `editCount` on `Comment`, so the 15-minute window has nothing to measure against
  except `createdAt` (workable) and the UI cannot show "edited" (not workable).
- No audit action for a comment edit or delete. `RBAC.md` §12 lists none, `DOMAIN.md:166` lists none.
  An admin can silently delete the comment that proves something — in an audit-focused product.
- Hard delete leaves the audit row pointing at a nonexistent id.

**Recommendation.** `editedAt?`, `deletedAt?`, `deletedByMembershipId?`; delete is **soft**, rendered as
"comment removed by an admin"; `COMMENT_EDITED` and `COMMENT_DELETED` join the audit catalogue with the
previous body stored in the audit `diff` (it is already "never deleted"). Also state whether editing a
comment that resumed a `PENDING` ticket re-triggers anything (recommend: no).

## P1-11 · Last-owner protection is not safe under concurrency

`RBAC.md:41` / `TENANCY.md:8` (`ownerCount`) — "the last owner cannot be demoted, disabled, removed, or
leave."

Two owners, two simultaneous requests, each demoting the other. Both transactions read `ownerCount = 2`,
both conclude "not the last owner", both commit. The org now has **zero owners** and nobody can change
the plan, the slug, or grant support access. There is no recovery path in the spec short of a platform
admin intervention that is not specified either.

The same race exists for: seat quota at the limit (two invites accepted simultaneously), ticket quota at
the limit, and the two-step ownership transfer.

**Recommendation.** State a general rule in `ENGINEERING.md` §Transactions and apply it consistently:

> Any invariant over a *set* of rows (owner count, seat count, monthly ticket count) is enforced by
> taking a row lock on the owning `Organization` row (`SELECT … FOR UPDATE`) inside the same transaction
> as the mutation, or by a deferred constraint. Never by read-then-write.

Concretely for owners: `SELECT * FROM "Organization" WHERE id = $1 FOR UPDATE` first, then count owners,
then mutate. It serialises org-level membership changes, which happen a few times a day — free.

Also decide what `ownerCount` is for. If it is a cached counter it is another thing to drift; if the
lock+count is the mechanism, drop `ownerCount` from `TENANCY.md:8` (it is already absent from
`ARCHITECTURE.md:148`, so the two docs disagree anyway — see D-1).

## P1-12 · Quota checks are check-then-act

`TENANCY.md:94` — "`QuotaService` checks limits at the point of action … Counters are cached in Redis and
reconciled nightly."

Two problems:

1. **Race.** Same shape as P1-11: two concurrent ticket creations at 199/200 both pass the check.
2. **Redis as the source of truth.** Redis is configured for BullMQ and throttling; if it is evicted,
   restarted without persistence, or flushed, every counter resets to zero and every tenant is
   effectively unlimited until the nightly reconcile. The spec never says Postgres is authoritative.

**Recommendation.** `UsageCounter` in Postgres is the source of truth; Redis is a read-through cache with
a short TTL for *display*. The enforcing increment is
`UPDATE "UsageCounter" SET value = value + 1 WHERE … AND value < $limit RETURNING value` inside the
mutation's transaction — zero rows returned means over limit, `402`, and the transaction rolls back
atomically with the ticket that was not created. Also specify:

- `period` format — recommend `YYYY-MM` in **UTC**, stated in `ARCHITECTURE.md:200`.
- Metrics enumerated: `tickets_created`, `agent_seats`, `storage_bytes`, `automation_rules`,
  `kb_articles`.
- Which are **point-in-time** (seats, storage, rules, articles — computable, so reconcilable) vs
  **cumulative per period** (tickets — not recomputable if rows are deleted; note it).
- What happens on **downgrade** below current usage (Q-6).

## P1-13 · A released slug can be re-registered by a different company

`TENANCY.md:22` — old slug kept in `OrganizationSlugHistory` and "301-redirects for **30 days**".

After 30 days, either the history row is deleted (freeing the slug) or kept (blocking it). The spec does
not say. If freed:

- Every 301 already cached by a browser is **permanent** — that is what 301 means. A user who visited
  `oldname.patchgrid.xyz` will be redirected to the new org by their own browser cache, forever.
- Conversely, a third party can register the freed slug and receive traffic, bookmarks and — worse —
  *emailed deep links* intended for the previous tenant. Combined with the shared `.patchgrid.xyz` cookie
  domain, that is a cookie-tossing and phishing position.

**Recommendation.**

- Use **302/307**, not 301, so nothing is cached permanently. Add a one-page interstitial or a banner
  ("this workspace moved to …") rather than a silent redirect.
- Keep `OrganizationSlugHistory` rows **forever** and exclude them from slug availability, permanently.
  A slug is never reused. Storage cost is nil; the class of bug it prevents is severe.
- Add `previousSlugRedirectUntil` so the redirect stops after 30 days but the *reservation* does not.

## P1-14 · `inbound` is used as a hostname but is not reserved

`ADR-0018` — inbound email address `<slug>@inbound.patchgrid.xyz`.
`TENANCY.md:21` / `ADR-0014:36` — reserved list has no `inbound`.

A tenant can register the slug `inbound`, taking `inbound.patchgrid.xyz`. Also missing and worth adding:
`files`, `assets` is present but `attachments` is not, `mx`, `ns`, `ns1`, `ns2`, `autodiscover`,
`autoconfig`, `_domainkey`, `dmarc`, `email`, `webhook`, `webhooks`, `cdn` (present), `static` (present),
`go`, `my`, `id`, `sso`, `oauth`, `well-known`, `patchgrid`, `official`.

**Recommendation.** Move the reserved list out of prose into `packages/contracts` as a single exported
`RESERVED_SLUGS` set with a comment explaining each group (infrastructure, mail, auth, brand). It is
referenced by three documents and two applications; it must have exactly one definition. Add a rule: any
new public hostname requires adding its label to that set in the same PR.

## P1-15 · Ticket search is completely unspecified

`RBAC.md:52` mentions "list queries and search"; `DOMAIN.md:191` specifies full-text search for the
**knowledge base** only. `FEATURES.md` M2 §Console lists queues and filters but no search.

An agent console without ticket search is not usable, and adding search after the fact touches the
schema (`tsvector` column + GIN index + trigger), the scope filter, the cursor pagination contract and
the index plan. It is not a "polish" item.

**Recommendation.** Decide now, even if you build it in M2/M5:

- `Ticket.searchVector tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || description))
  STORED`, GIN index `(orgId, searchVector)`. (A generated column avoids a trigger; note that the
  `english` config is hard-coded — state that multilingual search is out of scope.)
- Ticket **number** lookup (`INC-000042`, or bare `42`) short-circuits to a direct index hit.
- Search results go through the same `scopeFor()` filter as lists — say so explicitly, because a
  search endpoint that forgets it is the classic agent-visibility leak.
- Ranking + cursor pagination interact badly (`ts_rank` is not a stable sort key). Recommend: search is
  `ORDER BY ts_rank DESC, id DESC` with an offset cap of 100 results, *not* cursor-paginated, and say so
  in `ADR-0012` as the documented exception.

## P1-16 · The index plan does not cover the default list query or the audit filters

`ARCHITECTURE.md:216-217`.

- The default ticket list is `ORDER BY createdAt DESC` with a keyset cursor of `(sortValue, id)`
  (`ADR-0012:22`). There is no `Ticket(orgId, createdAt DESC, id DESC)` index, so the most common query
  in the product does a sort.
- `RBAC.md:212` — the audit log is "filterable by actor, action and date", but the only index is
  `AuditLog(orgId, entityType, entityId, createdAt)`, which serves none of those three filters.
- `OWN_TEAM_ONLY` scope (`RBAC.md:50`) is an `OR` of four conditions (team, unassigned team, assignee,
  watcher). Postgres will not use a single composite index for an `OR` across different columns; it will
  either bitmap-or several indexes or seq-scan. On a large tenant this is the query that gets slow first.

**Recommendation.**

- Add `Ticket(orgId, createdAt DESC, id DESC)` and one index per supported `sort` value; state the rule
  "a sort option without a matching index is not a supported sort option".
- Add `AuditLog(orgId, createdAt DESC, id DESC)`, `AuditLog(orgId, actorMembershipId, createdAt DESC)`,
  `AuditLog(orgId, action, createdAt DESC)`.
- Add `Comment(orgId, ticketId, createdAt)`, `Attachment(orgId, ticketId)`,
  `TicketWatcher(orgId, userId)` (for "tickets I watch"), `Invitation(orgId, email)`,
  `Notification(orgId, userId, readAt, createdAt DESC)`.
- For the `OWN_TEAM_ONLY` `OR`: plan to express `scopeFor()` as a `UNION ALL` of index-friendly branches
  rather than one `OR`, or (better, later) denormalise a `TicketAccess(orgId, ticketId, membershipId)`
  row set. Do not solve it now, but note it in `RBAC.md` §4 so the shape of `ScopeFilter` can accommodate
  "multiple branches" from the start instead of assuming a single `where` object. **That design choice
  is hard to change later and costs nothing now.**

## P1-17 · No optimistic concurrency on ticket updates

Two agents open the same ticket, both edit the description, last write wins silently. `409` is reserved
for "invalid transition or uniqueness conflict" (`ENGINEERING.md:34`) and nothing generates it for a
concurrent edit.

**Recommendation.** Add `version Int @default(0)` to `Ticket` (and `KnowledgeArticle`, which is worse —
markdown bodies edited by several agents). `PATCH` requires the client's `version`; mismatch → `409` with
a Problem Details `type` of `stale-write` that the UI turns into "someone else changed this ticket".
`@updatedAt` alone is not sufficient (millisecond collisions, clock skew). This is cheap now and
structurally awkward later because it changes the wire contract.

## P1-18 · The access token's 15-minute life defeats "instant" revocation

`ADR-0004` — 15-minute access token, stateless verification.
`TENANCY.md:58` — "Disabling a membership revokes that organization's sessions only."
`RBAC.md:169` — support access: "Any owner can revoke **instantly**."
`ADR-0021` — token revocation.

Revoking refresh tokens does nothing to an access token already in a browser. So "disabled" members keep
full access for up to 15 minutes, a revoked API token keeps working for up to 15 minutes, and "instant"
revocation of a support session is only instant if the session is re-checked per request (it probably is,
since it is a DB row — but that is not stated).

Fifteen minutes is a long time for someone who was just fired, which is a literal ITSM use case.

**Recommendation.** A revocation epoch in Redis, checked on every authenticated request:

- Key `rev:<membershipId>` → timestamp; the access token carries `iat`; reject if `iat < epoch`.
- Bump the epoch on: membership disable, role change, org suspend, password change, "log out everywhere",
  support-session revoke, API-token revoke.
- One Redis `GET` per request (already on the path for throttling), fail-**open** on Redis outage for
  reads but fail-closed for writes — state the choice explicitly either way.

This also fixes the role-change staleness problem: `GET /me` returns permissions, and today a promotion
or demotion is invisible for up to 15 minutes.

## P1-19 · `PENDING` auto-resume is ambiguous about who triggers it

`DOMAIN.md:40` — "`PENDING` → `IN_PROGRESS` … **or automatically when the requester adds a public
comment**".

Undefined: a **watcher** who is a requester (`RBAC.md:62` grants them `comment:create_public`) — do their
comments resume the clock? An agent's public comment while `PENDING` — does that resume it (it should
not)? A comment posted by an API service account on the requester's behalf?

**Recommendation.** State it as: *the ticket's own requester* (`requesterMembershipId`), and only a
`PUBLIC` comment, and only from `PENDING`. Everything else leaves the status alone. One sentence, but it
is the difference between an SLA number that means something and one that does not.

## P1-20 · Entering `PENDING` makes the "response clock unaffected" row unreachable

`DOMAIN.md:39` — entering `PENDING` "requires a public comment (the reason the requester must act)".
`DOMAIN.md:122` — the first public agent comment stops the response clock.
`DOMAIN.md:123` — "Status → `PENDING`: response clock **not affected** (agents must still respond)".

By construction, entering `PENDING` always emits a public agent comment, which always stops the response
clock in the same transaction. The §4.2 row can never be exercised. Not a bug in behaviour, but it is a
rule that will be unit-tested against a state that cannot occur, and it misleads the reader into thinking
a `PENDING` ticket can still breach its response target.

**Recommendation.** Delete the row or restate it as a note: "response is always satisfied by the time a
ticket reaches `PENDING`, because entry requires a public comment."

## P1-21 · KB visibility is a boolean in one doc and a three-value enum in two others

`DOMAIN.md:191` — "`isPublished`".
`ARCHITECTURE.md:196` — `visibility: PUBLISHED|INTERNAL|DRAFT`.
`RBAC.md:74` — `kb:read_published`, `kb:read_internal`, `kb:read_draft`.
`FEATURES.md:90` — "three-tier visibility".

Three-to-one; `DOMAIN.md` is the outlier. Fix `DOMAIN.md` §9. Also note that `RBAC.md:109` grants an
agent `kb:read_draft` for "own drafts" only, so `KnowledgeArticle.authorId` is load-bearing for
authorization — which means it must be `authorMembershipId` per P0-5.

## P1-22 · `Attachment` belongs to "a ticket **or** a comment" with nothing enforcing it

`ARCHITECTURE.md:187` — `ticketId?, commentId?`. `DOMAIN.md:165` — "exactly one".

Prisma cannot express this; it needs a raw `CHECK ((("ticketId" IS NULL) != ("commentId" IS NULL)))` in
the same hand-written SQL migration directory as the RLS policies. Also: a comment already belongs to a
ticket, so an attachment on a comment has a ticket by transitivity — the `ticketId` column should
probably always be populated (for the `org/<orgId>/tickets/<ticketId>/…` storage key and for
`Attachment(orgId, ticketId)` queries), with `commentId` optional on top. That is a cleaner model than an
exclusive-or.

**Recommendation.** `ticketId` always required, `commentId` optional, `CHECK` that the comment (when
present) belongs to the same ticket — expressible as a composite FK `(orgId, ticketId, commentId)` if you
add `@@unique([orgId, ticketId, id])` on `Comment`. Same trick as P0-4.

## P1-23 · `emailNotifications` is referenced but does not exist in the data model

`DOMAIN.md:171` — "email per the user's `emailNotifications` preference, default on".
`ARCHITECTURE.md:153` — `User { id, email, passwordHash, name, emailVerifiedAt?, lastLoginAt? }`. No such
field. Nor on `Membership`.

**Recommendation.** Put it on **`Membership`**, not `User`: a person who is an on-call agent at one
company and a requester at another wants different email behaviour in each. `Membership.emailPrefs Json`
or explicit booleans (`emailOnAssigned`, `emailOnPublicComment`, `emailOnSlaBreach`, `emailDigest`).
While you are there, add an org-level `Organization.emailNotificationsEnabled` kill switch — the first
thing an admin asks for when the desk gets noisy.

## P1-24 · Inbound email trusts the `From` header

`FEATURES.md:98-100` / `ADR-0018` — tenant resolution from the recipient address, threading by
`In-Reply-To`, bounce detection. Nothing about authenticating the **sender**.

`From:` is trivially forged. As written, anyone who knows a tenant's inbound address can create tickets
attributed to that tenant's CEO — in a system whose audit log is a selling point. Worse, threading by
`[INC-000042]` in the subject means a forged reply can post a **public comment on an existing ticket** as
someone else, which is a content-injection path into another company's incident.

**Recommendation.** Write it into ADR-0018 (or a new ADR for M6):

- Require the provider's SPF/DKIM/DMARC verdict (Resend/Postmark/SES all supply it); reject or quarantine
  anything that is not DMARC-aligned with the sender's domain.
- Map the sender to an **active `Membership` in the resolved org**. Unknown senders: drop by default, with
  an org setting to allow "create as an unverified external requester" with a visible badge — never
  silently attribute.
- For threading onto an existing ticket, require both the ticket reference **and** that the verified
  sender is a participant (requester, assignee, watcher, or an agent). Otherwise open a new ticket
  linked to the referenced one.
- Attachments from email bypass the browser presign flow entirely — ADR-0005 describes only the browser
  path. Specify the server-side ingest path (stream to S3 with the same key scheme, same allow-list, same
  size cap, same quota decrement).

## P1-25 · "Every read is audited" during a support session is unimplementable as literally stated

`RBAC.md:167` / `ADR-0020` — "**Every read** during a session is written to the tenant's own audit log".

A single ticket-list page load is one query returning 25 rows plus joins. Writing an audit row per
returned row means thousands of rows per session, inside the read transaction, and it makes the support
UI slower than the product. It also makes the customer's audit log unreadable — the thing that was
supposed to build trust becomes noise.

**Recommendation.** Audit at the **request** granularity, which is what a customer actually wants to
read:

```
SUPPORT_READ { sessionId, adminId, endpoint, entityType, entityIds[] (capped, e.g. 50),
               resultCount, filters, at }
```

One row per API call. `ADR-0020`'s implementation note (a `SupportSessionInterceptor`) is then correct
and cheap. Also specify: these writes must not be inside the read's transaction (a failed audit write
must not fail the read — but it *must* fail the session; recommend: buffered write, and the session is
terminated if the audit sink errors).

## P1-26 · Platform admin identity, bootstrap and separation of duties are unspecified

`ARCHITECTURE.md:154` — `PlatformAdmin { userId }`. Nothing else anywhere.

Open and unanswered:

- **How is the first one created?** There is no endpoint. Presumably a seed or CLI — say which.
- A platform admin is also a normal `User`. If they are also a member of tenant `acme`, do they carry
  platform powers there? (They must not — but nothing says so.)
- Can a platform admin grant *themselves* a support session? `RBAC.md:165` says only an owner grants —
  but if the platform admin is also an owner of some org, they can grant themselves access to **that**
  org. Probably fine, worth stating.
- Nothing requires stronger auth for the account that can suspend every customer.

**Recommendation.** Add to `RBAC.md` §8: platform admins are created only by a CLI command run against
the database (audited to a platform-level log), never through the API; the `platform` actor kind and the
`member` actor kind are **mutually exclusive per request** (resolved from the host: `admin.patchgrid.xyz`
⇒ platform, tenant subdomain ⇒ member, never both); and `PlatformAdmin` gains `mfaEnrolledAt` as a
precondition for any action. Which leads to:

## P1-27 · There is no MFA anywhere in the spec

Not mentioned in `ADR-0004`, `RBAC.md`, `TENANCY.md`, or `FEATURES.md` — not even as an explicit non-goal.

For a product whose pitch is "we designed access control around the customer's trust" (ADR-0020), the
absence of TOTP on OWNER/ADMIN accounts is the most conspicuous gap in the security story, and it is the
first thing a reviewer will ask about. It is also genuinely cheap: `otpauth` + a `UserMfa` table +
recovery codes is a day's work, and it exercises real crypto/UX problems (enrolment, recovery, "remember
this device", step-up for sensitive actions).

**Recommendation.** Either:

- Add TOTP MFA as an M8 item with an ADR, mandatory for `PlatformAdmin`, optional-but-enforceable per org
  (`Organization.requireMfa`), with step-up re-authentication for `org:delete`, `org:transfer_ownership`,
  `support:grant_access` and `token:create`; **or**
- Add it to the explicit non-goals list with a stated reason.

Silence is the one option that costs you the portfolio point. Recommend the first — it is the highest
signal-to-effort security feature left on the table.

## P1-28 · The permission catalog is missing entries the matrix and the product need

`RBAC.md:66-79` (catalog) vs `RBAC.md:81-125` (matrix). Your own test #1 (`RBAC.md:218`) fails the suite
when these disagree, so these are build breaks, not nits:

| Problem | Detail |
| --- | --- |
| `asset:read_all` | in the catalog (§6), **no row in the matrix** (§7 only has `asset:read`) |
| `category:read`, `sla:read` | **not in the catalog at all** — but a requester must read the category tree to file a ticket, and the console must read SLA policies to render targets |
| `automation:read` | in the catalog; the matrix row collapses it into "`automation:*` — read only" for agents, which is not a checkable row |
| `member:remove` | `MEMBER_REMOVED` is audited (§12) but no permission exists; only `member:disable` |
| `org:cancel_deletion` | `ORG_DELETION_CANCELLED` is audited; no permission |
| `support:request_access` | a platform admin "may *request* access" (§165); no permission models it |
| `notification:read` / `notification:update` | the bell and mark-as-read are endpoints; the route-coverage test will demand a permission or a `@Public` marker for them |
| `ticket:comment` vs `comment:create_public` | the matrix row for `comment:create_public` is "own, watch" for requesters — but a requester commenting on their own ticket *is* `ticket:read`-gated too. State the composition rule: a comment permission is always evaluated **after** `ticket:read` on the same subject |

**Recommendation.** Regenerate §6 and §7 from one source. The cleanest form: a single table where every
row is `(permission, requester, agent, admin, owner, notes)` and §6 is derived from its first column.
Two hand-maintained lists of ~50 strings will drift again within a month.

## P1-29 · `permissionsFor()` returns a flat list that cannot express conditional permissions

`RBAC.md:196,203` — `GET /me` returns `permissions[]` and the UI "renders from the server's answer".

Most interesting permissions are conditional: `ticket:update` is "own, **while `NEW`**";
`attachment:delete` is "own, **within 15 min**"; `ticket:approve_change` is "lead, **never own change**".
A flat `Permission[]` can only say "this role can sometimes update tickets", so the UI will render an
Edit button on every ticket and discover the truth from a `403`. That directly contradicts
`ENGINEERING.md:135` ("role-dependent UI reads the permission list … never from a re-derived role
check") — the UI will be forced to re-derive.

**Recommendation.** Two levels, which is what the API already half-does for transitions:

- `GET /me` → `permissions[]` = the **role-level** capabilities, honestly documented as "what this role
  can ever do", used for navigation and page-level gating only.
- `GET /tickets/:id` → `availableActions[]` (already specified, ADR-0006) **plus** `capabilities: {
  editFields: ["title","description"], canCommentPublic: true, canCommentInternal: false,
  canAddWatcher: true, canDeleteAttachment: false }` — computed by the same `can()` calls the mutation
  endpoints will make, on the resolved subject.

Same for list rows if you want per-row affordances. State this in `RBAC.md` §11 and `ADR-0019`, because
it changes the response contract of the most-used endpoint in the product.

## P1-30 · API token scopes have no mapping to permissions

`RBAC.md:178` / `ADR-0021:24` — "Effective permission = role matrix **∩** token scopes", scopes are
`tickets:read`, `tickets:write`, `assets:read`, `assets:write`, `kb:read`, `webhooks:write`.

The intersection is undefined because the two vocabularies do not line up. Does `tickets:write` include
`comment:create_internal`? `ticket:transition`? `ticket:assign`? `attachment:upload`? Does any scope grant
`comment:read_internal` — i.e. can a leaked monitoring token read your internal notes? (It should not.)
There is no `comments:*` or `attachments:*` scope at all.

**Recommendation.** Publish the mapping as data next to the catalog:

```ts
const SCOPE_GRANTS: Record<Scope, Permission[]> = {
  "tickets:read":  ["ticket:read", "comment:read_public", "attachment:download", "ticket:read_audit"],
  "tickets:write": ["ticket:create", "ticket:update", "ticket:transition", "ticket:assign",
                    "ticket:link", "comment:create_public", "attachment:upload"],
  // …
};
```

and make the matrix test assert the intersection for every `(scope-set, role, permission)` triple, plus
the invariant that no scope ever yields `comment:read_internal`, `member:*`, `org:*`, `token:*` or
`support:*`. Add `comments:internal` as an explicit opt-in scope if a legitimate integration needs it.

## P1-31 · Agents cannot raise a ticket on behalf of a requester

`RBAC.md:87` and the field-level table (`RBAC.md:129-139`) have no path to set `requesterId`; the
requester is implicitly the creator.

Raising a ticket for someone who phoned the desk is one of the two or three most common actions at a real
IT desk. Without it, agents create tickets under their own name and the requester never sees them in the
portal, never gets notified, and cannot close or reopen them.

**Recommendation.** Add `ticket:create_on_behalf` (agent+), allow `requesterMembershipId` on create for
that permission only, audit it as `TICKET_CREATED { onBehalfOf }`, and make the portal show it normally
to the named requester. `source: CONSOLE` already distinguishes it. If you would rather defer, put it in
`FEATURES.md` §out-of-scope explicitly — but it is a ~2-hour feature that materially changes how the
product demos.

---

# Part 3 — P1: contradictions and drift between documents

These are cheap to fix and each one is a place where an implementer would have to guess.

| # | Where | Conflict | Fix |
| --- | --- | --- | --- |
| D-1 | `TENANCY.md:8` vs `ARCHITECTURE.md:148-151` | `Organization` has `ownerCount` + `createdAt` in one, `defaultJoinRole`, `agentVisibility`, `deletionRequestedAt` in the other. Neither is a superset | One canonical entity definition. `ARCHITECTURE.md` owns the schema; `TENANCY.md` should reference it, not restate it |
| D-2 | `TENANCY.md:30` ("403") vs `ADR-0017:35` ("402/403") | Suspended-org status code | `403` with `type: .../organization-suspended`. `402` is exclusively plan limits (`ENGINEERING.md:34`) |
| D-3 | `ADR-0012:22` (`https://patchgrid.dev/problems/…`) vs everywhere else (`patchgrid.xyz`) | Problem Details `type` URIs use the wrong domain | `https://patchgrid.xyz/problems/…`. Decide whether those URLs must actually resolve (recommend: yes, a static page per type on `apps/www` — it is a genuinely nice touch and costs one MDX file) |
| D-4 | `DOMAIN.md:191` vs `ARCHITECTURE.md:196` vs `RBAC.md:74` | KB `isPublished` vs three-tier `visibility` | Three-tier (P1-21) |
| D-5 | `ARCHITECTURE.md:145` ("Every table has `id`, `createdAt`, `updatedAt`") vs the model itself | `TicketCounter`, `TicketAsset`, `TicketWatcher`, `UsageCounter` have composite PKs and no `id`; several have no `updatedAt` | Restate as "every *entity* table"; list the join/counter exceptions explicitly |
| D-6 | `ADR-0015:39` lists `Plan` as a platform table | `ARCHITECTURE.md:149` models `plan` as an enum on `Organization` | Drop `Plan` from ADR-0015's list (it was never built) or introduce the table. Recommend the enum; plans are code, not data, until billing exists |
| D-7 | `PROJECT.md:13` "Three surfaces, three deployables" | The table below it lists five hosts | "Three deployables across five hostnames" |
| D-8 | `PROJECT.md:29` says team leadership is "a scoped capability rather than a role" — correct — but `TENANCY.md:10` models `Membership.teamId` and `ARCHITECTURE.md:162` models `Team.leadId` | A membership has **one** `teamId`; a lead of team X who is a member of team Y is unrepresentable, and an agent in two teams is unrepresentable | Decide: (a) one team per membership (simple, states it as a product rule), or (b) `TeamMembership` join table (realistic — agents routinely sit in two queues). Recommend (b) and note it changes `scopeFor()` from `teamId = X` to `teamId IN (…)`. **This is a schema decision, so it is effectively P0 if you choose (b)** |
| D-9 | `ENGINEERING.md:9` lists `test:authz` among root scripts | `FEATURES.md:18` (M0) lists only `test`, `test:tenancy`, `db:*` | Add `test:authz` to the M0 checklist |
| D-10 | `ENGINEERING.md:143` "ADRs are never edited after acceptance" | ADR-0004's status line *was* edited to record the supersession | Amend the rule: "the Context/Decision/Consequences sections are never edited; the Status line is updated when superseded" |
| D-11 | `ARCHITECTURE.md:10` "Node 24" | `package.json` `engines.node: ">=20"`, no `.nvmrc` | Pin `24.x` in `engines` and add `.nvmrc`; CI reads it (`ENGINEERING.md:121` already assumes both exist) |
| D-12 | `ARCHITECTURE.md:104-121` module list | No `health` module, though `/health` and `/health/ready` are M0 (`ENGINEERING.md:127`); no `search` module (P1-15); no `platform-admin` split from `platform` | Add them |
| D-13 | `RBAC.md:72` `attachment:download` vs `ADR-0005:24` "Downloads are presigned GETs issued only after the RBAC check" | Which permission gates a download of an *internal* comment's attachment? | State: attachment visibility inherits the visibility of its parent comment; a requester can never download an attachment on an `INTERNAL` comment even if they can read the ticket |
| D-14 | `TENANCY.md:72` lists tenant-owned tables | Misses `TicketCounter`, `ChangeApproval`, `TicketLink`, `ProblemDetails`, `ChangeDetails`, `TicketAsset`, `UsageCounter`, `Comment`, `Ticket`, `Category` (says "everything ticket-related", which the schema-coverage test cannot consume) | Delete the prose list; the schema is the source of truth and the coverage test enumerates it. Keep only the *platform* list, which is short and closed |
| D-15 | `ADR-0014:37` "rejects unknown/suspended slugs with 404" | `TENANCY.md:31` says `PENDING_DELETION` → 404 and `SUSPENDED` → 403 | Align: unknown → 404, suspended → 403, pending-deletion → 404 |

---

# Part 4 — P1/P2: request pipeline, jobs and operations

## P1-32 · Rate limiting happens after tenant resolution

`ARCHITECTURE.md:66-76` — throttling is step 6; tenant resolution (a Redis lookup, possibly a DB read on
miss) is step 4; token verification (Argon2/JWT work) is step 3.

An unauthenticated flood therefore performs a cache lookup and possibly a database query *per request*
before anything rate-limits it. The cheapest defence must come first.

**Recommendation.** Reorder: helmet → request id/logger → **per-IP throttle** → cookie/token parse →
tenant resolution → CLS → **per-org and per-token throttle** → auth strategy → guards → validation. Also
collapse steps 3 and 7: the docs currently verify the token twice (step 3 "access token verify", step 7
"authentication strategy → Actor"). One strategy produces the `Actor`; step 3 should be deleted.

Also note the enumeration oracle: because step 4 answers before authentication, anyone can probe which
slugs exist (404 vs 401). That is true of every subdomain SaaS and is an acceptable risk — but say so in
the threat model rather than leaving it unremarked.

## P1-33 · Integration tests will race each other against one database

`ENGINEERING.md:50` — "Nest app booted against the real `patchgrid_test` Postgres (migrated + truncated
per test file)".

Vitest runs test **files** in parallel by default. Two files truncating and seeding the same database
concurrently will fail nondeterministically, and the failures will look like isolation bugs, which is the
worst possible false signal in this particular repo.

**Recommendation.** State the mechanism explicitly in `ENGINEERING.md`:

- `pool: "forks"`, `poolOptions.forks.singleFork: true` for the integration project (simple, slower), or
- one **schema per worker** (`search_path` set per connection, migrations applied per schema) — faster
  and genuinely interesting, but it interacts with RLS and the two-role setup, so only if you want that
  problem, or
- `pglite`/template-database cloning: `CREATE DATABASE test_w1 TEMPLATE patchgrid_test_template` per
  worker. This is the good answer: instant, fully isolated, and the template is migrated once.

Also: `TRUNCATE` requires table ownership, so the test harness must connect as the **owner** role, while
the application under test connects as `patchgrid_app`. Two connection strings in tests too — say so, or
truncation will fail confusingly under `FORCE ROW LEVEL SECURITY` (see P0-6).

## P1-34 · Nothing asserts that the Prisma enums and the Zod enums agree

`ENGINEERING.md:19-20` — "No enums in application code; use Zod enums … Prisma-generated enums stay
inside the repository layer" and "Domain types are inferred from Zod".
`ARCHITECTURE.md:58` — "`packages/contracts` declares its own Zod enums rather than importing Prisma's".

Good decision, real risk: the two definitions can drift silently (add `KNOWN_ERROR` to Prisma, forget the
Zod enum, and the API serialises a status the client cannot parse).

**Recommendation.** A compile-time assertion in a test file, which costs nothing:

```ts
type Assert<A extends B, B> = true;
type _S1 = Assert<TicketStatus, PrismaTicketStatus>;   // Zod union ⊆ Prisma enum
type _S2 = Assert<PrismaTicketStatus, TicketStatus>;   // and back
```

One pair per shared enum (`Role`, `TicketStatus`, `TicketType`, `Impact`, `Urgency`, `Priority`,
`Visibility`, `LinkRelation`, `Plan`, `OrgStatus`, `Source`). It fails at `pnpm typecheck`, which is CI
step 2 — before any test runs.

## P1-35 · No idempotency mechanism for client-initiated mutations

`ENGINEERING.md:33` — "Mutations are idempotent where cheap (transitions check current state and return
409, not a duplicate side effect)."

That covers transitions. It does not cover the one the user actually notices: double-clicking "Submit
ticket" on a slow connection creates two incidents, two ticket numbers, two SLA clocks and two
notifications.

**Recommendation.** Support an `Idempotency-Key` header on `POST` routes that create entities: a
tenant-scoped Redis key `idem:<orgId>:<key>` holding the first response for 24 h; a repeat returns the
stored response rather than acting. It is a small piece of infrastructure, it is what Stripe/GitHub do,
and it is exactly the kind of "production-grade" detail you are after. Put it in `ENGINEERING.md` §API
conventions and in M2 (ticket creation) at the latest.

## P1-36 · `runAsPlatform` is permitted in "exactly three places" but needs at least five

`TENANCY.md:76` / `ENGINEERING.md:43` / `ADR-0018` — dispatcher, auth/provisioning, platform admin.

Per P0-3, the real call sites are: job dispatcher, auth (login/org picker/invite accept), provisioning,
platform admin, **API-token authentication**, **support sessions**, **org purge**, and **email intake
tenant resolution** (M6 — resolving `<slug>@inbound…` happens before any tenant context exists).

Either the list grows, or (better) it is re-expressed as a rule about *modules* rather than a count:

> Cross-tenant helpers may be imported only by `src/platform/**`, `src/auth/**` and `src/jobs/dispatcher/**`.
> Every other module reaches other tenants only via `runAsTenant(orgId, …)`, which requires a known org.

That is enforceable by the existing `no-restricted-imports` ESLint rule and does not need updating every
time a legitimate call site appears. Update `CLAUDE.md` too — it currently hard-codes "three places",
which will make the agent flag correct code as a violation.

## P2-1 · SSE, connection limits and fan-out

`ADR-0008` / `ARCHITECTURE.md:138`.

- Under HTTP/1.1 a browser allows ~6 connections per origin; a held-open SSE stream consumes one. With
  the API on its own origin this is survivable, but a user with three tabs open on the same tenant burns
  three. Worth a note that production must be HTTP/2 (it will be, behind any modern proxy), and that dev
  may hit it.
- `ADR-0008` says `ticket-updated` goes to "tickets the user is watching (requester, assignee, or team
  member)". Computing that fan-out per event requires a query per event, and it must respect
  `agentVisibility` — otherwise an `OWN_TEAM_ONLY` agent receives update events (ids, titles) for tickets
  they cannot read. Say that the SSE fan-out runs through the same `scopeFor()`.
- Specify the reconnect contract concretely: `Last-Event-ID` is the `Notification.id`; on reconnect the
  server replays notifications with a greater id, capped at N; beyond that the client refetches. Also
  state the heartbeat interval (25 s is already there — good) and the max stream lifetime (proxies kill
  long streams; recommend a server-side 30-minute close so reconnection is exercised routinely rather
  than rarely).

## P2-2 · No metrics or tracing

`ENGINEERING.md:123-128` covers structured logs and health checks — good, and `orgId` on every line is
the right instinct. But there are no metrics and no traces, and "which tenant is slow" is only answerable
by grepping.

**Recommendation.** OpenTelemetry is a natural fit and a strong learning target for exactly the topics
you listed:

- `@opentelemetry/sdk-node` with the Nest/HTTP/Prisma/BullMQ instrumentations.
- `orgId`, `membershipId`, `permission`, `ticketType` as span attributes — the multi-tenant angle is what
  makes it interesting.
- Prometheus metrics: request duration by route, DB transaction duration (relevant given P0-11), queue
  depth and job duration **by tenant**, SLA breaches by tenant, RLS-denied query count.
- Locally: an OTel collector + Grafana/Tempo/Prometheus in Compose, behind a Compose profile so the
  default `docker compose up` stays light.

Worth an ADR and an M8 item at minimum. Consider pulling the *instrumentation seams* into M0 (a `Tracer`
provider, even a no-op) so it is not retrofitted through 200 files.

## P2-3 · No zero-downtime migration policy

Nothing in `ENGINEERING.md` about how schema changes roll out. For a deployment target of "always
deployable-in-principle" (`ENGINEERING.md:11`), the expand/contract discipline is the missing rule:

> Every migration is **additive** in the release that introduces it. Renames are add-column → backfill →
> dual-write → switch reads → drop, across at least two releases. `NOT NULL` is added only after a
> backfill has completed. No migration takes an `ACCESS EXCLUSIVE` lock on a large table during business
> hours (`ALTER TABLE … SET NOT NULL` needs a `CHECK … NOT VALID` + `VALIDATE` dance).

Three paragraphs in `ENGINEERING.md`, and it is one of the most transferable things on your list.

## P2-4 · `AuditLog` "never deleted" will need partitioning, and conflicts with erasure

`DOMAIN.md:166` — "Written in the same DB transaction as the change. Never deleted."

Two consequences:

- It becomes the largest table in the database and the one most often scanned by date. Declarative
  **partitioning by month** (`PARTITION BY RANGE (createdAt)`) plus a retention/detach job is the
  textbook answer, and Prisma tolerates it if the partitioned parent is created in raw SQL. Worth doing
  for the learning value alone, and worth deciding now because converting a large table later is
  painful. Note the RLS interaction: policies must be declared on the parent and are inherited.
- It conflicts head-on with the right to erasure (see P2-5).

## P2-5 · No data-protection story at all

Nothing anywhere about: tenant data export, per-user erasure, retention, subprocessors, or what happens
to a departed employee's comments.

For a multi-tenant SaaS that holds other companies' incident data — including, by design, security
incidents — this is the gap most likely to be noticed by a senior reviewer.

**Recommendation.** One ADR, modest scope:

- **Tenant export**: `GET /org/export` (owner-only, async job, produces a signed zip of JSON + attachment
  manifest). It is also the honest answer to "can I leave?", and it is a genuinely useful M8 demo.
- **Erasure**: a user's account can be deleted; their *content* is **pseudonymised**, not removed —
  `Membership` gains `anonymisedAt`, the display name becomes "Former member", `User.email` is replaced
  by a tombstone hash. Audit rows keep the membership id, so the chain of custody survives while the
  person does not. State the reasoning: audit integrity and erasure are reconciled by pseudonymisation,
  which is the standard position.
- **Retention**: `AuditLog` retained N years (configurable per plan), `Notification` 90 days,
  `InboundEmail` raw bodies 30 days, `PENDING` attachments 1 hour (already specified).
- **Subprocessors / residency**: already deferred in ADR-0013 — good; add the export/erasure ADR
  alongside it so the trio is coherent.

## P2-6 · DNS and certificates — your stated learning goal, and the thinnest part of the spec

You listed "domain management, DNS" as a top priority. The docs currently contain: "wildcard DNS +
wildcard TLS (DNS-01)", deferred to M8 (`ARCHITECTURE.md:24`, `ADR-0014` consequences).

There is a lot of genuinely advanced material here that costs nothing to *design* now and is exactly what
distinguishes this project:

- **Wildcard TLS via DNS-01**: why HTTP-01 cannot issue a wildcard, which ACME client, the registrar API
  credential scoping problem (a token that can edit your whole zone is a large blast radius — use
  `_acme-challenge` CNAME delegation to a dedicated zone), renewal automation and monitoring.
- **CAA records** restricting which CA may issue for `patchgrid.xyz` — a two-line DNS change that
  demonstrably raises the bar.
- **Mail DNS**: SPF (with the envelope-sender/`From` split already described in ADR-0018), DKIM key
  rotation, DMARC policy progression `p=none → quarantine → reject` with `rua` reporting, MX for
  `inbound.patchgrid.xyz`, and why the tenant's org name in the `From` display name does **not** affect
  alignment.
- **Per-tenant custom domains** (deferred, but the design matters): `CNAME support.acme.com →
  cname.patchgrid.xyz`, per-domain certificate issuance with `tls-alpn-01` or DNS-01 delegation, a
  `Domain` table consulted before slug parsing, ownership verification, and the certificate-storage
  problem.
- **Public Suffix List**: because tenants control `*.patchgrid.xyz`, the domain arguably belongs on the
  PSL — which would give each tenant its own cookie jar and eliminate cookie tossing (P0-2) entirely, at
  the cost of making `Domain=.patchgrid.xyz` cookies impossible (so the whole session design changes).
  This is a genuinely deep trade-off and a great ADR to write, whichever way it lands.
- **Wildcard DNS and subdomain takeover**: what happens when an org is deleted, why dangling CNAMEs
  matter, and why the slug-reuse decision (P1-13) is a DNS problem as much as a product one.

**Recommendation.** A new `docs/DNS.md` plus ADR-0023 (wildcard TLS and DNS operations) and ADR-0024
(email DNS: SPF/DKIM/DMARC/MX). Write them now, implement in M8. It converts your weakest-documented
stated goal into one of the strongest sections.

## P2-7 · Local development: `lvh.me` is a third-party dependency on the critical path

`ADR-0014:43` / `ENGINEERING.md:89`. `lvh.me` is a public domain owned by someone else whose wildcard A
record points at `127.0.0.1`. It has lapsed before. The `/etc/hosts` fallback is documented — good.

Worth adding: modern Chrome and Firefox resolve `*.localhost` to loopback natively, so
`acme.localhost:3001` / `api.localhost:4000` works with **zero** external dependency and zero
`/etc/hosts` editing. Cookies on `Domain=.localhost` are accepted by Chrome and Firefox (Safari is the
holdout). Recommend documenting all three tiers, in order: `lvh.me` (default, prettiest), `*.localhost`
(no external dependency), `/etc/hosts` + `patchgrid.test` (works offline and in Safari). Also note
`sslip.io` / `nip.io` as equivalents to `lvh.me`.

One more: `.test` is an IANA-reserved TLD (RFC 6761), which is the correct choice for the hosts-file
tier — worth saying, because it is *why* `patchgrid.test` was picked over `patchgrid.local` (which
collides with mDNS).

## P2-8 · CI is missing the security checks the project's own positioning implies

`ENGINEERING.md:108-121`. Present: lint, typecheck, unit, integration, tenancy, authz, build, migration
drift. Missing:

- **Secret scanning** (`gitleaks`) — a repo that will contain `.env.example`, seed passwords and token
  prefixes.
- **Dependency audit** (`pnpm audit --audit-level=high`, or `osv-scanner`) — Dependabot is mentioned but
  it is not a gate.
- **CodeQL / semgrep** for JS/TS — free on public repos, and this is a portfolio repo.
- **A migration-safety check** — fail the build on a migration containing `DROP COLUMN` / `DROP TABLE`
  without an accompanying `-- safe:` annotation (pairs with P2-3).
- **The RLS/grant/timestamptz/composite-FK introspection assertions** from P0-4/6/7/8 should run in CI as
  their own job, not buried in the tenancy suite, so a failure names the actual problem.

## P2-9 · M8 is three milestones wearing a trench coat

`FEATURES.md:113-128` — 17 items including the platform back-office, support sessions, API tokens, org
deletion, the demo seed, all E2E, the finished marketing site, a security review and threat model,
OpenAPI polish, four Dockerfiles, the README, and the entire deployment.

Each of the first three is a week or more on its own. A milestone that cannot be finished is a milestone
that gets abandoned half-done, and it is the last one — the part a portfolio reviewer actually looks at.

**Recommendation.** Split:

- **M8 — Platform layer**: back-office, org lifecycle/purge, support sessions, API tokens.
- **M9 — Hardening**: threat model (move it *earlier* — it should inform design, not certify it),
  security review, E2E including the cross-tenant and escalation negatives, OpenAPI polish, dependency
  and secret scanning.
- **M10 — Ship**: Dockerfiles, Compose prod, Coolify/Hetzner, wildcard DNS + TLS, nightly demo reset,
  README, screenshots, architecture diagram.

Also: write the **threat model in M1**, not M8. It is a one-page document (assets, actors, trust
boundaries, STRIDE per boundary) and every P0 in this review would have been caught by it.

## P2-10 · Milestone sequencing snags

| Where | Problem |
| --- | --- |
| `FEATURES.md:35` | M1 includes "Team lead capabilities (**approve changes**, SLA escalation target…)" — Changes do not exist until M4 and SLA does not exist until M3. Keep only "manage own team's members" in M1 |
| `FEATURES.md:32,35` | "last-owner protection" appears twice in M1 |
| `FEATURES.md:36` | M1 plumbs `agentVisibility` "into list queries" — there are no ticket lists until M2. Keep the setting + `scopeFor()` unit tests in M1, plumb in M2 |
| `FEATURES.md:38` vs `:46` | The authz suite (M1) includes the route-coverage test, which must pass with ~15 routes; fine — but note it must be *maintained* from M1, which is the point |
| `FEATURES.md:82` | Watchers are M4, but `scopeFor()` (M1) and the requester-scoping tests reference watcher access. Either stub the watcher branch in M1 or move `TicketWatcher` to M2 with the ticket model. Recommend M2 |
| `FEATURES.md:52` | M2 creates `Comment` and `AuditLog` but not `Notification` (M3) — yet `DOMAIN.md:175` says ticket creation notifies. Fine, but state that M2 emits domain events with no handlers, so M3 is purely additive |
| `FEATURES.md:11` | M0 exit is "`/health/ready` returns 200" but M0 has no database schema, so readiness can only check connectivity. Fine — just say so |

## P2-11 · Smaller items, batched

| # | Where | Note |
| --- | --- | --- |
| a | `ARCHITECTURE.md:145` | UUID v7 for **every** table means ids are enumerable-adjacent (time-ordered). Not a leak (they are 128-bit random in the low bits), but state that ids are not secrets and authorization never depends on unguessability |
| b | `ENGINEERING.md:16` | `exactOptionalPropertyTypes: true` fights Prisma's generated types (`field?: T \| null`) constantly. Keep it — it is the right call — but expect a `Prettify`/`Exact` helper and note it so it is not "fixed" by turning the flag off |
| c | `DOMAIN.md:143` | `Category.depth` is denormalised; re-parenting must recompute it for the whole subtree. State that categories are **never hard-deleted** (only `isActive: false`) because tickets reference them historically |
| d | `DOMAIN.md:145` | "inherits the nearest ancestor's `defaultTeamId`" needs a recursive walk; at max depth 3 just walk in code. Say what happens when no ancestor has one (recommend: ticket has no team, lands in the "unassigned" queue) |
| e | `RBAC.md:64` | "The requester and the current assignee are implicit watchers" — implicit watchers are not rows, so notification fan-out is a union and the UI must render them. Also: when the assignee changes, does the previous assignee stop receiving updates? (Recommend: yes, and offer "keep watching" in the UI) |
| f | `RBAC.md:204` | "`403` never reveals existence: reading a ticket the actor may not see returns `404`" — needs a concrete rule, not a judgement call. Recommend: *reads* of any tenant-owned entity the actor cannot see → `404`; *actions* on an entity the actor can see but may not act on → `403`. One sentence, prevents years of drift |
| g | `ADR-0009` | The counter row lock serialises ticket creation per `(org, type)` for the **whole** transaction — which now also includes the quota update (P1-12) and the audit write. Take the counter lock **last**, just before insert, to keep the critical section short |
| h | `TENANCY.md:49` | Verified-domain auto-join: block free/disposable mail domains explicitly (`gmail.com`, `outlook.com`, …). They cannot be DNS-verified in practice, but an explicit denylist documents the intent and guards against a verification bug |
| i | `TENANCY.md:49` | Two orgs can both verify `acme.com` (each adds its own TXT record). Decide: first verified wins and blocks others, or both allowed and the user picks. Recommend first-wins with an admin-visible conflict message |
| j | `ARCHITECTURE.md:268` | Presigned uploads: also set a per-request **max declared size** server-side from the plan (`FREE` 1 GB total does not bound a single file); `DOMAIN.md:165` says 10 MB — put that number in one place (contracts) |
| k | `ENGINEERING.md:125` | "No PII in logs … never emails" conflicts with needing to investigate failed logins. Recommend logging a truncated SHA-256 of the email (`emailHash8`) for correlation without storing the address |
| l | `ARCHITECTURE.md:256` | MinIO bucket CORS must allow `https://*.patchgrid.xyz`; S3/MinIO support the wildcard form. Note it, because it is the step everyone forgets locally |
| m | `ARCHITECTURE.md:254` | The Postgres init script only runs on a **fresh volume**. Ship the role/grant/extension SQL as an idempotent file run by `db:migrate` as well, or developers with existing volumes get confusing permission errors |
| n | `ADR-0002` | Nothing prevents an `INCIDENT` row holding `status: AWAITING_APPROVAL` at the database level. Accepted, and correctly noted — but a `CHECK` constraint enumerating valid `(type, status)` pairs is ~15 lines of SQL and turns a service bug into a database error. Worth it in a system whose selling point is defence in depth |
| o | `PROJECT.md:81` | "Local LLM … a defensible decision for IT tickets" — true and well argued. Add the operational consequence: prompt-injection via ticket content. An LLM reading attacker-controlled ticket text must never have its output trusted as instructions; suggestions are data that an agent accepts. `DOMAIN.md:196` already says suggestions never auto-apply — good; say *why* in one line |
| p | `FEATURES.md` / everywhere | i18n is not mentioned at all, not even as a non-goal. Given `apps/www` is SEO-heavy, state it: English only in v1, no `next-intl`, no locale routing — or you will be asked |
| q | repo | No `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, PR template, `.editorconfig`, or commit linting (`commitlint` + `husky`/`lefthook`), despite `ENGINEERING.md:10` mandating Conventional Commits. Add to M0 — a portfolio repo is judged on these in the first ten seconds |

---

# Part 5 — Repository state (right now, before any of the above)

## R-1 · The entire specification is untracked

`git status` shows `?? docs/`. Commit `041cfaa` was literally *"chore: add docs to the .gitignore"*; the
working tree reverses that but the change is uncommitted.

Right now, thirty documents representing all of the design work exist **only** on this disk, with no
history. That is the highest-probability way to lose this project. Commit `docs/` (and the `.gitignore`
revert) before anything else.

## R-2 · Package scope is still `@workspace/*`

`package.json`, `apps/web/package.json`. Expected — it is M0's first task (ADR-0001) — but note that
`apps/web` is currently named `web` in its `package.json` (`"name": "web"`, not `@patchgrid/app`), so the
rename touches the name field too.

## R-3 · `engines.node: ">=20"`, no `.nvmrc`

Contradicts `ARCHITECTURE.md:10` (Node 24) and `ENGINEERING.md:121` ("Node version comes from
`.nvmrc`/`engines`"). See D-11.

## R-4 · `.vscode` is git-ignored but `.vscode/` exists

Decide: commit a shared `.vscode/settings.json` + `extensions.json` (recommended for a portfolio repo —
it shows the workspace is set up deliberately) and un-ignore it, or delete the directory.

## R-5 · `turbo.json` has no `test`, `test:tenancy`, `test:authz`, `db:*` tasks

Expected (M0), but note `typecheck` currently has `dependsOn: ["^typecheck"]` and no dependency on
`^build`. If `@patchgrid/contracts` and `@patchgrid/database` ship built `.d.ts` rather than source,
`typecheck` will need `^build`. Decide now whether internal packages are consumed as **source**
(simplest, requires `transpilePackages` in Next and `swc` handling in Nest) or as **built output**. It
affects every package's `exports` map. Recommend source for `contracts`/`ui`, built for `database`
(because Prisma client generation is a build step anyway).

## R-6 · Next.js is `16.3.3`

Confirmed from `apps/web/package.json`. `CLAUDE.md`'s warning is appropriate; note that
`node_modules/next/dist/docs/` is the authoritative local reference and should be read before any routing,
`proxy.ts`, caching or server-action work.

---

# Part 6 — Open questions for you

These need your decision; I have a recommendation for each, but they are genuine forks.

| # | Question | Recommendation |
| --- | --- | --- |
| **Q-1** | **P0-3**: `runAsPlatform` vs RLS — projection tables (`UserOrgIndex`, `ApiTokenIndex`) and org-bearing tokens, so `patchgrid_app` *never* gets `BYPASSRLS`; or a second `patchgrid_platform` role with `BYPASSRLS` confined to one repository? | The projection-table route. It preserves the strongest claim in the whole design ("the application literally cannot disable its own isolation"), and the cost is two tiny tables |
| **Q-2** | **P0-2**: per-tenant cookie names (`pg_at_<slug>`), or accept single-tenant-per-browser and drop the "two tabs" claim from ADR-0014? | Per-tenant cookie names. The multi-org user is your own seeded demo account |
| **Q-3** | **D-8**: one team per membership, or a `TeamMembership` join table? | Join table. Agents sitting in two queues is normal, and it is a schema change you cannot make cheaply in M4 |
| **Q-4** | **P0-5**: reference people by `membershipId` everywhere (with a `Membership.displayName` denormalisation), or keep `userId` and accept application-level enforcement? | `membershipId`. This is the change that pays for itself the most |
| **Q-5** | **P1-27**: TOTP MFA in M8/M9, or an explicit non-goal? | Build it. Highest security signal per hour of work left in the plan |
| **Q-6** | **P1-12**: what happens on a plan **downgrade** below current usage — block the downgrade, grandfather existing rows read-only, or allow and block new creation? | Allow the downgrade, block *new* creation with `402`, and show an "over limit" banner. Never delete customer data on a downgrade |
| **Q-7** | **P1-13**: is a released slug permanently reserved? | Yes, permanently. Store history forever, 302 (not 301) for 30 days |
| **Q-8** | **P2-6**: do you want the DNS/TLS/email-DNS design written now (`docs/DNS.md` + two ADRs) even though it ships in M8? | Yes — it is one of your stated learning goals and currently the thinnest section |
| **Q-9** | **P2-9**: split M8 into M8/M9/M10, and move the threat model to M1? | Yes to both |

---

# Appendix — suggested new ADRs

| # | Title | Driven by |
| --- | --- | --- |
| 0022 | Platform-scope access under RLS: projections, not bypass | P0-3, P1-36 |
| 0023 | Identity keys: UUIDv7, `@db.Uuid`, `timestamptz`, composite tenant foreign keys | P0-4, P0-8, P0-9 |
| 0024 | Session cookies are per tenant | P0-2, P1-18 |
| 0025 | Wildcard TLS and DNS operations | P2-6 |
| 0026 | Email DNS: SPF, DKIM, DMARC, MX, and inbound sender authentication | P1-24, P2-6 |
| 0027 | Data protection: tenant export, pseudonymised erasure, retention | P2-5 |
| 0028 | MFA (TOTP) and step-up authentication | P1-27 |
| 0029 | Observability: OpenTelemetry, per-tenant metrics | P2-2 |
