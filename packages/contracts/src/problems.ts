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
  "validation-failed": 400,
  "not-authenticated": 401,
  "plan-limit-reached": 402,
  "not-permitted": 403,
  "tenant-mismatch": 403,
  "organization-suspended": 403,
  "not-found": 404,
  "invalid-transition": 409,
  "stale-write": 409,
  "change-window-early": 409,
  conflict: 409,
  "rate-limited": 429,
  "internal-error": 500,
} as const satisfies Record<string, number>

export type ProblemTypeSlug = keyof typeof PROBLEM_TYPES

export const PROBLEM_TYPE_SLUGS = Object.keys(PROBLEM_TYPES) as ProblemTypeSlug[]

export function problemStatus(slug: ProblemTypeSlug): number {
  return PROBLEM_TYPES[slug]
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
