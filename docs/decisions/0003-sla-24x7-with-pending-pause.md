# 0003 — SLA clocks run 24×7 and pause in `PENDING`

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

SLA targets need a clock model. Real ITSM tools offer business-hours calendars (Mon–Fri 09:00–17:00, holidays) and pause the clock while waiting on the requester. Business-hours math is a large feature (calendars, time zones, holiday tables, "add 4 business hours to Friday 16:00") and every other feature — worker, UI countdown, reports — depends on the clock model, so it must be fixed early.

## Options considered

1. **24×7, no pausing** — trivially simple; but a ticket waiting a week on the requester breaches through no fault of the desk, which makes breach data meaningless.
2. **24×7 with pause in `PENDING`** — simple arithmetic (`resolveBy += pausedDuration`), captures the most important real-world nuance.
3. **Business-hours calendars from day one** — most realistic; multiplies the effort of M2/M3 and delays the first demoable milestone substantially.

## Decision

Option 2. `respondBy` / `resolveBy` are stored absolute timestamps. Entering `PENDING` records `pausedAt`; leaving it adds the elapsed pause to `pausedMinutes` and shifts `resolveBy` by the same amount. The response clock never pauses. A priority change recomputes targets from `createdAt` plus accumulated pause. Reopening starts a fresh resolution clock. Full rules in `DOMAIN.md` §4.

## Consequences

- SLA computation is a pure function of `(createdAt, policy, pause events, now)` and is unit-tested without a database.
- The background scanner is a simple comparison against stored timestamps — no calendar evaluation per ticket per minute.
- Extension path: a `BusinessCalendar` entity and a `Clock` strategy that maps "N business minutes from T" to an absolute timestamp. Because targets are already stored as absolute timestamps, only the *computation* changes, not the storage or the scanner. This is a possible post-M8 stretch, not v1.
