# Handoff — M5 complete, M6 next

Written 2026-10-15, at the M5 → M6 boundary (the end of an unattended overnight run that finished M4 and
M5). **This file is regenerated, not appended to.** It is rewritten at every milestone boundary, and
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
| `api.patchgrid.xyz`    | `apps/api` | NestJS — all business logic and data access      |

Locally: `lvh.me:3000`, `<slug>.lvh.me:3001`, `app.lvh.me:3001`, `api.lvh.me:4000`.

---

## Where we are

**M0** (Foundation): complete 2026-09-22. **M1** (Tenancy and identity) and **M2** (Incident lifecycle):
complete 2026-10-09. **M3** (Time and attention) and **M4** (Four record types): complete 2026-10-14.

**M5 (Context: assets, knowledge, attachments): complete 2026-10-15.** Every item is checked. The exit
criterion was walked in headless Chromium against the seeded workspaces (`FEATURES.md` §M5), before and
again after the end-of-milestone adversarial review's fixes:

- Files attach to a ticket and to a reply, open from the files origin (`localhost:9000`), and a disguised
  SVG is refused.
- An asset shows its ticket history; a requester names her own phone on a new ticket; an agent links and
  unlinks an asset on a ticket.
- Articles are searched with stemming, suggested under a ticket's title as a requester types, written in
  markdown with a preview, published, and a stale save is refused in words.

**CI is green on `main`.** It had been red from the attachments commit until the integration job got the
compose file's MinIO (`ci.yml`, "Start object storage").

---

## What M5 built

### Attachments — ADR-0005, ADR-0037, ADR-0038

- **`Attachment`** (tenant-owned): its comment FK is `(orgId, ticketId, commentId)`, so a file cannot sit
  on another ticket's comment; CHECKs on size and on what `READY` implies.
- **Flow**: `POST /attachments` presigns one PUT of exactly the declared type and length and consumes
  `STORAGE_BYTES` → the browser PUTs to **`staging/<key>`** on the files origin → `POST
  /attachments/:id/complete` sniffs the first 4 KB (magic numbers; text must be UTF-8 with no markup),
  copies the object to `org/<orgId>/tickets/<ticketId>/<uuid>-<name>` and marks it `READY`.
- **Serving**: `GET /attachments/:id/download` is a 2-minute presigned GET of the final key, as the
  sniffed type, `attachment` disposition except for raster images. The files origin must not be under
  the root domain — the API refuses to boot otherwise.
- **Quota**: given back on delete of a `READY` file and by the sweep. A refused or unfinished upload keeps
  its quota until the hourly `attachment-sweep` removes it — by then its URL is long dead (ADR-0038).
  Deleting an unfinished upload is a `409`. A bucket lifecycle rule expires `staging/` after a day.
- A file on an internal note is as invisible as the note (`404`).

### Assets — DOMAIN.md §9.3

- **`Asset`** (closed `type` and `status` enums; serial unique per org; purchase and warranty as calendar
  `date`s) and **`TicketAsset`** (PK `(orgId, ticketId, assetId)`, composite FKs both ways).
- `GET/POST/PATCH/DELETE /assets`: a requester's list and reads are their own (`scopeFor("asset")`);
  agents write; admins delete — never an asset a ticket names (`409`, retire it instead).
- `PUT/DELETE /tickets/:id/assets/:assetId` is `ticket:link` plus an asset the actor can see; a
  requester names only their own, and only on create (`assetIds`). The ticket carries `assets` by name
  for every reader.
- "Tickets for this asset" is the ordinary list: `GET /tickets?view=all&assetId=…`. The new **`all`
  view** is every ticket the reader may read, in any status. An asset's `ticketCount` is shown only to a
  reader whose ticket scope is everything.

### Knowledge base — DOMAIN.md §9.2

- **`KnowledgeArticle`** with a generated, weighted `searchVector` (title A, body B) and a GIN index; a
  slug made from the title once, unique per org, never `new` or `edit`; CHECKs tie `publishedAt` to
  `PUBLISHED`.
- `GET /articles` (keyset by `updatedAt`), `GET /articles/search` (ranked, capped at 50),
  `GET /articles/by-slug/:slug` (the reading page, counts a view), `GET /articles/:id` (the editor),
  `POST`, `PATCH` (versioned, `409 stale-write`), `DELETE`.
