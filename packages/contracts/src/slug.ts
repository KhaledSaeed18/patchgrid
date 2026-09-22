import { z } from "zod"

import { isReservedSlug } from "./reserved-slugs.ts"

/**
 * Organization slugs — the tenant's subdomain (ADR-0014).
 *
 * One schema validates the signup form, the availability endpoint, and tenant
 * resolution, so the three can never disagree about what is legal.
 */

export const SLUG_MIN_LENGTH = 3
export const SLUG_MAX_LENGTH = 30

/**
 * Alphanumeric groups joined by single hyphens.
 *
 * This one expression carries four rules at once: no leading hyphen, no trailing
 * hyphen, no `--` (which would collide with the punycode `xn--` prefix), and
 * lowercase only. Writing them as separate refinements produces worse messages
 * and lets them drift apart.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const slugSchema = z
  .string()
  .min(SLUG_MIN_LENGTH, { error: `must be at least ${SLUG_MIN_LENGTH} characters` })
  .max(SLUG_MAX_LENGTH, { error: `must be at most ${SLUG_MAX_LENGTH} characters` })
  .regex(SLUG_PATTERN, {
    error:
      "may use lowercase letters, numbers and single hyphens, and must start and end with a letter or number",
  })
  .refine((value) => !isReservedSlug(value), { error: "is reserved" })

export type Slug = z.infer<typeof slugSchema>

/** Why a candidate slug was rejected — the availability endpoint returns this. */
export type SlugRejection = "too-short" | "too-long" | "invalid-characters" | "reserved" | "taken"

/**
 * Format and reservation only. Uniqueness is a database question, so `"taken"` is
 * never returned from here.
 */
export function checkSlugFormat(value: string): SlugRejection | null {
  if (value.length < SLUG_MIN_LENGTH) return "too-short"
  if (value.length > SLUG_MAX_LENGTH) return "too-long"
  if (!SLUG_PATTERN.test(value)) return "invalid-characters"
  if (isReservedSlug(value)) return "reserved"
  return null
}
