# 0002 — Per-type state machines with one status enum and extension tables

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

Incidents, Service Requests, Problems and Changes share most fields (title, requester, assignee, team, priority, comments, audit) but differ in lifecycle and in a few type-specific attributes (a Change has a planned window and rollback plan; a Problem has a root cause and workaround). The original spec used one status list for all four types, which does not fit: Problems have no "waiting on requester" state, Changes need an approval gate.

## Options considered

1. **One `Ticket` table, one shared status list** — simplest schema; wrong domain model, forces every type through states that mean nothing to it.
2. **Four separate tables** (`Incident`, `ServiceRequest`, `Problem`, `Change`) — cleanest per-type typing; but comments, attachments, links, audit, queues, search and notifications all need to be written four times or through a polymorphic join. Very expensive for a solo project.
3. **One `Ticket` table + one `TicketStatus` enum holding the union of all statuses + per-type transition table in the service + extension tables (`ProblemDetails`, `ChangeDetails`) for type-specific fields** — shared machinery stays shared, type differences are explicit in code and in narrow tables.
4. **One table + a `Json` column for type-specific fields** — flexible but untyped, unindexable, and hides the domain model.

## Decision

Option 3. The Prisma enum `TicketStatus` contains every status any type can have. The Ticket service owns a `TRANSITIONS: Record<TicketType, Record<TicketStatus, TransitionRule[]>>` table; any transition not in that table is rejected with 409. `ProblemDetails` and `ChangeDetails` are 1:1 tables keyed by `ticketId`, created together with the ticket in the same transaction. `ChangeApproval` is a separate append-only table because a change may be rejected and resubmitted several times.

## Consequences

- One queue, one search, one comment thread implementation.
- The database cannot by itself prevent an Incident from being in `AWAITING_APPROVAL`; the service does, and the transition table is unit-tested exhaustively (every `(type, from, to)` pair).
- Adding a fifth type later means: enum values, a transition table entry, possibly one extension table.
- `REOPENED` is deliberately *not* a status; it is an action that moves the ticket to `IN_PROGRESS` and increments `reopenCount`, so list views never need to special-case it.