- **One readable filter** for list, search and a single read: a requester gets published articles, an
  agent internal ones and their own drafts, an admin everything. Moving between tiers is `kb:publish`;
  returning an article to draft is its author's or an admin's. Articles count against `KB_ARTICLES`.
- **App**: `/knowledge` (search, list, visibility filter for agents), `/knowledge/[slug]` (markdown via
  `react-markdown` with no raw HTML and images replaced by their alt text), `/knowledge/new`,
  `/knowledge/edit/[id]` (write/preview tabs, the stale-save message), and "These might answer it
  already" under a new ticket's title.

### Seed

Per workspace: 20 assets in every status (most linked to the incidents about them) and 15 articles —
eleven published, three internal, one draft — with the `KB_ARTICLES` and `STORAGE_BYTES` counters set to
match.

### Tests at the boundary

| Suite | Count |
| --- | --- |
| `apps/api` unit | 905 |
| `apps/api` integration | 139 |
| `pnpm test:tenancy` | 13 catalog + 32 (3 pointers) |
| `pnpm test:authz` | 380 |
| `packages/database` unit / catalog / integration | 8 / 13 / 23 |
| `packages/contracts` | 179 |
| `apps/app` | 53 |

Browser walkthroughs live in the git-ignored `apps/app/node_modules/.cache/shots/` (`m4.mjs`,
`files.mjs`, `assets.mjs`, `kb.mjs`), run with `node` from `apps/app` against `pnpm dev`. `solo.mjs`
creates a `solo-*` workspace owned by a demo user each run; remove it before `db:seed --reset`, which
otherwise fails on `UserOrgIndex_userId_fkey`.

---

## M4 and M3, in brief

M4 gave every record type its transition table as data, change approval (rules 1–3, the owner's
self-approval only when nobody else could), versioned detail fields named one by one in
`capabilities.editableFields`, and ticket links stored once and read from both ends. M3 gave
notifications (in-app and email, one `mayRead` with opening the ticket), the live SSE stream and the
per-tenant sweeps. The detail is in the git history of this file, at those boundaries.

## Decisions made in M5

