# Handoff — M9 complete, M10 next

Written 2026-10-16, at the M9 boundary. **This file is regenerated, not appended to.** It is rewritten at every milestone boundary, and
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

**M0–M6 and M8 are complete.** **The build order is M0–M6, then M8 → M9 → M10, and M7 last**: M7 is the
one milestone that needs local models (Ollama, embeddings, the phishing service), so it lands on a
running system. Milestone numbers did not change; `FEATURES.md` lists M7 last.

**M9 (Hardening): complete 2026-10-16.** Every item is checked and the exit criterion holds: the security
review has no open findings, the browser suite covers the core flows across two tenants with the negative
cases, and one dashboard answers "which tenant is slow". Each part landed as its own PR (#29, #30, #32,
#33), reviewed by CI, merged in order:

- **A second factor for members** (ADR-0045). Login stops at the password when a factor is confirmed;
  the account page sets one up, replaces its recovery codes and turns it off; an owner can require it of
  every member, which gates the next sign-in and never an open session; and the four irreversible
  actions — deleting the workspace, making a second owner (by promotion **or** invitation), granting
  support access, minting a token — ask for a fresh proof carried on the access token.
- **The browser suite** (`apps/app/e2e`, eight scenarios): signup → verification → a provisioned
  workspace → an invited agent → an incident worked and closed; an SLA breach on a two-minute target; a
  change from draft to closed with an approver who did not raise it; and the three negatives — a session
  for Acme reaching nothing of Globex, an agent refused every escalation, one person in two workspaces in
  two tabs. It runs on `main` only, against the built API and app.
- **Observability** (ADR-0046). The SDK starts before the application loads and only when an endpoint
  is named; every span carries the tenant; the request id is the trace id; the multi-tenant metrics with
  `org` bounded to the top-25 tenants; the compose profile with the dashboard.
- **The security review** (`THREAT-MODEL.md` §7). Three independent read-only reviews of every trust
  boundary; sixteen confirmed findings fixed with tests in one PR. The themes: budgets strangers could
  spend (the per-org throttle counted before the credential was verified; a token prefix spent its
  integration's budget), bearer capabilities in the wrong channel (a 24-hour export link in an inbox,
  invitation tokens in logs and spans), and two gaps in the step-up rule (a bare `pg_id` could enrol a
  factor; inviting an owner skipped the proof). Both HANDOFF items from M8 — the token prefix and the
  stale summary after a deletion request — closed here.
- **OpenAPI at `/api/docs`**, built from the Zod DTOs, tagged by path, with the two security schemes and
  examples; the smoke job asserts it is served.
- **The load check**: a hundred thousand tickets in one workspace, every list under 25 ms at p50, deep
  cursors no dearer than page one — and two branches whose index lacked the sort column, fixed. Results
  in `ENGINEERING.md` §Testing.

**CI is green on `main`**, the browser suite included once the per-IP throttle was switched off for the
runner (one address for the browser and the Next server alike).

---

## What M9 built — ADR-0045, ADR-0046, THREAT-MODEL §7

### Member MFA — ADR-0029, ADR-0045

- `POST /auth/login` with a confirmed factor answers `{ status: "mfa-required" }` and a five-minute
  `pg_mc` challenge, path-scoped to `/api/v1/auth`; `POST /auth/mfa` with a code or a recovery code
  completes it. A challenge completes once (its `jti` is spent in Redis). A wrong password is the same
  `401` as before.
- Self-service under `/auth/mfa` on `pg_id`: enrol **against the password** (the M9 review's erratum to
  ADR-0045), confirm (recovery codes shown once), replace the codes against a code, turn off against a
  code or a recovery code — never the password. Every change is mailed (`account-security`).
- `Organization.requireMfa` (owner-only `org:require_mfa`, audited `ORG_MFA_REQUIREMENT_CHANGED`) is
  checked at open, at login's mint and at refresh — a session already open is never ended by it. The
  picker sends a refused member to `/account/security?required=<slug>`.
- Step-up: `POST /auth/step-up` names the workspace and takes the factor — or the password only when no
  factor exists — and re-issues the pair with `sua` on the access token. `StepUpService.assert` runs
  after the permission in `OrgDeletionService.request`, `SupportService.grant`, `ApiTokensService.create`,
  `MembersService.changeRole` to `OWNER` and `InvitationsService.create` for `OWNER`. A refresh re-mints
  without the claim. The app has one `useStepUp()` dialog that re-proves and retries.
- A recovery code revokes everywhere with `{ before: true }`, so the session it earns survives.

### Observability — ADR-0030, ADR-0046

- `main.ts` is three lines: read `.env`, `startTelemetry()`, `require("./bootstrap")`. Off unless
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Not the Express or Nest instrumentations: they re-wrap every
  middleware and guard in their own async context and lost the request store the tenant resolver fills.
- `src/telemetry/metrics.ts`: plain functions over the global meter, instruments made on first use (the
  metrics API has no proxy provider). `org` is `TenantLabels` — top-25 by volume, ranked on the count
  before the observation, ties by id, halved past a window — then `other`, `none`.
- The HTTP span gets `org.id`, `membership.id`, `actor.kind` from `TelemetryMiddleware` on `finish`;
  jobs from `runJob`; every permission decision is an `authorization` span event. `genReqId` prefers the
  trace id. Query strings are dropped from request logs and `token`, `q`, `cursor` redacted from spans;
  Redis spans carry the command only.
- Pool saturation comes from the `pg` pool `createPrismaClient` now builds and hands to a callback.
- `docker/observability/`: collector → Tempo (traces) and Prometheus (metrics, which appends
  `_milliseconds`, `_ratio`, `_total`), Grafana provisioned with both and `patchgrid-tenants.json`.

### The security review — THREAT-MODEL §7

Sixteen findings, each with its resolution, in the threat model. The ones that changed a rule:

- The org throttler is registered in `AuthModule` **after** `AuthGuard`; the token throttler is keyed on
  prefix **and** address and runs before resolution; the verifier remembers rejected secrets per prefix.
- `OrganizationLookupService.invalidate` leaves a `:stale` marker for one TTL that `store` honours; API
  tokens are refused on `orgEpochKey(orgId)` from a deletion request until a cancel or restore
  (`RevocationEpochService.clear`).
- `SUPPORT_READ` records `params`; the export mail links to Settings; erasure tombstones
  `InboundEmail.fromAddress`; an inbound reference attaches a link only when the sender could have
  made it through the API; `/session/refresh` uses `parseNext`.
- Actions pinned to commits, mutable images to digests, Dependabot moves both; the browser suite's hosts
  are in the runner's hosts file; the webhook has its own per-address limit; `X-Request-Id` is honoured
  only in a proxy's shape.

### Tests at the boundary

| Suite | Count |
| --- | --- |
| `apps/api` unit | 1007 |
| `apps/api` integration | 204 |
| `pnpm test:tenancy` | 13 catalog + 37 (3 pointers skipped) |
| `pnpm test:authz` | 384 |
| `packages/database` unit / catalog | 8 / 13 |
| `packages/contracts` | 194 |
| `apps/app` unit | 59 |
| `apps/app` browser suite | 8 scenarios |

Browser walkthroughs live in the git-ignored `node_modules/.cache/shots/` at the repository root
(`mfa.mjs`, `review-ui.mjs`, `grafana.mjs`, `reset-alice.mjs`), run with `node` from the root against
`pnpm dev`; see the `browser-walkthrough-scripts` memory for the resolution and selector lessons. The
M8 scripts under `apps/app/node_modules/.cache/shots/` were lost with a `node_modules` wipe.

---

## Earlier milestones, in brief

- **M8** gave the platform layer: the operators' own credential and back-office, owner-granted
  read-only support sessions, scoped API tokens, workspace deletion with a 30-day window, streamed
  exports, self-service erasure and retention sweeps.
- **M6** gave email intake: signed raw MIME, the DMARC verdict, explicit-actor `createAs`/`addAs`, threading
  by our Message-ID or `[INC-…]`, and the inbound log.
- **M5** gave attachments through staging and byte sniffing on their own domain, the asset register and
  the knowledge base.
- **M4** gave transition tables as data, change approval and links read from both ends.
- **M3** gave notifications, the live stream and the per-tenant sweeps.

The detail is in the git history of this file, at those boundaries.

## Decisions made in M9

| Decision | Where |
| --- | --- |
| Login stops at the password; the policy gates the next authentication; step-up is a `sua` claim on the access token | ADR-0045 |
| Enrolling a factor takes the password | ADR-0045 erratum |
| The SDK starts before the app; instruments are lazy; `org` is top-25 and `other`; the trace id is the request id | ADR-0046 |
| Inviting an owner is the transfer of ownership, step-up included | THREAT-MODEL §7 (4) |
| Per-org limits count verified requests only | THREAT-MODEL §7 (1) |
| The export mail links to Settings, never to the archive | THREAT-MODEL §7 (7) |
| The browser suite runs on `main` only, without the per-IP throttle, hosts pinned locally | `ci.yml` |

---

## Recommended next steps — M10

`FEATURES.md` §M10, ship. Its exit: a stranger clones the repo, runs three commands, signs up and uses a
realistic system; the public demo is live; the README explains the decisions. In order:

1. **The demo seed**: two tenants across every type, age and status, KB, assets, inbound mail; an
   idempotent `db:reset`. `load:tickets` exists for volume.
2. **`apps/www` finished**: docs, pricing, blog, `/problems/*`, OG images, sitemap, robots, Lighthouse.
3. **Dockerfiles** (multi-stage `turbo prune`) for the three apps and `docker-compose.prod.yml`. The
   API's `main.ts` starts telemetry before the app; keep that order in the image's entrypoint.
4. **DNS and TLS** (ADR-0026, ADR-0027): wildcard, DNS-01 via the delegated zone, CAA, SPF/DKIM/DMARC,
   MX for `inbound.`.
5. **Deploy** on Coolify/Hetzner with managed Postgres, Redis and MinIO, migrations in a post-deploy
   hook, the nightly demo reset. **Set `trust proxy` to the real hop count** (THREAT-MODEL §7) and keep
   `MFA_ENCRYPTION_KEY` apart from the database.
6. **README**: diagram, screenshots, "why these decisions", run instructions.

Then M7, last, on the running system.

---

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **External requesters** (`allowExternalRequesters`) | when asked for | Deferred by ADR-0039 |
| **A production inbound adapter** | deploy | Verify the provider's signature, re-sign in ADR-0039's shape |
| `MFA_ENCRYPTION_KEY` kept apart from the database | deploy | A dump without it yields no second factors (ADR-0040) |
| `trust proxy` must match the deployment's hop count | deploy | With two hops every per-IP limit is attacker-chosen (THREAT-MODEL §7) |
| `org:manage_plan` has no tenant route yet; it gets the step-up when it gets the route | spec decision | ADR-0045 |
| Tokens are unlimited per plan; service accounts hold no seat | spec decision | A plan-limit question, not isolation |
| A `complete` racing the attachment sweep can orphan a final object | any time | Suspected in the review; a leak, not a bypass |
| Raw SQL outside `prisma.transaction()` runs with no GUC (fail-closed) | any time | A lint when a second site appears |
| `db_transactions_per_request` counts interactive transactions only | docs | Every statement is in `db_client_operation_duration` |
| The SLA browser scenario waits up to four minutes for a real breach | any time | Passes on retry when the sweep lands late; a test clock would make it instant |
| The export lists every file's row before streaming | load check | Rows, not bytes; fine to tens of thousands |
| The back-office "Restore workspace" button was not walked in a browser | any time | Unit- and integration-tested |
| Plan-limit-reached notification (`DOMAIN.md` §8) | any time | Needs its own event, type and dedupe key |
| A usage-counter reconcile | any time | Nothing recomputes `KB_ARTICLES` or `STORAGE_BYTES` after a bug |
| Production storage needs the `staging/` lifecycle rule and the edge headers ADR-0037 names | deploy | Local MinIO sets the rule in `docker/minio/init.sh` |
| CLAUDE.md says no raw SQL outside `packages/database`, but the lint allows `src/**/repositories/**` | docs | Align the rule with the lint |
| Requester receipt can repeat if a notify job stalls after commit | any time | Email-only, so there is no row to fold against |
| `ProjectionRepository` duplicates part of `UserOrgIndexRepository` | any time | Merge them |
| `pg` "client.query() while executing" deprecation warning in integration runs | any time | Present since M2 |
| Rule 3 can be engineered: an owner may assign their change to the only other admin | spec decision | What DOMAIN.md §2.3 says today |
| Per-member capabilities in the admin UI | any time | Member actions are offered by role |
| Doc formatting drift | any time | Docs and API code are not Prettier-clean at 80 cols; commits skip the format hook |
| **The public demo shares one password** | deploy | Anyone can sign in as a seeded owner, enrol a factor, request deletion or accept invitations; needs a demo mode (an ADR) before it is public |
| A new workspace gets no starter KB articles | any time | `TENANCY.md` §4, ADR-0017 and `PROJECT.md` promise them; provisioning creates none |
| Joining by email domain is not built | spec decision | `TENANCY.md` §5 describes it; the domain is stored only |
| Per-host cookie pairs are never pruned to five | any time | `TENANCY.md` §6 and ADR-0024 say they are; `auth/cookies.ts` keeps them all |
| `POST /tickets/:id/comments` ignores `Idempotency-Key` | any time | Every other entity-creating `POST` honours it |
| Audit-log retention per plan is not enforced | any time | ADR-0028's two and seven years; the sweep covers notifications and exports only |
| `DOMAIN.md` §4.3 skips a warning against `createdAt`; the code uses the clock's own start | docs | The code is right; the doc needs the same correction ADR-0003 got |
| `DOMAIN.md` §8 offers a reassigned agent to keep watching; nothing does | spec decision | They can watch by hand |
| `TENANCY.md` §7 and ADR-0022 show `runAsTenant(orgId, fn)`; the code takes a `crossing` too | docs | `CLAUDE.md` has it right |
| Marketing LCP is 3.3 s on Lighthouse's mobile profile | any time | Five font files contend on simulated 4G; dropping the mono preload is the cheap lever, in `@patchgrid/ui` for both apps |

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
pnpm --filter @patchgrid/app exec playwright install chromium
pnpm dev                         # www :3000, app :3001, api :4000; Mailpit UI :8025
pnpm --filter @patchgrid/app test:e2e                  # the browser suite, against the running stack
docker compose --profile observability up -d           # collector, Tempo, Prometheus, Grafana :3100
```

To see traces and the tenant dashboard, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in
`.env` and restart `pnpm dev`. The OpenAPI document is at `http://api.lvh.me:4000/api/docs`.

Sign in at `http://app.lvh.me:3001` as `dana@patchgrid.test` to see two workspaces; Dana is also the
seeded operator at `http://admin.lvh.me:3001` (she enrols a TOTP factor on first sign-in). `rita@` is a
requester at Acme and `sam@` an agent. Notification email lands in Mailpit at `http://localhost:8025`;
files are served by MinIO at `http://localhost:9000`, a different site from `lvh.me` on purpose.

Scripting the API with curl, use `api.lvh.me:4000`, not `localhost`. The session cookies are scoped to
`.lvh.me`, so a `localhost` cookie jar stays empty and every call is a `401`.

## Gotchas paid for in M9

- **Importing a module for one provider imports its global guards too.** `TelemetryModule` importing
  `AuthModule` registered `AuthGuard` ahead of tenant resolution and 500'd every tenant route. Provide
  the stateless service again instead.
- **The OpenTelemetry Express and Nest instrumentations lose `nestjs-cls`'s store** between the
  resolver and the guard. The HTTP instrumentation alone is enough; the route lands on the span from
  the middleware.
- **The metrics API has no proxy provider.** An instrument created before the SDK's meter is installed
  is a no-op forever; create them on first use.
- **The Prometheus exporter appends the unit to the name** (`_milliseconds`, `_ratio`) and `_total` to
  counters. Name instruments without a unit and query the suffixed names.
- **A tenant label that ranks after counting the current observation churns on ties.** Rank on the count
  before, break ties by id.
- **`page.check()` fails on a controlled checkbox that saves on change**: Playwright re-verifies before the
  server answers. Click with `noWaitAfter` and wait for the toast.
- **A TOTP code is spent per 30-second step.** Two verifications of one secret inside a step need the
  next step, or `lastUsedStep` reset in a test.
- **A runner is one address.** The per-IP throttle rationed the whole browser suite to 429s; off for
  that job, as for the integration specs.
- **A PR whose base branch is deleted is closed, not retargeted.** Stack on `main` or merge bottom-up
  and re-open.
- **Bind mounts can go stale under Docker Desktop** when a mounted file is replaced; restart the
  container.
- **commitlint's 100-character header rejects the commit but leaves the files staged**, and the next
  commit sweeps them in. Check `git log --stat` before pushing a series.

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
