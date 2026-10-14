# Handoff — M3 complete, M4 next

Written 2026-10-14, at the M3 → M4 boundary. **This file is regenerated, not appended to.** It is rewritten
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

**M0** (Foundation): complete 2026-09-22. **M1** (Tenancy and identity): complete 2026-10-09. **M2**
(Incident lifecycle): complete 2026-10-09.

**M3 (Time and attention): complete 2026-10-14.** Every item is checked, and the exit criterion was walked
against the seeded workspaces in the dev stack, in Mailpit, and in a real browser. See `FEATURES.md` §M3
for the walk-through:

- SLA breaches fire from the live per-tenant dispatcher, are audited, and are emailed to the assignee and
  the admins.
- Live assignment toasts, bell counts, queue and ticket-page updates.
- A browser `EventSource` that receives nothing from the other tenant, and nothing about a ticket outside
  the agent's own-team scope.

**CI is green on `main`.**

---

## What M3 built

### Notifications: `apps/api/src/notifications/`

- **Fan-out** (`fan-out.ts`, pure). `deliveriesFor` decides who hears about an event, what they read, and
  by which channel (`inApp`, `email`), following `DOMAIN.md` §8. The rules:
  - never the actor, never a departed member, never anyone twice;
  - internal notes reach only the assignee;
  - a ticket's arrival reaches its team in-app only;
  - a requester raising their own ticket gets an emailed receipt rather than an inbox row;
  - status changes include the assignee, an implicit watcher;
  - a transition's comment rides with it and reaches whoever the move did not already tell.

  `mailingsFor` decides which deliveries also go by email: nothing while the org's kill switch is off,
  nothing of a type the member turned off, and for an inbox row only when the row is new. A burst is one
  email per unread thread.
- **Audience** (`audience.ts`). `TicketAudience.mayRead` makes `TicketAccess`'s decision for a recipient:
  the same subject, the same `scopeFor()` branches through the pure `ticketInScope`
  (`authz/scope-filter.ts`), the same `can()`, plus `comment:read_internal` for notes. Notifications,
  email and the stream all pass through it.
- **Delivery** (`notify.ts`):
  - `Notifier.notify`/`notifyAll` queue a `notify` job after commit, with `addBulk` for many. Job ids
    are keyed to the version the write made (`request.version + 1`); SLA job ids carry the deadline.
  - `NotifyService.deliver` loads the ticket's circle (fixed statement count) and writes every inbox row
    in **one** `INSERT … SELECT FROM unnest … ON CONFLICT` against the partial unique `dedupeKey` index.
    After commit it queues the emails.
  - `NotifyProcessor` publishes each row to the recipient's stream.
- **Inbox**:
  - `GET /notifications` is ordered and keyset-paged by `updatedAt`, so a folded burst moves to the top;
    the page and its unread count come from one transaction.
  - Mark one or all read.
  - `GET`/`PATCH /notifications/preferences` reads and merges `Membership.emailPrefs`, which stores only
    the types turned off, in one `jsonb ||` statement.
- **Live stream** (`live/`, ADR-0036). `GET /notifications/stream` is SSE on Redis pub/sub
  `org:<orgId>:notifications`:
  - **Notification frames** go to their one recipient.
  - **`ticket-updated` frames** go to every stream whose member may read the ticket, decided with no
    I/O from facts the event carries. A change to an internal note is marked `internal`.
  - **Lifetime:** a stream ends at the access token's expiry, and never later than 30 minutes. Every
    25-second heartbeat asks `auth/sessions/standing.service.ts` whether the session stands, and re-reads
    the member's role and teams. At most five streams per member per instance.
  - **Replay:** `Last-Event-ID` replays newer rows, best effort.
  - **Bus:** `StreamBus` registers a listener before the SUBSCRIBE it waits on, and forgets a channel
    whose SUBSCRIBE failed.
  - **Pulses:** `TicketPulse.changed` is called after every ticket, comment and watcher change.
- **Email**: the `ticket-notification` template (number and title, a link, and why this person heard,
  never a comment body), rendered in its tenant, from the org's name.

### Jobs

- **The dispatcher** (`jobs/dispatcher`) fans `sla-scan` (60 s), `auto-close` (15 min), `attachment-sweep`
  (hourly) and `projection-reconcile` (nightly) out per active tenant. Each job carries `orgId`, is refused
  without one, and runs under `runAsTenant`.
- **`sla-scan`** flags warnings and breaches with conditional writes, audits them, and notifies once
  everything has committed. **`auto-close`** notifies the requester and watchers.
- **`attachment-sweep`** (`jobs/maintenance`): a scaffold, wired end to end, that does nothing until M5.
- **`projection-reconcile`** (`memberships/projections`): recomputes `UserOrgIndex` from `Membership`
  with a pure plan, repairs any drift and warns. It reads the projection before its source, so a race can
  never write an older state.
