# 0019 — RBAC: cumulative roles, a permission catalog, and a pure policy function

- **Status:** Accepted — team scoping extended by [0025](0025-multi-team-membership.md)
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** `GET /me` returning a flat permission list cannot express conditional grants
> ("update **own** tickets **while `NEW`**"), so the UI would have had to re-derive rules — the thing this
> ADR forbids. The contract adds `capabilities` per subject alongside `availableActions` (`RBAC.md` §7).
> `scopeFor()` returns a **list of branches** rather than one predicate, because `OWN_TEAM_ONLY` is an `OR`
> across four columns that no single index serves. "Team lead is a capability" is unchanged but now lives
> on `TeamMembership.isLead` (ADR-0025). `403 → 404` is stated as a rule rather than a judgement call.

## Context

The first draft specified a capability table for tickets and little else: the platform admin was one sentence, "team lead" was a dangling capability, agent visibility was hard-coded to "everything in the org", and there was no stated contract for how a permission check is written, where it lives, or how it is tested. A ticketing product is mostly an access-control product wearing a form; the authorization model deserves the same rigour as the tenancy model.

## Options considered

**Model**
1. **Role checks inline** (`if (user.role !== 'ADMIN') throw`) — what most tutorials do. Rules end up scattered, duplicated between API and UI, and impossible to enumerate or test as a whole.
2. **Full ABAC / policy engine** (CASL, Casbin, OPA) — expressive and genuinely powerful; a large dependency and a second language to reason in, for a role set of four plus three relationship modifiers.
3. **A permission catalog with cumulative roles and a pure `can(actor, permission, subject)` function**, plus a `scopeFor()` filter for list queries — enumerable, testable as a table, no new runtime dependency, and the same shape a policy engine would give if we later needed one.

**Agent visibility**
1. Hard-coded "all tickets in the org" — simple; wrong for any desk above a certain size, and retrofitting row-scoping later touches every ticket query.
2. **An org setting** (`ALL_TICKETS` | `OWN_TEAM_ONLY`) expressed once as a scope filter.

**Watchers**
1. Requester + agents only — the simplest permission model.
2. **A `TicketWatcher` table** granting public-content read access and notifications independent of role.

## Decision

Option 3 for the model, plus the org setting and watchers.

- Roles are strictly cumulative: `REQUESTER ⊂ AGENT ⊂ ADMIN ⊂ OWNER`, on `Membership` (ADR-0017).
- **Team lead is a capability, not a role** — `Team.leadId` grants exactly three things scoped to that team: approve Changes, receive SLA escalation, manage that team's membership.
- A stable **permission catalog** of `resource:action` strings, mirrored as a union type in `@patchgrid/contracts`, is the source of truth (`RBAC.md` §6).
- `PermissionService.can()` is **pure**: role, subject and relationship flags in, boolean out, no I/O. The service loads whatever the decision needs into a `Subject` first. That purity is what makes an exhaustive matrix test possible without a database.
- `scopeFor(actor, resource)` returns the filter repositories apply to list queries, so agent visibility, requester scoping and watcher access are expressed once rather than re-implemented per endpoint.
- **Deny by default**: an unknown permission is false and logs an error.
- `GET /me` returns the actor's permission list so the UI renders from the server's answer instead of re-deriving rules — the UI reflects authorization, it never defines it.
- `403` becomes `404` wherever existence itself is sensitive.

## Consequences

- The matrix is testable as data: an exhaustive `(role × permission × relationship)` table, plus a **route-coverage test** that reflects over every controller route and fails CI if one has neither `@Public`/`@TenantOptional` nor a permission assertion. That test is the real protection against an unguarded endpoint shipping.
- Adding a feature means adding permissions to the catalog and rows to the matrix; forgetting either fails the suite rather than silently allowing access.
- Authorization stays orthogonal to tenancy: `can()` never considers `orgId`, because by the time it runs, RLS and host binding have already guaranteed a single tenant. Conflating the two is how subtle leaks happen.
- Watchers introduce access that is not role-derived, which is exactly why it is worth modelling: it forces the permission layer to accept relationship inputs rather than assuming role is sufficient.
- If the rules ever outgrow this — per-field policies, customer-authored rules — the migration path is to back `can()` with CASL or OPA while keeping the same interface. Nothing above the interface changes.
