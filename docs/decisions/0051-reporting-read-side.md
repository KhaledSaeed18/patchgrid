# 0051 — Reporting: a fact row per ticket, refreshed from the log, checked against the source

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [0049](0049-transactional-outbox-as-a-tenant-log.md) (the log a consumer reads), [0003](0003-sla-24x7-with-pending-pause.md) (what the clocks measure)

> **Erratum (2026-10-17, the M12 review).** "Writes that already emit an event (create, assign, …)" was
> half true: an assignment that moved only the team, or unassigned, told nobody and so wrote nothing. It
> now appends `ticket-changed`. Also settled: the reconcile holds the consumer's own lock while it writes,
> so a batch read before a write cannot land after the consumer's refresh; a difference counts as drift
> only past a five-minute grace; times to resolve and their percentiles cover tickets with a resolution
> clock only; and a cancelled ticket still counts its response if that response had breached. **Reports
> describe tickets as they are now**: a ticket reopened and resolved again is counted in the month it was
> last resolved, with that resolution's outcome (THREAT-MODEL §9).

## Context

M12 asks one question first: are we meeting our SLAs, and where not? And it asks it by priority, team,
category and agent, over a date range, in under 100 ms at a hundred thousand tickets.

The live tables are the wrong place to ask it. `Ticket` is shaped for the write side: its indexes serve
queues and keyset pages, its times are clock origins and deadlines rather than durations, and its
paused minutes only mean something next to the clock they paused. A report computed over it would
repeat the SLA arithmetic in SQL, and slow every queue it shares a buffer pool with.

The log alone is not enough either. Its events carry ids, not the facts a report groups by. Some writes
tell nobody and so write no event: an edit that changes priority, team or category is one. And the
demo seed's tickets were written before the log existed.

## Decision

### One fact row per ticket, shaped for the questions

`TicketFact` is tenant-owned and keyed `(orgId, ticketId)`. It holds what a report groups by (type,
priority, team, category, assignee) and what it measures, **already computed**:

- **`responseMinutes`**: from the response clock's start to the first response, `null` while
  unanswered.
- **`resolutionMinutes`**: from the resolution clock's start to resolution, **less the paused minutes**.
  This is the same arithmetic as ADR-0003, done once, in one place, so a report never re-derives a clock.
- **Each clock's outcome as a state**: `MET`, `BREACHED`, `RUNNING` or `NONE` (no policy). A stopped clock
  is `BREACHED` if the scan flagged it or it stopped after its deadline. A running clock is `BREACHED` only
  once the scan has flagged it, in the breach's transaction, which also writes the event that refreshes
  the fact. So a fact is a pure function of its ticket, with no "now" in it, and the same ticket always
  builds the same fact.
- The **lifecycle times** a range filters on (created, resolved, closed) and a coarse state
  (`OPEN`, `RESOLVED`, `CLOSED`, `CANCELLED`).

The fact also records the **ticket `version` it was built from**. A write only replaces a fact built from
an older version, so two refreshes racing cannot put an older state over a newer one.

Indexes follow the queries: `(orgId, resolvedAt)` for what was resolved in a range, `(orgId, createdAt)`
for what was raised, `(orgId, state, createdAt)` for the backlog.

### Refreshed by a consumer of the log, from the ticket as it is

The `reporting` consumer does not interpret events. It reads the **set of tickets** a batch of events
names, loads them in one query, and upserts their facts in one statement, in the transaction that moves
its cursor. A replay, a duplicate or an event it has never heard of costs a redundant refresh, never a
wrong number. New ticket writes need no change to reporting; they only need to be in the log.

So the log gains **`ticket-changed`**, appended by every ticket write that tells nobody (an edit today).
The `notify` consumer skips it, as it skips anything not in its catalogue. Writes that already emit an
event (create, assign, transition, comment, the sweeps' SLA flags and closes) need nothing more.

### Rebuilt and checked from the source

One job, **`reporting-reconcile`**, walks a tenant's tickets in keyset batches and recomputes their
facts from `Ticket` with the same function the consumer uses. It runs nightly per tenant and is how a
fact table is **built** for history the log never saw: the seed, or anything past the log's 30-day
retention. Every fact it has to change is **drift**: counted on a metric and logged. Drift means the
log missed a write, which is a bug, the way the org picker's projection treats it (ADR-0022).

### Queries over facts, rollups only if measured

Reports aggregate `TicketFact` directly: counts, compliance ratios, and `percentile_cont` for median and
p90 time to resolve, grouped and filtered by the indexes above. **Daily rollup tables are deliberately not
built.** Rollups are a second, staler copy with their own invalidation problem, and the fact table already
turns a report into one indexed scan per tenant. The 100k load check is the arbiter: if a report misses
100 ms there, a rollup is the next step and this ADR is amended.

### Who may read reports

`report:read`, for admins and owners. Reports cover the whole workspace, so they ignore an agent's
visibility scope, and that is why they are not an agent's. A team lead's view of their own team is a
later decision. Reads follow the usual rule: a report is a list, never a `404`.

## Consequences

- Reporting is eventually consistent: a fact follows its ticket by a drain, milliseconds normally, and
  the dashboard's event-age panel shows when it lags.
- A new reportable field is a column on the fact, a line in the one function that builds it, and a
  reconcile that fills it in for history.
- The facts duplicate data that also lives on `Ticket`. That duplication is the read model: it is
  derived, rebuildable and checked, never written by anything but the consumer and the reconcile.
- Purge, isolation coverage and retention treat `TicketFact` like any tenant-owned derived table.