- **`audit-partition`** (platform, daily): keeps a month ahead and archives months wholly past seven years
  into `audit_archive`, through `archive_expired_audit_log_partitions()` (`SECURITY DEFINER`, window fixed
  in the function, FKs dropped, grants revoked, 2 s lock timeout).

### `apps/app`

- **`LiveProvider`**: one `EventSource` per tab. It refreshes the inbox queries on a notification, raises
  the assignment toast, and refetches the inbox on every (re)open. When a reconnect is refused with a 401,
  it refreshes the session and reopens with a capped backoff, or sends the member to log in. The pure parts
  live in `lib/live.ts`, tested on fake timers.
- **`LiveRefresh`**: re-renders the queues, My tickets and the ticket page when tickets change. The ticket
  page also refreshes on a sweep's notification about its ticket. It holds off while a dialog is open or
  the member is typing.
- **Notifications UI**: the bell in the shell; `/notifications` (all or unread, paged, mark read);
  `/notifications/preferences`.
- **Ticket page**: a watchers panel (implicit pair, add, remove, watch/stop) and comment edit/delete, all
  from `capabilities`, `canEdit` and `canDelete`.

### Tests (counts at the boundary)

| Suite | Count |
| --- | --- |
| `apps/api` unit (`pnpm --filter @patchgrid/api test`) | 829 |
| `apps/api` integration | 106 |
| `pnpm test:tenancy` | 13 catalog + 32 (3 pointers) |
| `pnpm test:authz` | 380 |
| `packages/database` unit / catalog / integration | 8 / 13 / 23 |
| `packages/contracts` | 168 |
| `apps/app` | 49 |

New in M3:

- `test/support/queues.ts` awaits BullMQ jobs through `QueueEvents` instead of sleeping.
- `test/support/sse.ts` is an `EventSource` for specs. It proves absence with a sentinel event.
- `worker-timeline.spec.ts` runs the workers on the real `SystemClock` under `vi.useFakeTimers`.
- The isolation suite opens Dana's Acme stream with both workspaces' cookies and proves Globex never
  reaches it, and holds every sweep to its tenant.

---

## Decisions made in M3

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
| Sweeps notify but send no `ticket-updated` — hundreds of reads otherwise; the notification refreshes the page | ADR-0036 |

---

## Recommended next steps: M4

Follow `FEATURES.md` §M4, in order:

1. **`ProblemDetails`, `ChangeDetails`, `ChangeApproval`, `TicketLink`.** Each one is tenant-owned and
   needs a policy migration, composite `[orgId, id]` keys and composite FKs, a schema-coverage entry and
   grants. `TicketLink` needs canonical direction and uniqueness.
2. **The SR, Problem and Change transition tables** in `tickets/domain/transitions.ts` (empty for
   Problem and Change today), including the documented last-approver self-approval case and the
   `(type, status)` `CHECK`.
3. **Linking endpoints** and "create Problem from these incidents" / "create Change from this Problem".
4. **Notifications the new types bring.** "Change awaiting approval" goes to the team lead and admins;
   "approved/rejected" goes to the change's requester and assignee. Both slot into `deliveriesFor`
   behind two new `NotifyEvent` kinds and two `NotificationType` values (an enum migration plus the
   enum-parity test).
5. **Type-specific forms, per-type queues, and the approval inbox.**

---

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **TM-1** attachment host is same-site | M5 | `files.` receives session cookies; needs its own registrable domain |
| **TM-2** platform actor resolved from the host | M8 | Same inversion ADR-0024 fixed for tenants |
| Plan-limit-reached notification (`DOMAIN.md` §8) | M8 | Not ticket-shaped (no circle); needs its own event, a `NotificationType`, and a dedupe key per metric and period. Deferred from M3 |
| Org suspension must bump every member's revocation epoch | M8 | Until then a running stream outlives a suspension by at most one token (≤ 15 min) |
| `OWN_TEAM_ONLY` agent cannot read a ticket they raised for themselves when it is routed to another team | spec decision | `ticket:read` for AGENT is `scope` only. Consistent everywhere, but surprising. RBAC.md §4 would need an `own` branch |
| Requester receipt can repeat if a notify job stalls after commit | any time | Email-only, so there is no row to fold against. Fix: keep completed mail jobs for a TTL, or record the receipt |
| CLAUDE.md says no raw SQL outside `packages/database`, but the lint allows `src/**/repositories/**` | docs | Seven repositories use tagged `$queryRaw` (row locks, search, upserts, jsonb merge, partitions). Align the rule with the lint |
| `ProjectionRepository` duplicates part of `UserOrgIndexRepository` | any time | Merge them. Suspended orgs are not dispatched, so their picker rows are not reconciled |
| `pg` "client.query() while executing" deprecation warning in integration runs | any time | Present on the M2 baseline. One `Promise.all` inside a transaction is fixed; others remain |
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
pnpm db:seed                     # acme + globex, 29 incidents each; every password "patchgrid-demo"
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
