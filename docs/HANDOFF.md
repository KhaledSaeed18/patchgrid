# Handoff — M4 complete, M5 next

Written 2026-10-14, at the M4 → M5 boundary (an unattended overnight run that finished M4 and went on
into M5). **This file is regenerated, not appended to.** It is rewritten
at every milestone boundary, and whenever enough has landed that the previous version would mislead. If it
disagrees with `FEATURES.md` or an ADR, they are right and this is stale.

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
complete 2026-10-09. **M3** (Time and attention): complete 2026-10-14.

**M4 (Four record types): complete 2026-10-14.** Every item is checked, and the exit criterion was walked
in headless Chromium (Playwright) against the seeded workspaces. The in-app browser had disconnected, so
see `FEATURES.md` §M4 for the walk-through:

- A Problem is raised from an incident and worked to resolved.
- A Change is raised for it, rejected and then approved by Network's lead, started early after
  confirmation, implemented and closed.
- A requester raises a service request.
- A fresh one-owner workspace ships a change by approving its own.

**CI is green on `main`.**

---

## What M4 built

### Data — `packages/database`

- Four tenant-owned tables, each with the template policy, composite keys and composite FKs, plus an
  isolation-suite entry with rows on both sides:
  - `ProblemDetails` and `ChangeDetails`, 1:1 with their ticket (ADR-0002);
  - `ChangeApproval`, append-only, one row per decision;
  - `TicketLink`, one fact per row in its canonical direction.
- CHECKs:
  - no self-links;
  - `RELATES_TO` stored lower id first;
  - a window that ends after it starts;
  - a rejection carries a reason;
  - only an approval may be self-approved.
- A partial unique index `TicketLink_one_survivor` means a duplicate stands for one survivor only.
- The type/status CHECK now lets a Problem be cancelled.
- Three new notification types: `CHANGE_AWAITING_APPROVAL`, `CHANGE_APPROVED`, `CHANGE_REJECTED`.
- The demo seed adds, per workspace:
  - Problems at every stage, caused by real incidents;
  - Changes in every state, one rejected then approved, one resolving a Problem;
  - watched incidents.

  Sam (Acme) and Tina (Globex) lead Network, so their approval inboxes have changes in them.

### API — `apps/api/src/tickets`

- **Transition tables as data** (`domain/transitions.ts`), for DOMAIN.md §2.2 and §2.3:
  - A Problem becomes a known error only with a workaround, and resolves only with a root cause.
  - A Change submits only with its whole plan (and names what is missing), and completes or rolls back
    only with outcome notes.
  - Starting a Change more than an hour early is a soft block: a `409 change-window-early`, retried with
    `confirm: true`.
  - Only the assignee or an admin starts an approved change.
- **Approval** (`TicketsService.approvalStanding`):
  - Rules 1 and 2 are the `ticket:approve_change` grant: an admin, or a lead of the change's team,
    never its requester or assignee.
  - Rule 3: an owner who is one of those may approve their own change, but only when
    `hasOtherApprover` finds nobody else, never as an API token, and never to reject. It is recorded as
    `selfApproved` and audited as `CHANGE_SELF_APPROVED`.
  - A rejection's comment is its reason.
  - A change awaiting approval keeps its assignee and team.
- **Details travel on the ticket**, versioned with it, and editable field by field as
  `capabilities.editableFields` says:
  - a Problem's analysis while it is worked;
  - a Change's plan only while it is a `DRAFT`;
  - its outcome once it is approved.

  A known error keeps its workaround, and a draft carries no outcome.
- **Links**: `GET`, `POST` and `DELETE /tickets/:id/links` (`links.service.ts`, `domain/links.ts`).
  - Seven readings map to four stored relations.
  - Both ends must be readable and linkable, and the named ticket is checked before anything about it
    is followed.
  - Duplicates are row-locked and follow their target to the survivor; chains and loops are refused.
  - A link whose far end the reader cannot see is not shown.
  - `LINK_KINDS_FROM` in contracts tells a form which kinds each type can start, held equal to the
    canonicalisation by a spec.
- **Create from**: `causedIncidentIds` raises a Problem from incidents, and `resolvesProblemId` raises a
  Change from a Problem. Both link in the create's transaction, only to tickets the agent can see and
  link.
- **Lists and notifications**:
  - The `approvals` view (a lead's teams, an admin's all, never your own) and a per-type filter;
    `OPEN_TICKET_STATUSES` now spans every type.
  - A submitted change notifies its approvers; a decision notifies its requester and assignee.
  - Auto-close also closes resolved Problems and implemented or rolled-back Changes.
