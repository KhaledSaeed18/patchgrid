/**
 * Registry of RFC 9457 Problem Details types.
 *
 * `ENGINEERING.md` §API conventions requires that every `type` URI the API emits
 * actually resolves — an error the reader can look up is worth the one MDX file it costs.
 *
 * This lives here for M0. It moves to `@patchgrid/contracts` the moment that package
 * exists, so the API and this site cannot disagree about what a type means.
 */
export type ProblemType = {
  readonly slug: string
  readonly status: number
  readonly title: string
  /** What actually happened. */
  readonly detail: string
  /** What the caller should do about it. */
  readonly resolution: string
}

export const PROBLEM_TYPES = [
  {
    slug: "validation-failed",
    status: 400,
    title: "Validation failed",
    detail:
      "The request body or query string did not match its schema. The response carries an `errors` array of `{ path, message, code }`.",
    resolution:
      "Correct the named fields and retry. Clients built against @patchgrid/contracts should not be able to reach this.",
  },
  {
    slug: "not-authenticated",
    status: 401,
    title: "Not authenticated",
    detail:
      "No valid session cookie or API token was presented, or the access token predates a revocation of the membership it names.",
    resolution:
      "Refresh the session, or sign in again. A token rejected immediately after a role change, a member being disabled, or a token being revoked is expected behaviour, not a bug.",
  },
  {
    slug: "plan-limit-reached",
    status: 402,
    title: "Plan limit reached",
    detail:
      "The organization is at a limit for its plan — agent seats, monthly tickets, attachment storage, automation rules or knowledge articles.",
    resolution:
      "Remove something, or ask an owner to change the plan. 402 is only ever a plan limit; it never means a permission problem.",
  },
  {
    slug: "not-permitted",
    status: 403,
    title: "Not permitted",
    detail:
      "The caller is authenticated but the action is not allowed for their role, relationship to the subject, or token scopes.",
    resolution:
      "This is returned for actions on records the caller can already see. A record they may not see returns 404 instead, so that existence is not disclosed.",
  },
  {
    slug: "tenant-mismatch",
    status: 403,
    title: "Tenant mismatch",
    detail:
      "The credential is bound to one organization and the request asserted another, via `Origin` or `X-Patchgrid-Tenant`.",
    resolution:
      "Select the right workspace. A session for one tenant can never act on another's, which is the point.",
  },
  {
    slug: "organization-suspended",
    status: 403,
    title: "Organization suspended",
    detail: "The organization has been suspended by a platform administrator.",
    resolution: "Contact support. Data is retained; nothing has been deleted.",
  },
  {
    slug: "not-found",
    status: 404,
    title: "Not found",
    detail:
      "No such record — or none the caller is permitted to see. The two are deliberately indistinguishable.",
    resolution:
      "Check the identifier. If you expected access, check with an administrator of the workspace.",
  },
  {
    slug: "invalid-transition",
    status: 409,
    title: "Invalid transition",
    detail:
      "The requested action is not a legal transition from the ticket's current status for its type. The `detail` names both.",
    resolution:
      "Read `availableActions` on the ticket; it lists exactly the transitions the caller may perform right now.",
  },
  {
    slug: "stale-write",
    status: 409,
    title: "Stale write",
    detail:
      "The `version` supplied with the update does not match the stored one — someone else changed the record first.",
    resolution:
      "Re-read the record, reconcile the changes, and submit again with the current version.",
  },
  {
    slug: "change-window-early",
    status: 409,
    title: "Change window has not opened",
    detail:
      "The change was started more than an hour before its planned start time.",
    resolution:
      "Retry with `confirm: true` to proceed anyway, or wait for the planned window.",
  },
  {
    slug: "conflict",
    status: 409,
    title: "Conflict",
    detail:
      "A uniqueness constraint was violated — a slug, a team name, a category name within its parent, an asset serial, or a knowledge-base slug.",
    resolution: "Choose a different value. Uniqueness is scoped per organization.",
  },
  {
    slug: "rate-limited",
    status: 429,
    title: "Rate limited",
    detail:
      "Too many requests from this IP, organization or API token. Limits are tightest on authentication, signup and slug lookup.",
    resolution: "Back off and retry. Automated clients should honour `Retry-After`.",
  },
  {
    slug: "internal-error",
    status: 500,
    title: "Internal error",
    detail:
      "Something failed on our side. The response carries a `correlationId` that matches a line in our logs, and no internal detail.",
    resolution:
      "Retry. If it persists, quote the correlation id — it is the whole bug report.",
  },
] as const satisfies readonly ProblemType[]

export function findProblemType(slug: string): ProblemType | undefined {
  return PROBLEM_TYPES.find((p) => p.slug === slug)
}
