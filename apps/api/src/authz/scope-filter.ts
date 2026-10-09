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

export type ScopeFilter =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "any"; branches: readonly [ScopeBranch, ...ScopeBranch[]] }

/** The resources whose lists are scoped per actor. Everything else is all-or-nothing by permission. */
export type ScopedResource = "ticket" | "asset"
