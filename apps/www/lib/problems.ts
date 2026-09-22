import {
  PROBLEM_TYPE_SLUGS,
  problemStatus,
  problemTitle,
  type ProblemTypeSlug,
} from "@patchgrid/contracts"

/**
 * Human explanations for the API's problem types.
 *
 * The **protocol** — which types exist and what status each carries — lives in
 * `@patchgrid/contracts`, because the API emits it and the web client switches on
 * it. Only the prose lives here.
 *
 * `Record<ProblemTypeSlug, …>` is the load-bearing part: adding a type in
 * contracts without explaining it here is a typecheck failure, so the page can
 * never silently fall behind the API.
 */
type ProblemCopy = {
  /** What actually happened. */
  readonly detail: string
  /** What the caller should do about it. */
  readonly resolution: string
}

const PROBLEM_COPY: Record<ProblemTypeSlug, ProblemCopy> = {
  "validation-failed": {
    detail:
      "The request body or query string did not match its schema. The response carries an `errors` array of `{ path, message, code }`.",
    resolution:
      "Correct the named fields and retry. Clients built against @patchgrid/contracts should not be able to reach this.",
  },
  "not-authenticated": {
    detail:
      "No valid session cookie or API token was presented, or the access token predates a revocation of the membership it names.",
    resolution:
      "Refresh the session, or sign in again. A token rejected immediately after a role change, a member being disabled, or a token being revoked is expected behaviour, not a bug.",
  },
  "plan-limit-reached": {
    detail:
      "The organization is at a limit for its plan — agent seats, monthly tickets, attachment storage, automation rules or knowledge articles.",
    resolution:
      "Remove something, or ask an owner to change the plan. 402 is only ever a plan limit; it never means a permission problem.",
  },
  "not-permitted": {
    detail:
      "The caller is authenticated but the action is not allowed for their role, relationship to the subject, or token scopes.",
    resolution:
      "This is returned for actions on records the caller can already see. A record they may not see returns 404 instead, so that existence is not disclosed.",
  },
  "tenant-mismatch": {
    detail:
      "The credential is bound to one organization and the request asserted another, via `Origin` or `X-Patchgrid-Tenant`.",
    resolution:
      "Select the right workspace. A session for one tenant can never act on another's, which is the point.",
  },
  "organization-suspended": {
    detail: "The organization has been suspended by a platform administrator.",
    resolution: "Contact support. Data is retained; nothing has been deleted.",
  },
  "not-found": {
    detail:
      "No such record — or none the caller is permitted to see. The two are deliberately indistinguishable.",
    resolution:
      "Check the identifier. If you expected access, check with an administrator of the workspace.",
  },
  "invalid-transition": {
    detail:
      "The requested action is not a legal transition from the ticket's current status for its type. The `detail` names both.",
    resolution:
      "Read `availableActions` on the ticket; it lists exactly the transitions the caller may perform right now.",
  },
  "stale-write": {
    detail:
      "The `version` supplied with the update does not match the stored one — someone else changed the record first.",
    resolution:
      "Re-read the record, reconcile the changes, and submit again with the current version.",
  },
  "change-window-early": {
    detail: "The change was started more than an hour before its planned start time.",
    resolution: "Retry with `confirm: true` to proceed anyway, or wait for the planned window.",
  },
  conflict: {
    detail:
      "A uniqueness constraint was violated — a slug, a team name, a category name within its parent, an asset serial, or a knowledge-base slug.",
    resolution: "Choose a different value. Uniqueness is scoped per organization.",
  },
  "rate-limited": {
    detail:
      "Too many requests from this IP, organization or API token. Limits are tightest on authentication, signup and slug lookup.",
    resolution: "Back off and retry. Automated clients should honour `Retry-After`.",
  },
  "internal-error": {
    detail:
      "Something failed on our side. The response carries a `correlationId` that matches a line in our logs, and no internal detail.",
    resolution: "Retry. If it persists, quote the correlation id — it is the whole bug report.",
  },
}

export type ProblemType = ProblemCopy & {
  readonly slug: ProblemTypeSlug
  readonly status: number
  readonly title: string
}

export const PROBLEM_TYPES: readonly ProblemType[] = PROBLEM_TYPE_SLUGS.map((slug) => ({
  slug,
  status: problemStatus(slug),
  title: problemTitle(slug),
  ...PROBLEM_COPY[slug],
}))

export function findProblemType(slug: string): ProblemType | undefined {
  return PROBLEM_TYPES.find((problem) => problem.slug === slug)
}
