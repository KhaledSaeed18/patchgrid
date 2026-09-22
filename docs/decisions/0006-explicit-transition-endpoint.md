# 0006 — State changes through an explicit transitions endpoint

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

Status changes carry rules: who may perform them, required comments, SLA clock side effects, audit entries, notifications. If `status` is just another field on `PATCH /tickets/:id`, those rules end up scattered through a generic update method with `if (dto.status)` branches.

## Options considered

1. **`PATCH /tickets/:id { status }`** — conventional REST; hides intent, mixes field edits with lifecycle, hard to attach "requires a comment" semantics.
2. **One endpoint per action** (`/resolve`, `/close`, `/approve`, …) — very explicit; a dozen near-identical controller methods.
3. **`POST /tickets/:id/transitions { action, comment?, reason?, assigneeId?, teamId? }`** — one endpoint, one service method (`TicketService.transition`), one transition table lookup, one audit path. The action vocabulary is a Zod enum in `@patchgrid/contracts`.

## Decision

Option 3. `PATCH /tickets/:id` updates ordinary fields only and rejects `status` and `priority`. The transitions endpoint returns the updated ticket plus the list of `availableActions` for the current user, so the UI never has to replicate the transition table.

## Consequences

- `GET /tickets/:id` also returns `availableActions`; buttons render from it.
- Invalid transitions are `409` with a Problem Details `detail` naming the current status and the attempted action — good error messages for free.
- The audit log entry for a transition has a uniform shape `{ action, from, to }`.
- The automation engine and the auto-close job call the same service method, so rules are enforced for machines exactly as for humans.
