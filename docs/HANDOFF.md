# Handoff — M11 complete, M12 next

Written 2026-10-17, at the M11 boundary. **This file is regenerated, not appended to.** It is rewritten at every milestone boundary, and
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

**M0–M6 and M8–M11 are complete. M12 (Insight) is next**, then M13, M14 and M7 last (ADR-0048): four
architecture milestones before the models. Milestone numbers did not change.

**M11 (Reliable delivery): complete 2026-10-17.** Its exit holds: a committed change's side effects
cannot be lost or repeated (kill the worker between commit and delivery and the notification still
arrives, once); one tenant's flood costs another a batch, not the flood; a tenant subscribes an endpoint,
receives signed deliveries, sees failures retried, paused and parked, and replays them. Each part landed
as its own PR (#42–#47), and an adversarial review closed it (`THREAT-MODEL.md` §8).

What M11 built:

- **The transactional outbox, read as a per-tenant log** (ADR-0049). `OutboxEvent` is written in the
  change's own transaction (`Outbox.append` refuses anywhere else) and read in `(txn, id)` order below
  `pg_snapshot_xmin`, so no reader moves past an event that commits late. Each consumer has a cursor in
  `EventConsumer` and writes its rows in the cursor's transaction: exactly once. A statement trigger
  `pg_notify`s on commit; `OutboxListener` turns that into drain requests (one waiting drain per tenant,
  `SET NX` cleared on start) and catches up at worker boot; `outbox-sweep` is the minute's safety net.
  Drains are serialised by `pg_try_advisory_xact_lock`, take a batch and yield. A failing batch is narrowed
  to its event, which backs off on the cursor (2 s, 8 s, 32 s) and is parked in `EventDeadLetter`;
  transient database errors are never the event's fault.
- **Ticket notifications** moved onto it: the `notify` queue is gone, `NotifyConsumer` writes inbox rows
  in the drain's transaction, email and the live stream follow the commit.
- **Outbound webhooks** (ADR-0050) as the log's second consumer: thin payloads (ids and states, never
  words, never internal notes) from a public catalogue in the contracts; the Standard Webhooks signature
  with `whsec_` secrets sealed under `WEBHOOK_SECRETS_KEY` and rotated with a 24-hour overlap; attempts that
  claim their delivery, honour a per-endpoint circuit with one probe, sign and send through `postSafely`
  (every resolved address checked in the connection's own `lookup`, IPv6 as an allow-list, no redirects,
  10 s); retries `0s 5s 5m 30m 2h 5h 10h` with jitter, then dead and replayable; a per-tenant in-flight
  lease in Redis (Lua). Settings → Webhooks with the delivery log; `/docs/webhooks` for receivers.
- **Retention**: finished deliveries and fully-read events past 30 days, never ahead of a cursor, never
  under a pointer.
- **Observability**: event age when consumed (per tenant, buckets to 15 minutes), drains by outcome,
  parked events, on the tenant dashboard.
- **`PrismaService.tx`**: raw SQL on tenant tables throws outside a transaction instead of reading
  nothing under RLS.
- **`pnpm local:up`** adds the variables `.env.example` gained to an existing `.env`.

**CI is green on `main`.**

## Earlier milestones, in brief

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
| `apps/api` unit | 1049 |
| `apps/api` integration | 227 (`test/events/` and `test/webhooks/` are M11's) |
| `pnpm test:tenancy` | 13 catalog + 37 (3 pointers skipped) |
| `pnpm test:authz` | 388 |
| `packages/database` unit / catalog | 8 / 13 |
| `packages/contracts` | 200 |
| `apps/app` unit | 59 |
| `apps/www` | 19 |
| `apps/app` browser suite | 8 scenarios |

## Decisions made in M11

| Decision | Where |
| --- | --- |
| Four architecture milestones (M11–M14) before M7; webhooks and per-tenant OIDC in scope | ADR-0048 |
| The outbox is a per-tenant log read below the snapshot horizon, consumers keep cursors, handlers write with them | ADR-0049 (erratum: email is best effort) |
| Webhooks: thin signed events, at least once, a circuit with one probe, SSRF checked at connect, no token manages them | ADR-0050 (erratum: the review's settlements) |
| Raw SQL on tenant tables goes through `PrismaService.tx` | `ARCHITECTURE.md` §The outbox |

---

## Recommended next steps — M12

`FEATURES.md` §M12, Insight. Its exit: an admin's reports page answers "are we meeting our SLAs, and where
not?" in under 100 ms at a hundred thousand tickets, with numbers that agree with the tickets; an agent
saves a view and closes two hundred tickets in one action, every refusal and conflict reported per
ticket. In order:

1. **An ADR for the read side.** The log's events carry ids, not the facts a report groups by (priority,
   team, category), so the likely shape is a `reporting` consumer that refreshes a per-ticket fact row
   from the ticket as it is, plus daily rollups for closed days and a live query for today. Decide where
   time-to-respond and time-to-resolve are computed (the SLA clocks already pause) and how a rebuild runs.
2. **The read model and its consumer**, under RLS, with the 100k load check repeated against it.
3. **Reports** in the app: SLA compliance by priority, team and category; median and p90 time to
   resolve; backlog age; workload; CSV export. A reconcile that recomputes a day from source.
4. **Saved views and bulk actions**, with a per-ticket outcome and progress over the live stream.

Then M13, M14 and M7, each per `FEATURES.md`.

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

## Gotchas paid for in M10

- **Node strips TypeScript at load, but not under `node_modules`.** The packages ship as source, so the
  API image keeps the workspace's shape with `packages/*` as real directories; `pnpm deploy`, which copies
  them into `node_modules`, fails at the first import.
- **`NEXT_PUBLIC_*` is inlined at build time.** A frontend image is built per environment; changing the
  variable at run time does nothing.
- **Prisma 7 removed `migrate reset --skip-seed`.** `db:reset` runs the reset and then the seed itself.
- **A Tailwind source scan across the monorepo picks up the other app's classes.** Each app scans only
  its own files.

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
