# 0025 — An agent can belong to several teams

- **Status:** Accepted
- **Date:** 2026-09-22
- **Refines:** [0019](0019-rbac-model-and-enforcement.md) — agent visibility scope and team-lead capability

## Context

`Membership` carried a single optional `teamId`, and `Team` carried a single `leadId`. That makes three
ordinary situations unrepresentable:

- An agent who works both the Network queue and the Security queue — normal on any desk under ~30 people,
  which is every organization this product targets.
- Someone who *leads* one team while being a working member of another. `Team.leadId` points at a
  membership whose own `teamId` may be a different team, so "the lead of Network" and "a member of
  Network" could already disagree.
- `OWN_TEAM_ONLY` visibility (`RBAC.md` §4), which reads "tickets where `teamId` = their team" and has no
  meaning for an agent who is legitimately in two.

The shape matters beyond the feature, because `PermissionService.scopeFor()` returns the filter that
every list query applies. Changing it from `teamId = $1` to `teamId IN ($1, …)` after M2 means revisiting
every ticket query, the console queues, search, the SLA escalation target and the approval inbox.

## Options considered

1. **Keep one team per membership** and state it as a product rule. Simplest filter, simplest UI, and
   honest — plenty of small tools work this way. But it is a rule the product would spend its life
   apologising for, and the migration later is a schema change plus a rewrite of every scoped query.
2. **A `teamIds String[]` array column on `Membership`.** No join table, and Postgres can index it with
   GIN. But it cannot carry a composite foreign key (ADR-0023), so nothing prevents a team id from
   another tenant, and it cannot carry per-team attributes.
3. **A `TeamMembership` join table.** One more table, composite-FK-safe, extensible.

## Decision

Option 3.

```
T  Team            { id, orgId, name, description?, isActive }        -- unique (orgId, name)
T  TeamMembership  { orgId, teamId, membershipId, isLead, joinedAt }  -- PK (orgId, teamId, membershipId)
```

- **Team lead moves onto the join row** as `isLead`, replacing `Team.leadId`. A partial unique index
  allows several leads per team only if we later want it; v1 enforces at most one via
  `CREATE UNIQUE INDEX team_single_lead ON "TeamMembership" ("orgId", "teamId") WHERE "isLead"`. Storing
  leadership on the membership *in that team* makes "a lead is a member of the team they lead" a property
  of the key rather than an invariant to check.
- Both foreign keys are composite on `orgId` (ADR-0023), so a team from another tenant is unrepresentable.
- `Membership.teamId` is **removed**. `Invitation.teamId` stays — it seeds one initial team on acceptance.
- A lead must hold `AGENT` or above; enforced in the service and covered by the escalation tests.

### Consequences for the permission layer

`ScopeFilter` stops being "a `where` object" and becomes a **list of branches** that repositories combine:

```ts
type ScopeFilter =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "any"; branches: ScopeBranch[] };   // OR-of-branches, each index-friendly
```

For an `OWN_TEAM_ONLY` agent the branches are: tickets in any of my teams · tickets with no team ·
tickets assigned to me · tickets I watch. Expressing this as branches rather than one nested `OR` lets the
repository emit a `UNION ALL` of index-friendly queries instead of a single predicate Postgres cannot
serve from one index — which is the query that would otherwise become the product's first performance
problem on a large tenant. **This is the reason to make the decision now rather than in M4:** the return
type of `scopeFor()` is what is expensive to change, not the table.

Team-lead capabilities (`RBAC.md` §3) are unchanged in substance and now read: *scoped to each team where
`isLead` is true* — approve/reject Changes for that team, receive its SLA escalations, manage its
membership.

## Consequences

- One extra table and one extra join on the member-detail and team-detail screens. Ticket queries are
  unaffected: they filter `Ticket.teamId`, and the actor's team ids come from the request's cached
  membership context, not from a join per row.
- `GET /me` returns `teams: [{ id, name, isLead }]`; `TenantProvider` holds it, so the UI never re-derives
  team membership.
- `TEAM_MEMBER_ADDED` / `TEAM_MEMBER_REMOVED` / `TEAM_LEAD_CHANGED` join the audit catalogue
  (`RBAC.md` §12); `TEAM_LEAD_CHANGED` already existed and now records a `(teamId, membershipId)` pair.
- SLA escalation (`DOMAIN.md` §4.3) notifies "the lead of the ticket's team" — still exactly one person,
  because a ticket has at most one team. Unchanged.
- Change approval (`DOMAIN.md` §2.3) reads "a lead of the change's team", which is now a lookup on
  `TeamMembership` rather than a column comparison. Unchanged in rule.
- Reversal is cheap: a unique index on `(orgId, membershipId)` collapses it back to one team per member
  without touching queries.
