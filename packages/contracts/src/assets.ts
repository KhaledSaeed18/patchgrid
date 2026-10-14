import { z } from "zod"

import { idSchema } from "./id.ts"
import { pageSchema, paginationQuerySchema } from "./pagination.ts"

/**
 * The CMDB (DOMAIN.md §9.3): what the organization owns, who has it, and the
 * tickets raised about it. A requester sees the assets they hold; agents see
 * them all (RBAC.md §6, `asset:read` / `asset:read_all`).
 */

/** Storage twin: Prisma's `AssetType`. */
export const assetTypeSchema = z.enum([
  "LAPTOP",
  "DESKTOP",
  "MONITOR",
  "PHONE",
  "TABLET",
  "PRINTER",
  "NETWORK",
  "SERVER",
  "SOFTWARE",
  "OTHER",
])
export type AssetType = z.infer<typeof assetTypeSchema>

/** Storage twin: Prisma's `AssetStatus`. A retired asset is kept for its history, never deleted. */
export const assetStatusSchema = z.enum(["IN_STOCK", "IN_USE", "IN_REPAIR", "RETIRED"])
export type AssetStatus = z.infer<typeof assetStatusSchema>

const nameSchema = z.string().trim().min(1).max(120)
const serialSchema = z.string().trim().min(1).max(100)
const notesSchema = z.string().trim().max(2000)
/** A calendar day, `2026-10-14` — a warranty ends on a date, not at an instant. */
const daySchema = z.iso.date()

const ownerSchema = z.object({ membershipId: idSchema, displayName: z.string() })

export const assetSchema = z.object({
  id: idSchema,
  name: z.string(),
  type: assetTypeSchema,
  status: assetStatusSchema,
  serialNumber: z.string().nullable(),
  owner: ownerSchema.nullable(),
  purchaseDate: daySchema.nullable(),
  warrantyExpiresAt: daySchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Asset = z.infer<typeof assetSchema>

/** What this actor may do to THIS asset — the buttons, from the server's answer (RBAC.md §7). */
export const assetCapabilitiesSchema = z.object({ canEdit: z.boolean(), canDelete: z.boolean() })
export type AssetCapabilities = z.infer<typeof assetCapabilitiesSchema>

export const assetDetailSchema = assetSchema.extend({
  notes: z.string().nullable(),
  /**
   * How many tickets name it — only for a reader who can open every ticket
   * (`null` otherwise), since a count of tickets one cannot see says something
   * about them. The ones this reader may open are `GET /tickets?view=all&assetId=…`.
   */
  ticketCount: z.int().nonnegative().nullable(),
  capabilities: assetCapabilitiesSchema,
})
export type AssetDetail = z.infer<typeof assetDetailSchema>

export const assetPageSchema = pageSchema(assetSchema)
export type AssetPage = z.infer<typeof assetPageSchema>

/** By name, then id. A requester's list is their own assets whatever the filter says. */
export const assetListQuerySchema = paginationQuerySchema.extend({
  /** Name or serial number, contains, case-insensitive. */
  q: z.string().trim().min(1).max(100).optional(),
  type: assetTypeSchema.optional(),
  status: assetStatusSchema.optional(),
  ownerMembershipId: idSchema.optional(),
})
export type AssetListQuery = z.infer<typeof assetListQuerySchema>

export const createAssetRequestSchema = z.strictObject({
  name: nameSchema,
  type: assetTypeSchema,
  status: assetStatusSchema.default("IN_STOCK"),
  serialNumber: serialSchema.optional(),
  ownerMembershipId: idSchema.optional(),
  purchaseDate: daySchema.optional(),
  warrantyExpiresAt: daySchema.optional(),
  notes: notesSchema.optional(),
})
export type CreateAssetRequest = z.input<typeof createAssetRequestSchema>

/** `null` clears an optional field. */
export const updateAssetRequestSchema = z
  .strictObject({
    name: nameSchema,
    type: assetTypeSchema,
    status: assetStatusSchema,
    serialNumber: serialSchema.nullable(),
    ownerMembershipId: idSchema.nullable(),
    purchaseDate: daySchema.nullable(),
    warrantyExpiresAt: daySchema.nullable(),
    notes: notesSchema.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { error: "must change at least one field" })
export type UpdateAssetRequest = z.infer<typeof updateAssetRequestSchema>

/** An asset as a ticket shows it: enough to recognise it, whoever is reading the ticket. */
export const linkedAssetSchema = z.object({
  id: idSchema,
  name: z.string(),
  type: assetTypeSchema,
  status: assetStatusSchema,
})
export type LinkedAsset = z.infer<typeof linkedAssetSchema>

/** Assets a ticket is raised about, at most this many at once. */
export const MAX_TICKET_ASSETS = 10