| Decision | Where |
| --- | --- |
| Attachments are served from their own registrable domain; the API refuses to boot otherwise | ADR-0037 |
| Uploads land in `staging/`; only checked bytes, copied out, are served; refused and unfinished uploads hold their quota until the sweep | ADR-0038 |
| Asset types and statuses are closed lists; purchase and warranty are calendar dates | DOMAIN.md §9.3 |
| Linking an asset is `ticket:link`; a requester names only their own, only on create; a ticket shows its assets to every reader | DOMAIN.md §9.3 |
| An asset a ticket names is retired, never deleted | DOMAIN.md §9.3 |
| An asset's history is the ticket list's new `all` view, so it is scoped like every list; its count only for whoever sees every ticket | `TicketsService.queueWhere`, `AssetsService.get` |
| One readable filter for an article's list, search and read; drafts are the author's (and admins'); returning to draft is theirs | DOMAIN.md §9.2 |
| An article's slug is fixed at creation, never `new` or `edit`; `publishedAt` is "published since" | DOMAIN.md §9.2, `RESERVED_ARTICLE_SLUGS` |
| Markdown renders without raw HTML or remote images | `components/markdown.tsx` |
| A raw query reaches the tenant only inside `prisma.transaction` — search included | `KnowledgeService.search` |

---

## Recommended next steps — M6

`FEATURES.md` §M6, email intake, in order:

1. **`InboundEmail` and the webhook**: signature-verified, `mailparser`, and the tenant resolved from the
   recipient address **before anything else** (ADR-0018). An unresolvable tenant is dropped.
2. **Sender authentication** (ADR-0027): the provider's DMARC-aligned verdict, then an active
   `Membership`. Unknown senders are dropped unless the org opts into badged external requesters. Never
   attribute silently.
3. **Threading** by `In-Reply-To` and `[INC-000042]` in the subject — only when the verified sender is a
   participant; otherwise a new, linked ticket.
4. **Attachment ingest** server-side, through the same allow-list, sniffing, size cap and quota as M5.
   It is the API writing, so it can put straight to the final key — no staging, no presigned URL.
5. Bounce and auto-reply detection, loop protection, and a dev harness posting a sample payload.

---

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **TM-2** platform actor resolved from the host | M8 | Same inversion ADR-0024 fixed for tenants |
| Plan-limit-reached notification (`DOMAIN.md` §8) | M8 | Needs its own event, a `NotificationType`, and a dedupe key per metric and period |
| Org suspension must bump every member's revocation epoch | M8 | Until then a running stream outlives a suspension by at most one token (≤ 15 min) |
| A usage-counter reconcile | M8 | Counters are kept in step by the writes and the seed; nothing recomputes `KB_ARTICLES` or `STORAGE_BYTES` after a bug |
| Production storage needs the `staging/` lifecycle rule and the edge headers ADR-0037 names | deploy | Local MinIO sets the rule in `docker/minio/init.sh` |
| Requester receipt can repeat if a notify job stalls after commit | any time | Email-only, so there is no row to fold against |
| CLAUDE.md says no raw SQL outside `packages/database`, but the lint allows `src/**/repositories/**` | docs | Repositories use tagged `$queryRaw` (row locks, search, upserts, jsonb merge, partitions, view counts). Align the rule with the lint |
| `ProjectionRepository` duplicates part of `UserOrgIndexRepository` | any time | Merge them |
| `pg` "client.query() while executing" deprecation warning in integration runs | any time | Present since M2 |
| Rule 3 can be engineered: an owner may assign their change to the only other admin | spec decision | What DOMAIN.md §2.3 says today. Tighten it or accept it |
| The owner's approval inbox omits changes only they could approve (rule 3) | UX | They see them on the ticket |
| Approver eligibility is read without row locks | low | A promotion racing a self-approval |
| Per-member capabilities in the admin UI | any time | Member actions are offered by role |
| `next-themes` inline-script warning under React 19 | any time | Dev-only; seen on a client-rendered 404 |
| Doc formatting drift | any time | Docs and API code are not Prettier-clean at 80 cols; commits skip the format hook |

## Running it

```bash
cp .env.example .env
pnpm install
docker compose up -d && docker compose up minio-init
pnpm db:bootstrap && pnpm db:migrate && pnpm db:generate
pnpm db:doctor                   # 6/6
pnpm db:seed                     # acme + globex: tickets of every type, assets, articles; password "patchgrid-demo"
pnpm test:schema
pnpm test:tenancy
pnpm test:authz
pnpm --filter @patchgrid/api run test:integration      # on Redis db 1, beside a dev API
pnpm --filter @patchgrid/database run test:integration
pnpm dev                         # www :3000, app :3001, api :4000; Mailpit UI :8025
```

Sign in at `http://app.lvh.me:3001` as `dana@patchgrid.test` to see two workspaces. `rita@` is a
requester at Acme and `sam@` an agent. Notification email lands in Mailpit at `http://localhost:8025`;
files are served by MinIO at `http://localhost:9000`, a different site from `lvh.me` on purpose.

Scripting the API with curl, use `api.lvh.me:4000`, not `localhost`. The session cookies are scoped to
`.lvh.me`, so a `localhost` cookie jar stays empty and every call is a `401`.

## Gotchas paid for in M5

- **A raw query outside `prisma.transaction` has no tenant.** The extension sets
  `app.current_org_id` only for model calls and transactions, so a bare `$queryRaw` under RLS returns
  nothing — the knowledge search came back empty until it was wrapped.
- **A presigned PUT is reusable until it expires.** Anything decided about "the uploaded object" must be
  about a copy the URL cannot reach (ADR-0038).
- **react-markdown hands every custom component a `node` prop.** Spreading props onto a DOM element
  passes it through; take `children` (and `href`, `alt`) only.
- **A static route shadows a dynamic one.** `/knowledge/new` would hide an article slugged `new`, so
  those slugs are reserved.
- **CI's service containers cannot run MinIO** (no `command`); the integration job starts the compose
  file's instead.

## Gotchas paid for in M4

- **`NOT (a = x OR b = x)` drops rows where `b` is NULL.** SQL's three-valued logic. The approval inbox
  went empty for every unassigned change until the exclusion named the NULL case.
- **A region-replace edit can swallow what sits between its two markers.** It cost a test block and a
  shared `select`. Anchor on one line.
- **Prisma's typed `include` with `as const` can hide a relation placed on the wrong model.** Use
  `satisfies Prisma.TicketInclude`.
- **A shadow database is reset by dropping `public` only.** A migration that creates another schema
  needs `IF NOT EXISTS`.
- **Base UI's `Button` rendering a `Link` needs `nativeButton={false}`**, and the element then carries
  `role=button`. Find it by text in tests.
- **Grid items size to their content by default.** A long title stretches a fixed sidebar column; give
  the column `minmax(0,1fr)` and the item `min-w-0`.

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
