# Handoff — M12 complete, M13 next

Written 2026-10-17, at the M12 boundary. **This file is regenerated, not appended to.** It is rewritten at every milestone boundary, and
whenever enough has landed that the previous version would mislead. If it disagrees with `FEATURES.md` or
an ADR, they are right and this is stale.

Read this first, then `CLAUDE.md`, then the documents it points at.

---

## What Patchgrid is

A **multi-tenant SaaS ITSM platform**: ticketing and operations for IT and security teams. It models four
ITIL record types (Incident, Service Request, Problem, Change), each with its own lifecycle. Priority is
_computed_ from impact × urgency, never typed into a dropdown.

It is a learning and portfolio project, built as though it were production: three deployables, tenants
addressed by subdomain, and tenant data isolated at the database level. **It is not deployed publicly**
(ADR-0047): it runs locally, and the hostnames below are the design, served locally under `lvh.me`.

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

**M0–M6 and M8–M12 are complete. M13 (Identity) is next**, then M14 and M7 last (ADR-0048). Milestone
numbers did not change.

**M12 (Insight): complete 2026-10-17.** Its exit holds: an admin's reports page answers "are we meeting
our SLAs, and where not?" in well under 100 ms at a hundred thousand tickets, with numbers the reconcile
holds to the tickets; an agent saves a view and acts on two hundred tickets at once, every refusal and
conflict reported per ticket. Four PRs (#49–#51 and this handoff), closed by a review (`THREAT-MODEL.md`
§9).

What M12 built:

- **The reporting read side** (ADR-0051). `TicketFact`, one tenant-owned row per ticket, holds what reports
  group by and what they measure, already computed by `factOf`: minutes to respond, minutes to resolve
  less the paused minutes, each clock's outcome (`MET`, `BREACHED`, `RUNNING`, `NONE`), with no "now" in
  it. The `reporting` consumer of M11's log refreshes the facts of the tickets a batch names, from the
  ticket as it is, guarded by `sourceVersion`. Every ticket write is in the log: edits and team-only
  assignments append `ticket-changed`. `reporting-reconcile` builds what the log never saw (at worker
  boot and nightly), holds the consumer's lock while it writes, and counts drift past a grace.
- **Reports**: `/reports/sla` (by priority, type, team, category or assignee; half-open ranges up to a
  year; `percentile_cont` medians and p90), `/backlog`, `/workload`, under `report:read`; a Reports page
  with tiles, one-hue meters, a backlog heat and CSV export. Every report under 25 ms at 100k tickets, so
  no rollups (`ENGINEERING.md`).
- **Saved views** (ADR-0052): a name and a list query, never results; run as the reader, so a view shared
  with a team shows each member their own tickets. A `priority` filter on lists, indexed.
- **Bulk actions** (ADR-0052): `POST /tickets/bulk`, up to 200 tickets, each through the single route's
  own `applyAssign` or `applyTransition` in its own transaction; per-ticket `done`, `conflict`, `refused`,
  `not-found` or `failed`; progress frames on the actor's own live stream; one run per member, throttled;
  approvals stay one decision at a time.

**CI is green on `main`.**

## Earlier milestones, in brief

- **M11** gave reliable delivery: the transactional outbox read as a per-tenant log below the snapshot
  horizon (ADR-0049), ticket notifications on it, outbound webhooks as its second consumer (ADR-0050),
  retention, and the event-age dashboard (`THREAT-MODEL.md` §8).
- **M10** shipped without a public deployment (ADR-0047): the demo seed, the marketing site and docs,
  production images and `docker-compose.prod.yml`, `pnpm local:up`, and the README.
- **M9** gave hardening: member MFA with step-up (ADR-0045), the browser suite, OpenTelemetry per tenant
  (ADR-0046), the security review (`THREAT-MODEL.md` §7), OpenAPI and the 100k load check.
- **M8** gave the platform layer: the back-office, support sessions, API tokens, deletion and data
  protection.
- **M6** gave email intake; **M5** attachments, assets and the knowledge base; **M4** the four record
  types; **M3** notifications, the live stream and the per-tenant sweeps.

The detail is in the git history of this file, at those boundaries.

## Tests at the boundary

