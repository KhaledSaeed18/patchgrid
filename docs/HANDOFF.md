# Handoff — M8 complete, M9 next

Written 2026-10-15, at the M8 boundary. **This file is regenerated, not appended to.** It is rewritten at every milestone boundary, and
whenever enough has landed that the previous version would mislead. If it disagrees with `FEATURES.md` or
an ADR, they are right and this is stale.

Read this first, then `CLAUDE.md`, then the documents it points at.

---

## What Patchgrid is

A **multi-tenant SaaS ITSM platform**: ticketing and operations for IT and security teams. It models four
ITIL record types (Incident, Service Request, Problem, Change), each with its own lifecycle. Priority is
_computed_ from impact × urgency, never typed into a dropdown.

It is a learning and portfolio project, built as though it were production: three deployables, tenants
addressed by subdomain, and tenant data isolated at the database level.

| Host                   | App        | What it is                                       |
| ---------------------- | ---------- | ------------------------------------------------ |
| `patchgrid.xyz`        | `apps/www` | Landing, pricing, signup                         |
| `<slug>.patchgrid.xyz` | `apps/app` | A tenant's workspace — the product               |
| `app.patchgrid.xyz`    | `apps/app` | Tenant-less: login, picker, create workspace     |
| `admin.patchgrid.xyz`  | `apps/app` | The operators' back-office (ADR-0040)            |
| `api.patchgrid.xyz`    | `apps/api` | NestJS — all business logic and data access      |

Locally: `lvh.me:3000`, `<slug>.lvh.me:3001`, `app.lvh.me:3001`, `admin.lvh.me:3001`, `api.lvh.me:4000`.

---

## Where we are

**M0–M6** are complete (M6, email intake, on 2026-10-15). **The build order is M0–M6, then M8 → M9 →
M10, and M7 last**: M7 is the one milestone that needs local models (Ollama, embeddings, the phishing
service), so it lands on a running system. Milestone numbers did not change; `FEATURES.md` lists M7 last.

**M8 (Platform layer): complete 2026-10-15.** Every item is checked. The exit criterion holds, and each
part was walked in headless Chromium against the running stack:

- An operator signs in at `admin.` with a password and a TOTP factor, lists workspaces, suspends,
  restores and re-plans them, and sees counts, never content.
- An owner grants that operator a few hours of read-only access. The operator opens the workspace and
  reads tickets, internal notes included, while every page they open lands in the workspace's own audit
  log. Writes are refused. The owner ends it, and the operator's next request is refused.
- An admin mints a scoped token; `curl` with it raised an incident marked `API`, attributed to the
  token's service account, and was refused `/members` and refused again the moment it was revoked.

**An adversarial review of all of M8 ran before it was called done** (three read-only reviewers: platform
credential and support; tokens and deletion; data protection). Everything they confirmed is fixed, with
tests:

- A per-person TOTP lockout. Five wrong codes in 15 minutes lock the factor for an hour; the lock is
  audited and the operator is emailed. A recovery code ends the operator's other sessions and is
  emailed too.
- A support session dies with the operator's sign-out and with a re-grant (`PlatformAdmin.grantedAt`).
- A support read is recorded even if the operator hangs up mid-response.
- A token without `comments:internal` reading a ticket's audit trail gets internal notes' words and
  filenames redacted. Comment and attachment entries now record `internal`.
- The export streams through `yazl` (ZIP64, piped backpressure). The `fflate` writer could hang on a
  failed upload part and corrupted archives past 4 GiB.
- Erasure tombstones as `deleted+<userId>@invalid` (ADR-0028 erratum: the email hash was reversible).
  It retries cleanly, renames invitations to the address, and never leaves a workspace ownerless,
  even through a restore.
- The purge records itself inside the tombstone's transaction. A non-owner's cancel is the same 404
  whatever the window.

**CI is green on `main`.**

---

## What M8 built — ADR-0040 to ADR-0044

### The platform credential and the back-office — ADR-0040

- Its own login under `/api/v1/platform/auth`: password → a five-minute challenge cookie → TOTP enrolment
  (QR, ten recovery codes shown once) or verification → a one-hour session in `pg_pa`, path-scoped to
  `/api/v1/platform`. No refresh.
- `@PlatformRoute` routes take only `pg_pa`, only from the `admin.` origin (or `X-Patchgrid-Surface: admin`
  server-side), and check the epoch `platform:<id>`, the admin row and its `grantedAt` on every request.