- **`GET /me`** gains `creatableTypes`.
- **Own tickets**: an own-team agent reads and replies to tickets they raised wherever they are routed
  (the `own` condition on `ticket:read` and `comment:create_public`). Listing them is a requester branch
  that never grants `scope`, so the team the ticket was routed to still owns the work. RBAC.md §4 and
  ADR-0025's erratum.

### App — `apps/app`

- **New-ticket form**: offers `/me`'s `creatableTypes`, adds a Problem's workaround and a Change's plan
  (a Change saves as a draft), and supports `?incident=` and `?problem=` for "raise from".
- **Ticket page**:
  - the Problem's analysis, and the Change's plan, outcome and decisions (a self-approval labelled as
    one), each editable field by field;
  - the linked-tickets panel, with "raise a problem from this" and "raise a change for this";
  - a reason prompt for a rejection, and a confirmation for an early start.
- **Queues**: a type filter whose statuses follow the type, and "Awaiting my approval".

### Tests at the boundary

| Suite | Count |
| --- | --- |
| `apps/api` unit | 867 |
| `apps/api` integration | 118 |
| `pnpm test:tenancy` | 13 catalog + 32 (3 pointers) |
| `pnpm test:authz` | 380 |
| `packages/database` unit / catalog / integration | 8 / 13 / 23 |
| `packages/contracts` | 170 |
| `apps/app` | 49 |

Browser walkthroughs live in the git-ignored `apps/app/node_modules/.cache/shots/` (`m4.mjs`,
`solo.mjs`), run with `node` from `apps/app` against `pnpm dev`.

---

## M3, in brief

Notifications are in-app and email, written in one statement after commit. Every recipient is checked
by the same decision as opening the ticket (`TicketAudience`).

The live SSE stream (`org:<orgId>`, ADR-0036) re-checks the member every heartbeat. `apps/app` has the
bell, inbox, preferences, live refresh, watchers and comment edit/delete.

On the jobs side: a per-tenant dispatcher runs the SLA scan, auto-close, `projection-reconcile` and the
`attachment-sweep` scaffold; `audit-partition` runs daily and archives months past seven years.
The detail is in the git history of this file, at the M3 boundary.

## Decisions made in M3 and M4

| Decision | Where |
| --- | --- |
| `ticket-updated` reaches every reader, not only watchers; a stream lives no longer than its token and re-checks the member every heartbeat | ADR-0036 (refines 0008) |
| A notification, an email and a stream event about a ticket are reads of it — one `mayRead`, equal to `TicketAccess` by test | `notifications/audience.ts`, `authz/stream-fan-out.spec.ts` |
| The inbox orders by `updatedAt`; a fold moves a row up; email follows a new row, never a fold | `DOMAIN.md` §8, migration `20261014090000` |
| A requester's own ticket is confirmed by email only | `DOMAIN.md` §8 |
| Notify job ids key on the version the write made, never one read back after commit | `tickets.service.ts` |
| Notify before the read-back: an agent who moves a ticket out of their scope must not drop the notification with the `404` | `TicketsService.announce` |
| `audit-partition` stays a platform job — partitions belong to the table | `ARCHITECTURE.md` §Background jobs |
| Archived audit months leave `public` for `audit_archive`, so the catalog assertions keep holding | migration `20261014100000` |
| An agent's own ticket is readable and repliable wherever routed — `own`, not `scope` | RBAC.md §4, ADR-0025 erratum |
| Approvals are decided by the service as an "approval standing" fed to the pure transition table; rule 3 only when nobody else could | `TicketsService.approvalStanding` |
| A change awaiting a decision keeps its assignee and team; only its assignee or an admin starts it | DOMAIN.md §2.3 |
| Detail fields are named one by one in `editableFields`, so the UI never derives which are open from status | `PermissionService.capabilitiesFor` |
| A duplicate stands for one survivor, enforced by row locks and a partial unique index | DOMAIN.md §1, migration `20261014130000` |
| `/me` carries `creatableTypes`: a per-type grant a flat permission list cannot say | `MeService` |
| Sweeps notify but send no `ticket-updated` — hundreds of reads otherwise; the notification refreshes the page | ADR-0036 |

---

## Recommended next steps — M5

`FEATURES.md` §M5, in order:

1. **Resolve TM-1 first.** The attachment-serving host must be its own registrable domain, so that it
   never receives session cookies. Decide the host, `Content-Disposition: attachment`, and the inline
   allow-list in an ADR before any upload code exists.
2. **`Attachment`** (tenant-owned, with the full checklist): a presigned PUT with exact signed
   `Content-Length` and `Content-Type`; confirm by **byte sniffing** to `READY`; an allow-list without
   SVG or HTML; `org/<orgId>/…` keys; the storage quota incremented **and decremented**. The
   `attachment-sweep` scaffold then does its real work.
