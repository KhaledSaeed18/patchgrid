import { z } from "zod"

/**
 * Identifiers.
 *
 * Every row Patchgrid creates gets a UUID v7 (ADR-0023): the time prefix keeps
 * B-tree inserts at the right edge of the index and makes `(orgId, createdAt DESC,
 * id DESC)` cursors monotonic, which the pagination design depends on.
 *
 * **Ids are not secrets.** v7 is time-ordered and partially predictable by
 * construction. No authorization decision anywhere may depend on an id being
 * unguessable — that is what `PermissionService` is for.
 */

/**
 * The wire schema is deliberately permissive about UUID *version*.
 *
 * A well-formed id we did not issue should produce `404` (the record does not
 * exist), not `400` (your input is malformed) — `RBAC.md` §11 makes reads of
 * invisible records indistinguishable from reads of absent ones, and a version
 * check would leak "this system only issues v7" for free. It would also break the
 * day we import data that predates the convention.
 */
export const idSchema = z.uuid({ error: "must be a UUID" })
export type Id = z.infer<typeof idSchema>

/**
 * Strict v7 check, for asserting our *own* generation — seeds, factories, and the
 * schema test. Not used on request input, for the reasons above.
 */
export const uuidV7Schema = z.uuid({ version: "v7", error: "must be a UUID v7" })

export function isUuidV7(value: string): boolean {
  return uuidV7Schema.safeParse(value).success
}