| Suite | Count |
| --- | --- |
| `apps/api` unit | 1083 |
| `apps/api` integration | 240 (`test/reporting/` and `test/tickets/views-and-bulk` are M12's) |
| `pnpm test:tenancy` | 13 catalog + 37 (3 pointers skipped) |
| `pnpm test:authz` | 400 |
| `packages/database` unit / catalog | 8 / 13 |
| `packages/contracts` | 203 |
| `apps/app` unit | 64 |
| `apps/www` | 19 |
| `apps/app` browser suite | 8 scenarios |

## Decisions made in M12

| Decision | Where |
| --- | --- |
| Reports read a fact row per ticket, refreshed from the log and checked against the source; no rollups unless measured | ADR-0051 (erratum: reports describe tickets as they are now) |
| A saved view is a query run as its reader; a bulk action is the single action per ticket | ADR-0052 (erratum: the review's settlements) |
| Every ticket write is in the log, including those that notify nobody | ADR-0051 erratum |

---

## Recommended next steps — M13

`FEATURES.md` §M13, Identity. Its exit: a member signs in with a passkey and uses it for step-up; a
workspace with SSO configured sends its members to their identity provider, and a new member is
provisioned on first sign-in. In order:

1. **An ADR for passkeys**: WebAuthn registration and authentication (`@simplewebauthn/server`), where the
   credential lives (a platform-class table beside `UserMfaFactor`, since a passkey is a person's, not a
   workspace's), how it satisfies both the first factor and ADR-0045's step-up (`sua`), the challenge's
   home (Redis, spent once, like the MFA challenge's `jti`), and the RP id across `*.lvh.me`.
2. **Passkeys built**: register, sign in without a password, step up, list and revoke, in the account
   pages; a browser test with a virtual authenticator (Playwright's CDP WebAuthn).
3. **An ADR for per-tenant OIDC**: authorization code with PKCE against a Keycloak profile in Compose;
   routing by the workspace's verified email domain (`TENANCY.md` §5, stored, not yet used); just-in-time
   membership at a default role; "SSO required" mirroring `requireMfa`; what a break-glass owner keeps.
4. **SSO built**, the threat model's new boundary (an external identity provider), and the review.

Then M14 and M7, per `FEATURES.md`.

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **External requesters** (`allowExternalRequesters`) | when asked for | Deferred by ADR-0039 |
| The API image is ~525 MB of `node_modules` | any time | The Prisma CLI, Studio and TypeScript ride in as resolved peers of `@prisma/client` |
| `@nestjs/swagger` warns of duplicate `CreateDto`/`UpdateDto` names | any time | "Will throw in a future version"; name the DTO classes per module |
| `org:manage_plan` has no tenant route yet; it gets the step-up when it gets the route | spec decision | ADR-0045 |
| Tokens are unlimited per plan; service accounts hold no seat | spec decision | A plan-limit question, not isolation |
| A `complete` racing the attachment sweep can orphan a final object | any time | Suspected in the review; a leak, not a bypass |
| Raw SQL outside `prisma.transaction()` runs with no GUC (fail-closed) | any time | The second site appeared (the outbox sweep saw an empty log); `PrismaService.tx` throws outside a transaction, and the outbox uses it. Move the other raw repositories onto it |
| `db_transactions_per_request` counts interactive transactions only | docs | Every statement is in `db_client_operation_duration` |
| The SLA browser scenario waits up to four minutes for a real breach | any time | Passes on retry when the sweep lands late; a test clock would make it instant |
| The export lists every file's row before streaming | load check | Rows, not bytes; fine to tens of thousands |
| The back-office "Restore workspace" button was not walked in a browser | any time | Unit- and integration-tested |
| Plan-limit-reached notification (`DOMAIN.md` §8) | any time | Needs its own event, type and dedupe key |
| A usage-counter reconcile | any time | Nothing recomputes `KB_ARTICLES` or `STORAGE_BYTES` after a bug |
| CLAUDE.md says no raw SQL outside `packages/database`, but the lint allows `src/**/repositories/**` | docs | Align the rule with the lint |
| Parked outbox events have no replay | any time | They are on record in `EventDeadLetter` with their error; replay is an admin action to build with a dead-letter view (THREAT-MODEL §8) |
| An auto-disabled webhook endpoint emails nobody | any time | ADR-0050: audited as the system and shown on the settings page; a mail to the workspace's admins is the missing half |
| An email can be lost if Redis refuses it in the instant after a drain commits | any time | The inbox row is exactly-once with the cursor (ADR-0049); the email is queued after it, best effort. A `mail` consumer of the log would make it at-least-once |
| `ProjectionRepository` duplicates part of `UserOrgIndexRepository` | any time | Merge them |
| `pg` "client.query() while executing" deprecation warning in integration runs | any time | Present since M2 |
| Rule 3 can be engineered: an owner may assign their change to the only other admin | spec decision | What DOMAIN.md §2.3 says today |
| Per-member capabilities in the admin UI | any time | Member actions are offered by role |
| Doc formatting drift | any time | Docs and API code are not Prettier-clean at 80 cols; commits skip the format hook |
| A new workspace gets no starter KB articles | any time | `TENANCY.md` §4, ADR-0017 and `PROJECT.md` promise them; provisioning creates none |
| Joining by email domain is not built | spec decision | `TENANCY.md` §5 describes it; the domain is stored only |
| Per-host cookie pairs are never pruned to five | any time | `TENANCY.md` §6 and ADR-0024 say they are; `auth/cookies.ts` keeps them all |
| `POST /tickets/:id/comments` ignores `Idempotency-Key` | any time | Every other entity-creating `POST` honours it |
| Audit-log retention per plan is not enforced | any time | ADR-0028's two and seven years; the sweep covers notifications and exports only |
| `DOMAIN.md` §4.3 skips a warning against `createdAt`; the code uses the clock's own start | docs | The code is right; the doc needs the same correction ADR-0003 got |
| `DOMAIN.md` §8 offers a reassigned agent to keep watching; nothing does | spec decision | They can watch by hand |
| `TENANCY.md` §7 and ADR-0022 show `runAsTenant(orgId, fn)`; the code takes a `crossing` too | docs | `CLAUDE.md` has it right |
| Marketing LCP is 3.3 s on Lighthouse's mobile profile | any time | Five font files contend on simulated 4G; dropping the mono preload is the cheap lever, in `@patchgrid/ui` for both apps |

## If it is ever deployed

Dropped by ADR-0047, kept so that reversing it starts from a list rather than from memory. None of it
blocks M7.

| Item | Notes |
| --- | --- |
| Three registered domains: the product, attachments on their own registrable domain, an ops zone | ADR-0026, ADR-0037 |
| Wildcard certificate by DNS-01 through the delegated `_acme-challenge`; CAA; the renewal canary | `DNS.md` §3 |
| SPF, DKIM and DMARC progressed on evidence; MX for `inbound.` | `DNS.md` §4, ADR-0027 |
| SMTP has no credentials or TLS setting | `SMTP_HOST`/`SMTP_PORT` only; every real provider needs both |
| A production inbound adapter | Verify the provider's signature, re-sign in ADR-0039's shape |
| `MFA_ENCRYPTION_KEY` and `WEBHOOK_SECRETS_KEY` kept apart from the database and its backups | A dump without them yields no second factors and signs no webhooks (ADR-0040, ADR-0050) |
| `TRUST_PROXY_HOPS` set to the real hop count | Default 1; with a CDN in front it is 2, and a wrong value makes every per-IP limit attacker-chosen (THREAT-MODEL §7) |
| Production storage needs the `staging/` lifecycle rule and the edge headers ADR-0037 names | Local MinIO sets the rule in `docker/minio/init.sh` |
| A public demo needs a demo mode first (an ADR) | The seed shares one password: anyone could sign in as an owner, enrol a factor, request deletion or send invitations |
| Postgres that allows a `BYPASSRLS` migration role and `pgvector` | Many managed services refuse the first; self-hosted needs backups |
| HSTS with a short max-age first, `preload` last | `DNS.md` §3 |
| Ollama and `phishing-svc` sized for a server | M7 sizes them for a laptop |


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

## Gotchas paid for in M12

- **`FULL JOIN` needs an equality Postgres can hash.** `IS NOT DISTINCT FROM` is refused; join on
  `COALESCE(key, '')`.
- **A void function cannot be read by `$queryRaw`.** `pg_advisory_xact_lock` goes through `$executeRaw`.
- **`crypto.randomUUID()` exists only in secure contexts**, and development is plain http on `lvh.me`.
  `lib/idempotency.ts` builds ids from `getRandomValues`.
- **A component that owns a dialog unmounts with its parent's state.** Clear a selection after its
  results are read, not when they arrive.
- **The React compiler's lint refuses `setState` in an effect.** Derive what can be derived during render.
- **A base64url secret can contain `_`.** Split a token by its pattern, never by the separator; it failed
  one run in eight, twice, in two specs.
- **commitlint wants a lowercase subject** (`SLA` fails). Chain a push after `&&`, never `;`, or a
  rejected commit still pushes a partial series.

## Gotchas paid for in M11

- **Ids are assigned at insert, rows appear at commit.** An id-ordered cursor skips an event whose
  transaction commits after a later one's; read in transaction-id order below `pg_snapshot_xmin`.
- **A transaction that writes holds an id, and its own id is a horizon.** Take the drain's lock with an
  advisory lock (no id) and read before writing.
- **BullMQ deduplicates a job id until the job completes**, which drops exactly the wake that arrives
  mid-drain. Clear a pending flag when the work starts, not when it ends.
- **Raw SQL outside a transaction runs with no tenant and RLS answers "nothing"**, not an error. Use
  `PrismaService.tx`.
- **`pg_advisory_xact_lock` returns `void`**, which `$queryRaw` cannot decode; use `$executeRaw`.
- **A dev API is a second worker on the same database.** Its listener drains test events. `nest start
  --watch` respawns a killed server: stop the `pnpm … dev` process.
- **gitleaks fingerprints carry the commit SHA**, and a rebase-merge rewrites it. Use values no scanner
  flags (the webhook dev key is all zero bytes) or `// gitleaks:allow` on a public test vector.
- **CI's integration job does not read `.env.example`.** A spec that needs a non-default setting sets
  `process.env` itself.
- **A delayed job's id is a promise to BullMQ**: a failed job with the same id is kept and silently blocks
  a later add. Name jobs by what they are for (the scheduled time) and do not keep failed ones.

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