3. **`Asset`** and `TicketAsset`: CRUD, a picker on tickets, asset detail with ticket history, and
   requesters seeing their own. `scopeFor("asset")` already exists.
4. **`KnowledgeArticle`**: a per-org `tsvector`, `version`, three-tier visibility, portal search and
   suggestions on the new-ticket form.
5. Seed about 20 assets and 15 articles per org.

---

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **TM-1** attachment host is same-site | M5 | `files.` receives session cookies; needs its own registrable domain |
| **TM-2** platform actor resolved from the host | M8 | Same inversion ADR-0024 fixed for tenants |
| Plan-limit-reached notification (`DOMAIN.md` §8) | M8 | Not ticket-shaped (no circle); needs its own event, a `NotificationType`, and a dedupe key per metric and period. Deferred from M3 |
| Org suspension must bump every member's revocation epoch | M8 | Until then a running stream outlives a suspension by at most one token (≤ 15 min) |
| Requester receipt can repeat if a notify job stalls after commit | any time | Email-only, so there is no row to fold against. Fix: keep completed mail jobs for a TTL, or record the receipt |
| CLAUDE.md says no raw SQL outside `packages/database`, but the lint allows `src/**/repositories/**` | docs | Seven repositories use tagged `$queryRaw` (row locks, search, upserts, jsonb merge, partitions). Align the rule with the lint |
| `ProjectionRepository` duplicates part of `UserOrgIndexRepository` | any time | Merge them. Suspended orgs are not dispatched, so their picker rows are not reconciled |
| `pg` "client.query() while executing" deprecation warning in integration runs | any time | Present on the M2 baseline. One `Promise.all` inside a transaction is fixed; others remain |
| Rule 3 can be engineered: an owner may assign their change to the only other admin, leaving nobody eligible | spec decision | It is what DOMAIN.md §2.3 says (rule 1 excludes the assignee). Tighten it (count the assignee as able to approve for rule 3), or accept it |
| The owner's approval inbox omits changes only they could approve (rule 3) | UX | They see them on the ticket; the inbox excludes one's own changes |
| Approver eligibility is read without row locks | low | A promotion racing an owner's self-approval could let rule 3 apply a moment too long |
| Per-member capabilities in the admin UI | any time | Member actions are offered by role |
| `next-themes` inline-script warning under React 19.2 | any time | Dev-only |
| Doc formatting drift | any time | Docs and API code are not Prettier-clean at 80 cols; commits skip the format hook |

## Running it

```bash
cp .env.example .env
pnpm install
docker compose up -d && docker compose up minio-init
pnpm db:bootstrap && pnpm db:migrate && pnpm db:generate
pnpm db:doctor                   # 6/6
pnpm db:seed                     # acme + globex: incidents, problems, changes; every password "patchgrid-demo"
pnpm test:schema
pnpm test:tenancy
pnpm test:authz
pnpm --filter @patchgrid/api run test:integration      # on Redis db 1, beside a dev API
pnpm --filter @patchgrid/database run test:integration
pnpm dev                         # www :3000, app :3001, api :4000; Mailpit UI :8025
```

Sign in at `http://app.lvh.me:3001` as `dana@patchgrid.test` to see two workspaces. `rita@` is a
requester at Acme and `sam@` an agent. Notification email lands in Mailpit at `http://localhost:8025`.

Scripting the API with curl, use `api.lvh.me:4000`, not `localhost`. The session cookies are scoped to
`.lvh.me`, so a `localhost` cookie jar stays empty and every call is a `401`.

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

## Gotchas paid for in M3

- **Redis pub/sub ignores the database number.** The integration specs use Redis db 1, but a dev API and
  the specs share every channel. Only the org id in the channel name keeps them apart.
- **`Promise.all` inside an interactive transaction runs queries concurrently on one connection.** `pg`
  serialises them and warns. Inside `transaction()`, await reads one at a time.
- **A version read back after commit is not the version you wrote.** A concurrent write moves it, and two
  events then share a BullMQ job id; one is silently dropped. Key on `request.version + 1`.
- **A read-back can `404` after a successful write** when the write moved the ticket out of the actor's
  scope (a cross-team reassignment, or stopping watching). Do the side effects before reading back.
- **A detached partition becomes an ordinary `public` table** that the catalog assertions treat as
  tenant-owned and fail on. It also keeps FKs that block hard deletes. Move it out of `public`.
- **`EventSource` cannot send headers.** Tenant resolution for the stream relies on `Origin`, which the
  browser sends cross-origin. A reconnect refused with a `401` leaves it `CLOSED` for good; only the client
  can refresh and reopen.
- **`router.refresh()` keeps client state but remounts anything keyed by version.** The ticket page holds a
  live refresh while a dialog is open or a field is being typed in.

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
