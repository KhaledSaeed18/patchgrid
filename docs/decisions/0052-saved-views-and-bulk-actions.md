# 0052 — Saved views are queries; bulk actions are many single actions

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [0019](0019-rbac-model-and-enforcement.md) (scope as query branches), [0006](0006-explicit-transition-endpoint.md) (one way a status changes), [0008](0008-sse-for-in-app-notifications.md) (the live stream)

## Context

M12's second half: an agent saves a view and closes two hundred tickets in one action, with every
refusal and conflict reported per ticket. Both features are easy to build in a way that quietly goes
around the rules: a saved view that stores ticket ids, a bulk endpoint that writes `status` in one
`UPDATE`.

## Decision

### A saved view is a query, never its results

`SavedView` stores a name and the list query (`view`, `type`, `status`, `priority`, `sort`), validated by
the same contract as `GET /tickets`. Opening a view runs that query **as the person opening it**, so
`scopeFor()` decides what they see. A view shared with a team shows each member their own visible
tickets, never the author's. That is why sharing is safe, and why no view can widen anyone's sight.

- **Who:** agents and up (`view:manage`). Views are listed for their owner, plus those shared with a
  team the reader belongs to. Sharing is allowed only with a team the author belongs to.
- **Names** are unique per owner. A workspace's views are capped (`MAX_SAVED_VIEWS`) per person.
- The list query gains a **`priority`** filter, which is what "my critical tickets" needs.

### A bulk action is the single action, many times

`POST /tickets/bulk` takes an action (assign, or a transition with an optional comment) and up to
**200** tickets, each with the `version` the agent saw. The service runs **the same `assign` and
`transition` the single routes use**, one ticket at a time, **each in its own transaction**. So every
permission, transition guard, required comment, version check, audit row, outbox event and notification
is exactly what a single action would do. Nothing is re-implemented for bulk.

- **Per-ticket outcomes, never all or nothing.** Each ticket ends `done`, `conflict` (its version moved:
  someone else changed it), `refused` (not permitted, or the transition does not exist from its status),
  or `not-found` (it is not visible to the agent). The response lists every ticket's outcome, and a
  refusal carries the same `detail` the single action would have.
- **All-or-nothing was rejected.** One stale ticket would undo a hundred and ninety-nine good changes,
  and a version conflict is information the agent should act on, not a reason to lose their work.
- **Synchronous, bounded.** At 200 tickets and a few milliseconds each, the request finishes in seconds,
  so a job queue would add a result store and an actor to rebuild outside the request for nothing.
  The cap is what keeps that true. If a deploy cuts a bulk action short, a retry is safe: every ticket
  the first attempt changed now answers `conflict`, and the rest are done.
- **Progress over the live stream.** Every few tickets the service publishes a `bulk-progress` frame
  to the acting member's own streams (no one else's), so the page shows a progress bar while the
  request runs.
- **`ticket:bulk`**, agents and up, gates the route. Each ticket's own permission still decides each
  ticket.

## Consequences

- A bulk action costs what its single actions cost, two hundred times over, and is exactly as safe.
  That is the trade.
- A view belongs to its author's membership. A removed member's team-shared views stay listed for the
  team, and its author can no longer change them; removing them is the team lead's or an admin's.
- Notifications from a bulk action are one per ticket, as two hundred single actions would send. Folding
  them is the inbox's job (it already folds bursts per ticket), not the bulk endpoint's.