- MFA: AES-256-GCM secrets under `MFA_ENCRYPTION_KEY`, ±1 step, the last step stored so a code works once,
  Argon2id recovery codes, and the Redis lockout above (it fails closed if Redis is down).
- `pnpm platform:grant|revoke <email>` is the only way in. `PlatformAuditLog` records every grant, sign-in,
  lock and purge.
- **Back-office** (`apps/app`, `admin.` host rewritten to `/backoffice/*`, client-rendered because `pg_pa`
  never reaches the Next server): org list and detail with counts, suspend (every member's epoch bumped),
  unsuspend, plan, restore a pending deletion, request and enter support. Each action lands in both
  logs.

### Support access — ADR-0020, ADR-0041

- `SupportSession` (tenant-owned): an operator asks with a reason; an owner grants (≤ 72 h, on a consent
  screen naming internal notes and the audit log), declines or revokes. Owners are emailed at each turn
  and on first use. `support-sweep` ends expired sessions every five minutes.
- Entering mints a support JWT into `pg_st_<slug>`; the credential locator prefers it. The actor is
  `{ kind: "support", role: "ADMIN" }` narrowed to `SUPPORT_READ_PERMISSIONS`, with the session id as its
  `membershipId` so no "own"/"assignee"/"watcher" relation can hold. Non-GET is refused at the guard.
- One `SUPPORT_READ` row per request, written on the response's `close`; a failed write ends the session
  (`AUDIT_FAILED`).
- `/me.support` drives the banners: the operator's ("read-only, everything recorded") and the admins'
  ("Dana from Patchgrid support can read this workspace until …"). The operator lands on Queues (all
  open), sees read-navigation (`NavItem.reads`), and is offered no ticket actions.

### Scoped API tokens — ADR-0021, ADR-0042

- `ApiToken` (tenant-owned) beside `ApiTokenIndex`, one `SERVICE_ACCOUNT` membership per token,
  `pg_<12 [a-z0-9]>_<43 base64url>`, Argon2id with a five-minute digest cache; the row is read every
  request, so revocation holds on the next one.
- Effective permission is role ∩ `SCOPE_GRANTS`; `webhooks:write` is not offered. A per-token throttler
  (300/min, keyed by prefix) runs before verification. `lastUsedAt` is written at most once a minute.
- Service accounts appear in Members marked "API token" and can't be re-roled, disabled, removed, put in a
  team, assigned or made watchers. Creation is deliberately not `@Idempotent` (the answer is the
  secret).
- Settings → API tokens: create (secret shown once), list with last-used and expiry, revoke. The
  `api-token-sweep` warns a token's creator (or the owners) a week before it lapses.

### Deleting a workspace — ADR-0043

- An owner types the slug in Settings → Workspace. Everyone is signed out; the subdomain, the bearer path,
  support, session open and invitations all answer 404.
- The picker shows owners "Deleting on …" and "Keep it"; an operator can restore from the back-office.
  Both are refused from the purge date on, and a restore is refused if no owner is left.
- `org-purge` (daily, dispatched only for orgs due + 1 h grace) runs inside the tenant: objects under
  `org/<id>/` and `staging/org/<id>/`, then every tenant table child-first (a test holds the list to the
  schema), then a `DELETED` tombstone that keeps the slug forever.

### Data protection — ADR-0028, ADR-0044

- **Export**: `POST /org/exports` (owner, one a day, `429` with `Retry-After`) → `org-export` job → a zip
  of NDJSON per entity plus every file with its SHA-256, streamed into storage; the requester (if still
  an owner) is mailed a 24-hour link, Settings mints fresh short links. Secrets and notifications are
  left out.
- **Erasure**: `POST /auth/account/erase` from the picker's "Your account", password again. In each
  workspace the membership becomes a nameless `REMOVED` "Former member"; the account becomes a tombstone.
  Removed memberships now keep a hidden `UserOrgIndex` row so erasure can find them.
- **Retention**: `retention-sweep` (per tenant, daily) drops notifications past 90 days and lapsed
  exports; `credential-retention` (platform, daily) drops tokens 30 days past expiry.

### Tests at the boundary

| Suite | Count |
| --- | --- |
| `apps/api` unit | 966 |
| `apps/api` integration | 194 |
| `pnpm test:tenancy` | 13 catalog + 37 (3 pointers skipped) |
| `pnpm test:authz` | 380 |
| `packages/database` unit / catalog / integration | 8 / 13 / 23 |
| `packages/contracts` | 188 |
| `apps/app` | 57 |

Browser walkthroughs live in the git-ignored `apps/app/node_modules/.cache/shots/` (`support.mjs`,
`tokens.mjs`, `deletion.mjs`, `export.mjs`, `backoffice.mjs`, and the M5/M6 ones), run with `node` from
`apps/app` against `pnpm dev`. The back-office scripts enrol Dana's factor; clear her `UserMfaFactor` and
`UserMfaRecovery` rows (`reset-support.sh` does) before running them again. `deletion.mjs` leaves a
`doomed-*` workspace owned by Alice each run.

---

## Earlier milestones, in brief

- **M6** gave email intake: signed raw MIME, the DMARC verdict, explicit-actor `createAs`/`addAs`, threading
  by our Message-ID or `[INC-…]`, and the inbound log.
- **M5** gave attachments through staging and byte sniffing on their own domain, the asset register and
  the knowledge base.
- **M4** gave transition tables as data, change approval and links read from both ends.
- **M3** gave notifications, the live stream and the per-tenant sweeps.

The detail is in the git history of this file, at those boundaries.

## Decisions made in M8

| Decision | Where |
| --- | --- |
| The platform actor comes from its own credential, minted only after a second factor; platform MFA arrives now | ADR-0040 (resolves TM-2) |
| A support session reads through the tenant's own routes as a read-only support actor | ADR-0041 |
| One token, one service account; the row decides every request; creation is not replayable | ADR-0042 |
| A deleted workspace becomes a tombstone; time, not a race, decides between restore and purge | ADR-0043 |
| Exports stream; erasure is self-service and pseudonymous; retention runs per tenant (credentials on the platform) | ADR-0044 |
| Removed memberships keep a hidden picker row, for erasure to find | ADR-0044 erratum |
| The erasure tombstone names the account id, not a hash of the address | ADR-0028 erratum |
| Every `RateLimitedProblem` carries `Retry-After` | problem filter |

---

## Recommended next steps — M9

`FEATURES.md` §M9, hardening. Its exit: the security review has no open findings; E2E covers the core
flows across two tenants in a real browser, including the negative cases; observability answers "which
tenant is slow" without grepping. In order:

1. **MFA for members** (ADR-0029). The tables, TOTP, recovery codes and lockout already exist for
   operators (`auth/mfa/`). Add per-org `requireMfa`, member enrolment, and step-up re-authentication for
   `org:delete`, `org:transfer_ownership`, `support:grant_access` and `token:create`.
2. **Playwright E2E**: signup → provision → invite → incident lifecycle; an SLA breach on a one-minute
   policy; change approval; the cross-tenant, role-escalation and two-tabs-two-tenants negatives. The
   `.cache/shots` scripts are a head start on selectors.
3. **Observability** (ADR-0030): OpenTelemetry for the no-op `Tracer`, per-tenant metrics, the collector
   and Grafana behind a Compose profile.
4. **The security review** against the threat model, then OpenAPI polish and the 100k-ticket load check.

---

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **External requesters** (`allowExternalRequesters`) | when asked for | Deferred by ADR-0039 |
| **A production inbound adapter** | deploy | Verify the provider's signature, re-sign in ADR-0039's shape |
| `MFA_ENCRYPTION_KEY` kept apart from the database | deploy | A dump without it yields no second factors (ADR-0040) |
| A known token prefix can spend the token's 300/min | M9 review | Prefixes are public; the limit also caps Argon2 work. Consider an IP component |
| Tokens are unlimited per plan; service accounts hold no seat | spec decision | A plan-limit question, not isolation |
| A deletion request can leave a cached `ACTIVE` summary for up to 60 s | M9 review | An in-flight resolution can re-write the lookup cache after `invalidate`; bearer tokens have no epoch |
| The export lists every file's row before streaming | load check | Rows, not bytes; fine to tens of thousands |
| The back-office "Restore workspace" button was not walked in a browser | any time | Unit- and integration-tested |
| Plan-limit-reached notification (`DOMAIN.md` §8) | any time | Needs its own event, type and dedupe key |
| A usage-counter reconcile | any time | Nothing recomputes `KB_ARTICLES` or `STORAGE_BYTES` after a bug |
| Production storage needs the `staging/` lifecycle rule and the edge headers ADR-0037 names | deploy | Local MinIO sets the rule in `docker/minio/init.sh` |
| The inbound webhook is under the global throttler | deploy | Give the route its own limit or exempt it |
| CLAUDE.md says no raw SQL outside `packages/database`, but the lint allows `src/**/repositories/**` | docs | Align the rule with the lint |
| Requester receipt can repeat if a notify job stalls after commit | any time | Email-only, so there is no row to fold against |
| `ProjectionRepository` duplicates part of `UserOrgIndexRepository` | any time | Merge them |
| `pg` "client.query() while executing" deprecation warning in integration runs | any time | Present since M2 |
| Rule 3 can be engineered: an owner may assign their change to the only other admin | spec decision | What DOMAIN.md §2.3 says today |
| Per-member capabilities in the admin UI | any time | Member actions are offered by role |
| `next-themes` inline-script warning under React 19 | any time | Dev-only |
| Doc formatting drift | any time | Docs and API code are not Prettier-clean at 80 cols; commits skip the format hook |

## Running it

```bash
cp .env.example .env
pnpm install
docker compose up -d && docker compose up minio-init
pnpm db:bootstrap && pnpm db:migrate && pnpm db:generate
pnpm db:doctor                   # 6/6
pnpm db:seed                     # acme + globex: tickets of every type, assets, articles, inbound mail; password "patchgrid-demo"
pnpm test:schema
pnpm test:tenancy
pnpm test:authz
pnpm --filter @patchgrid/api run test:integration      # on Redis db 1, beside a dev API
pnpm --filter @patchgrid/database run test:integration
pnpm dev                         # www :3000, app :3001, api :4000; Mailpit UI :8025
```

Sign in at `http://app.lvh.me:3001` as `dana@patchgrid.test` to see two workspaces; Dana is also the
seeded operator at `http://admin.lvh.me:3001` (she enrols a TOTP factor on first sign-in). `rita@` is a
requester at Acme and `sam@` an agent. Notification email lands in Mailpit at `http://localhost:8025`;
files are served by MinIO at `http://localhost:9000`, a different site from `lvh.me` on purpose.

Scripting the API with curl, use `api.lvh.me:4000`, not `localhost`. The session cookies are scoped to
`.lvh.me`, so a `localhost` cookie jar stays empty and every call is a `401`.

## Gotchas paid for in M8

- **A bare string in a Zod object shape is not a schema.** `z.object({ kind: "operator" })` type-checks and
  throws the first time it parses; use `z.literal`. It crashed the workspace whenever a support session
  was active.
- **A role check is not a permission check.** The transition table decides by role, so a narrowed actor
  (support, a token) was offered an admin's buttons until `view()` asked `ticket:transition` first.
- **The revocation epoch revokes the second it was bumped in.** A token minted in the same second as a
  bump is dead; `bump(key, { before: true })` is how a recovery code ends older sessions but not its own.
- **A synchronous zip callback has no backpressure, and lib-storage ends a failed upload's stream with
  `close`, not `error`.** A drain wait on it never settles. Pipe a real stream into the upload.
- **Postgres cannot use an enum value in the transaction that adds it.** `DELETED` and the CHECKs that
  name it are two migrations.
- **Run `prisma migrate diff` before `mkdir` of the migration folder**, or the empty folder makes the diff
  fail and the SQL is empty.
- **Anything derived from a person's address can be recomputed by anyone who knew it.** Tombstone by id.

## Gotchas paid for in M6

- **A signature is over bytes.** Mount the raw body parser for the webhook path before Nest's JSON
  parser. In specs, send the signed body as a string: supertest JSON-encodes a `Buffer` when the content
  type is JSON, and the signature then fails.
- **mailparser takes the last of two `From:` headers**, and returns `In-Reply-To` with several ids as
  one string. Count the header lines; split on whitespace.
- **Postgres `text` refuses NUL.** An encoded-word in a subject decodes to one, and the insert fails
  every attempt.
- **Anything a sender chooses can be pre-claimed by a forger.** The Message-ID, the From address: key
  limits and duplicates on authenticated facts.
- **A retry after the commit repeats the commit's work.** Record "done" inside the transaction that does
  it, and make everything after it best effort.
- **gitleaks scans history.** A high-entropy dev fixture needs a reviewed fingerprint in
  `.gitleaksignore` with a reason.

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
