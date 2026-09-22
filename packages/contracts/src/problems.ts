import { z } from "zod"

/**
 * RFC 9457 Problem Details (ADR-0012).
 *
 * This module owns the *protocol*: which problem types exist, what status each
 * carries, and the shape on the wire. The prose explaining each one lives in
 * `apps/www`, keyed off `ProblemTypeSlug`, so adding a type here forces the
 * marketing site to explain it or fail typecheck.
 */

export const PROBLEM_BASE_URL = "https://patchgrid.xyz/problems"

/**
 * Every type the API may emit. The web client switches on these, so they are a
 * stable part of the wire contract — renaming one is a breaking change.
 */
export const PROBLEM_TYPES = {
  "validation-failed": { status: 400, title: "Validation failed" },
  "not-authenticated": { status: 401, title: "Not authenticated" },
  "plan-limit-reached": { status: 402, title: "Plan limit reached" },
  "not-permitted": { status: 403, title: "Not permitted" },
  "tenant-mismatch": { status: 403, title: "Tenant mismatch" },
  "organization-suspended": { status: 403, title: "Organization suspended" },
  "not-found": { status: 404, title: "Not found" },
  "invalid-transition": { status: 409, title: "Invalid transition" },
  "stale-write": { status: 409, title: "Stale write" },
  "change-window-early": { status: 409, title: "Change window has not opened" },
  conflict: { status: 409, title: "Conflict" },
  "rate-limited": { status: 429, title: "Rate limited" },
  "internal-error": { status: 500, title: "Internal error" },
} as const satisfies Record<string, { status: number; title: string }>

export type ProblemTypeSlug = keyof typeof PROBLEM_TYPES

export const PROBLEM_TYPE_SLUGS = Object.keys(PROBLEM_TYPES) as ProblemTypeSlug[]

export function problemStatus(slug: ProblemTypeSlug): number {
  return PROBLEM_TYPES[slug].status
}

/** The short summary that goes in the `title` field. */
export function problemTitle(slug: ProblemTypeSlug): string {
  return PROBLEM_TYPES[slug].title
}

/**
 * Maps a bare HTTP status onto a problem type, for errors that did not originate
 * as one — a framework 404, say. Anything unrecognised is an internal error,
 * because an unmapped status means we did not intend it.
 */
export function problemTypeForStatus(status: number): ProblemTypeSlug {
  switch (status) {
    case 400: return "validation-failed"
    case 401: return "not-authenticated"
    case 402: return "plan-limit-reached"
    case 403: return "not-permitted"
    case 404: return "not-found"
    case 409: return "conflict"
    case 429: return "rate-limited"
    default: return "internal-error"
  }
}

/** The `type` URI. These resolve — `apps/www` serves a page per type. */
export function problemTypeUrl(slug: ProblemTypeSlug): string {
  return `${PROBLEM_BASE_URL}/${slug}`
}

/** One field-level failure, for form mapping. */
export const problemErrorSchema = z.object({
  /** Dotted path into the request body, e.g. `slug` or `items.0.name`. */
  path: z.string(),
  message: z.string(),
  code: z.string(),
})
export type ProblemError = z.infer<typeof problemErrorSchema>

export const problemDetailsSchema = z.object({
  type: z.url(),
  title: z.string(),
  status: z.int().min(100).max(599),
  detail: z.string().optional(),
  /** The request path that produced it. */
  instance: z.string().optional(),
  /** Present on 400s from schema validation. */
  errors: z.array(problemErrorSchema).optional(),
  /**
   * Present on every 5xx, and equal to the request id in the logs. The UI shows
   * it in the error toast so a bug report is one copy-paste (ADR-0012).
   */
  correlationId: z.string().optional(),
})
export type ProblemDetails = z.infer<typeof problemDetailsSchema>

export const PROBLEM_CONTENT_TYPE = "application/problem+json"
