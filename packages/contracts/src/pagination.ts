import { z } from "zod"

/**
 * Cursor (keyset) pagination (ADR-0012).
 *
 * Offset pagination is unstable under concurrent inserts — exactly the workload a
 * ticket queue has — and degrades at depth. Keyset is stable and O(1) at any
 * depth, at the cost of no page jumps, which queue views do not need.
 */

export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

export const paginationQuerySchema = z.object({
  /** Opaque. Clients pass back what they were given and never construct one. */
  cursor: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE, { error: `must be at most ${MAX_PAGE_SIZE}` })
    .default(DEFAULT_PAGE_SIZE),
})
export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    /** `null` on the last page. */
    nextCursor: z.string().nullable(),
  })
}

export type Page<T> = { items: T[]; nextCursor: string | null }

/**
 * A cursor is `(sortValue, id)` — the id breaks ties so the ordering is total,
 * which is what makes the keyset stable when two rows share a timestamp.
 *
 * Base64url-encoded to signal "opaque", not to hide anything: it carries a
 * timestamp and an id, neither of which is a secret. Any endpoint whose sort
 * column is sensitive would need a different approach.
 */
export type CursorParts = { sortValue: string; id: string }

export function encodeCursor({ sortValue, id }: CursorParts): string {
  return Buffer.from(JSON.stringify([sortValue, id]), "utf8").toString("base64url")
}

/** Returns `null` for anything unparseable — a malformed cursor is a 400, not a crash. */
export function decodeCursor(cursor: string): CursorParts | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!Array.isArray(decoded) || decoded.length !== 2) return null
    const [sortValue, id] = decoded
    if (typeof sortValue !== "string" || typeof id !== "string") return null
    return { sortValue, id }
  } catch {
    return null
  }
}

/** `?sort=-createdAt` — leading `-` is descending. */
export const sortParamSchema = z.string().regex(/^-?[a-zA-Z][a-zA-Z0-9]*$/, {
  error: "must be a field name, optionally prefixed with '-' for descending",
})

export function parseSort(value: string): { field: string; direction: "asc" | "desc" } {
  return value.startsWith("-")
    ? { field: value.slice(1), direction: "desc" }
    : { field: value, direction: "asc" }
}
