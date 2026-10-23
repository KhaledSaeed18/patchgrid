import type { Role } from "@patchgrid/contracts"

/** Someone who could ever decide a Change: an active human admin or owner, or a lead of its team. */
export type ApproverCandidate = { membershipId: string; role: Role }

/**
 * Who can decide this Change (DOMAIN.md §2.3), given everyone who could
 * decide changes at all and the change's own requester and assignee:
 *
 * - `others`: somebody uninvolved — rules 1 and 2;
 * - `self`: the one person in the workspace able to decide is an owner, and
 *   involved — rule 3, the one-admin workspace;
 * - `nobody`: everyone able to decide is involved, and there is more than one
 *   of them. Rule 3 is for a workspace with nobody else, not for one whose
 *   other admin was made the assignee, so this change cannot be decided as it
 *   stands, and submitting it is refused.
 */
export function approvalRoute(candidates: readonly ApproverCandidate[], involved: readonly (string | null)[]): { kind: "others" } | { kind: "self"; ownerMembershipId: string } | { kind: "nobody" } {
  const unique = [...new Map(candidates.map((c) => [c.membershipId, c])).values()]
  if (unique.some((c) => !involved.includes(c.membershipId))) return { kind: "others" }
  const [sole, ...rest] = unique
  if (sole !== undefined && rest.length === 0 && sole.role === "OWNER") return { kind: "self", ownerMembershipId: sole.membershipId }
  return { kind: "nobody" }
}
