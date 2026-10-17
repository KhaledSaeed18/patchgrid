# Handoff — M10 complete, M7 next

Written 2026-10-17, at the M10 boundary. **This file is regenerated, not appended to.** It is rewritten at every milestone boundary, and
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

**M0–M6, M8, M9 and M10 are complete. M7 is next, and last**: it is the one milestone that needs local
models (Ollama, embeddings, the phishing service), so it lands on a running system. Milestone numbers did
not change; `FEATURES.md` lists M7 last.

**M10 (Ship): complete 2026-10-17.** Its exit holds: a stranger clones the repository, runs
`pnpm install && pnpm local:up && pnpm dev`, signs up and uses a realistic system, and the README explains
the decisions. The two items that needed money and an operator, DNS/TLS and the public deployment, were
**dropped** by ADR-0047 rather than built: Patchgrid is a learning project and runs on a laptop. The
design they would have exercised stays in `DNS.md`, ADR-0026 and ADR-0027, and everything only a real
deployment would prove is in one list below, "If it is ever deployed".

What M10 built:

- **The demo seed**: Acme and Globex across every type, age and status, with assets, articles and
  inbound mail; one person in both. `pnpm db:reset` drops, re-migrates and re-seeds; `db:seed -- --reset`
  replaces only the two demo workspaces and refuses when a demo person belongs to anything else.
- **`apps/www` finished**: eight docs pages and four posts as MDX from one registry, every page a
  prerendered shell (Cache Components) with the session check streamed in, build-time OG cards, sitemap,
  robots, JSON-LD. Lighthouse locally: performance 90–98, accessibility and SEO 100.
- **Production images** (`turbo prune`): `patchgrid/api` and a `tools` image for migrations and the seed,
  standalone Next images for `app` and `www`, and `docker-compose.prod.yml` as the single-host shape.
  CI builds all three on every change and boots the API image to its configuration check.
  `TRUST_PROXY_HOPS` replaced the fixed hop count.
- **`pnpm local:up`**: one idempotent command from a clone to a seeded stack (`.env`, containers, roles,
  migrations, the 6/6 isolation checks, the seed).
- **The README**: the architecture diagram, four screenshots, "why these decisions" linking the ADRs,
  and the three commands.

**CI is green on `main`.**

## Earlier milestones, in brief

- **M9** gave hardening: member MFA with a step-up proof before the four irreversible actions (ADR-0045),
  the eight-scenario browser suite across two tenants, OpenTelemetry with top-25-tenant metrics and a
  Grafana dashboard (ADR-0046), the security review with sixteen findings fixed (`THREAT-MODEL.md` §7),
  OpenAPI at `/api/docs`, and the load check at a hundred thousand tickets.
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

## Tests at the boundary

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

M10 added no API behaviour; the counts are M9's.

## Decisions made in M10

| Decision | Where |
| --- | --- |
| No public deployment; the DNS, TLS and mail design stays a design; M7's models run in local Compose | ADR-0047 |
| The API image keeps the workspace's shape: packages as TypeScript source, not copied into `node_modules` | `ARCHITECTURE.md` §Production images |
| `TRUST_PROXY_HOPS` is configuration, default 1 | `ARCHITECTURE.md`, THREAT-MODEL §7 |

---

## Recommended next steps — M7

`FEATURES.md` §M7. Its exit: new tickets get an LLM suggestion an agent can accept; a phishing report is
scored and lands in the Security queue; likely duplicates surface with a merge action; admins define
automation rules that demonstrably fire — all per tenant, none blocking ticket creation. Everything runs
in the local Compose stack (ADR-0047). A suggested order, cheapest dependency first:

1. **The automation rule engine** (`DOMAIN.md` §10): needs no model, so it lands first and gives the
   seed its escalation rules. Per-tenant evaluation, per-rule execution audit, the admin UI.
2. **The ports and their `Noop` implementations** (`TicketClassifier`, `EmbeddingProvider`,
   `UrlRiskScorer`, ADR-0010), so every later item is testable without a model.
3. **Embeddings and similar tickets**: `nomic-embed-text` in Ollama, `TicketEmbedding` with a pgvector
   HNSW index under RLS, the similar-tickets panel scoped to the tenant, merge via `DUPLICATE_OF`.
4. **LLM triage**: the per-tenant `triage` queue, `TicketTriage`, accept/dismiss, gated on plan.
5. **`apps/phishing-svc`**: FastAPI around the thesis model, the "Report phishing" form, the risk badge,
   Security routing.
6. **The prompt-injection posture and its review against TB8**: model output is data an agent accepts,
   never an instruction and never auto-applied.

Write an ADR for each "as built" decision the way M8 and M9 did.

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **External requesters** (`allowExternalRequesters`) | when asked for | Deferred by ADR-0039 |
| The API image is ~525 MB of `node_modules` | any time | The Prisma CLI, Studio and TypeScript ride in as resolved peers of `@prisma/client` |
| `@nestjs/swagger` warns of duplicate `CreateDto`/`UpdateDto` names | any time | "Will throw in a future version"; name the DTO classes per module |
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
| CLAUDE.md says no raw SQL outside `packages/database`, but the lint allows `src/**/repositories/**` | docs | Align the rule with the lint |
| Requester receipt can repeat if a notify job stalls after commit | any time | Email-only, so there is no row to fold against |
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
| `MFA_ENCRYPTION_KEY` kept apart from the database and its backups | A dump without it yields no second factors (ADR-0040) |
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

## Gotchas paid for in M10

- **Node strips TypeScript at load, but not under `node_modules`.** The packages ship as source, so the
  API image keeps the workspace's shape with `packages/*` as real directories; `pnpm deploy`, which copies
  them into `node_modules`, fails at the first import.
- **`NEXT_PUBLIC_*` is inlined at build time.** A frontend image is built per environment; changing the
  variable at run time does nothing.
- **Prisma 7 removed `migrate reset --skip-seed`.** `db:reset` runs the reset and then the seed itself.
- **A Tailwind source scan across the monorepo picks up the other app's classes.** Each app scans only
  its own files.

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

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
