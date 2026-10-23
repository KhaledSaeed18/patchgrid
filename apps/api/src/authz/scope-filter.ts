/**
 * The rows of a resource an actor may list (RBAC.md §4, ADR-0025).
 *
 * A **list of branches**, not one `where`: an `OWN_TEAM_ONLY` agent's tickets
 * are an `OR` across four columns that no single index serves, so a repository
 * runs one index-friendly query per branch and unions them (`UNION ALL`, then
 * de-duplicated by id). Each branch names a column, never a value from the
 * request.
 */
export type ScopeBranch =
  /** `teamId` is one of these. Never empty — an empty team list produces no branch. */
  | { kind: "teams"; teamIds: readonly string[] }
  /** `teamId IS NULL`. */
  | { kind: "no-team" }
  | { kind: "assignee"; membershipId: string }
  | { kind: "requester"; membershipId: string }
  /** A `TicketWatcher` row for this membership. */
  | { kind: "watcher"; membershipId: string }
  /** `ownerMembershipId` — assets. */
  | { kind: "owner"; membershipId: string }

export type ScopeFilter = { kind: "all" } | { kind: "none" } | { kind: "any"; branches: readonly [ScopeBranch, ...ScopeBranch[]] }

/** The resources whose lists are scoped per actor. Everything else is all-or-nothing by permission. */
export type ScopedResource = "ticket" | "asset"

/** The facts about one ticket a scope branch reads. */
export type ScopedTicket = {
  teamId: string | null
  assigneeMembershipId: string | null
  requesterMembershipId: string
}

/**
 * One ticket against a scope filter — the same branches a list query runs,
 * evaluated in memory. `watch` is whether the actor holds a `TicketWatcher`
 * row, which the caller loads. Opening a ticket, notifying about one and
 * streaming an event for one all decide visibility here, so they cannot drift.
 */
export function ticketInScope(filter: ScopeFilter, ticket: ScopedTicket, watch: boolean): boolean {
  if (filter.kind === "all") return true
  if (filter.kind === "none") return false
  return filter.branches.some((branch) => {
    switch (branch.kind) {
      case "teams":
        return ticket.teamId !== null && branch.teamIds.includes(ticket.teamId)
      case "no-team":
        return ticket.teamId === null
      case "assignee":
        return ticket.assigneeMembershipId === branch.membershipId
      case "requester":
        // Selects a member's own tickets into a list; being the requester is
        // `own`, decided on its own, never `scope` (RBAC.md §4).
        return false
      case "watcher":
        return watch
      case "owner":
        return false
    }
  })
}
