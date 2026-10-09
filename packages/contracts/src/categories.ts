import { z } from "zod"

import { idSchema } from "./id.ts"
import { MAX_CATEGORY_DEPTH } from "./limits.ts"
import { prioritySchema } from "./priority.ts"
import { ticketTypeSchema } from "./ticket-number.ts"

/**
 * The taxonomy (DOMAIN.md §5): up to `MAX_CATEGORY_DEPTH` levels, names unique
 * per parent, deactivated rather than deleted, each optionally routing to a
 * default team. Served flat; a client builds the tree from `parentId`.
 */
export const categoryNameSchema = z.string().trim().min(1).max(60)

export const categorySchema = z.object({
  id: idSchema,
  name: z.string(),
  parentId: idSchema.nullable(),
  depth: z.int().min(1).max(MAX_CATEGORY_DEPTH),
  defaultTeamId: idSchema.nullable(),
  isActive: z.boolean(),
  sortOrder: z.int(),
})
export type Category = z.infer<typeof categorySchema>

export const categoryListQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
})

export const createCategoryRequestSchema = z.object({
  name: categoryNameSchema,
  parentId: idSchema.optional(),
  defaultTeamId: idSchema.optional(),
})
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>

/** `parentId: null` moves a category to the top; a move that would pass three levels is refused. */
export const updateCategoryRequestSchema = z
  .object({
    name: categoryNameSchema,
    parentId: idSchema.nullable(),
    defaultTeamId: idSchema.nullable(),
    isActive: z.boolean(),
    sortOrder: z.int().min(0).max(10_000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { error: "must change at least one field" })
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>

/** One SLA policy (DOMAIN.md §4.1): targets per (type, priority), in minutes. */
export const slaPolicySchema = z.object({
  id: idSchema,
  ticketType: ticketTypeSchema,
  priority: prioritySchema,
  responseTargetMinutes: z.int().positive(),
  resolutionTargetMinutes: z.int().positive(),
  responseWarningMinutes: z.int().positive(),
  resolutionWarningMinutes: z.int().positive(),
})
export type SlaPolicy = z.infer<typeof slaPolicySchema>

const MAX_TARGET_MINUTES = 60 * 24 * 90

/** Changing a policy never retargets open tickets; it applies to tickets created or re-prioritised after. */
export const updateSlaPolicyRequestSchema = z
  .object({
    responseTargetMinutes: z.int().positive().max(MAX_TARGET_MINUTES),
    resolutionTargetMinutes: z.int().positive().max(MAX_TARGET_MINUTES),
    responseWarningMinutes: z.int().positive(),
    resolutionWarningMinutes: z.int().positive(),
  })
  .refine((v) => v.responseWarningMinutes < v.responseTargetMinutes, {
    error: "must be shorter than the response target",
    path: ["responseWarningMinutes"],
  })
  .refine((v) => v.resolutionWarningMinutes < v.resolutionTargetMinutes, {
    error: "must be shorter than the resolution target",
    path: ["resolutionWarningMinutes"],
  })
export type UpdateSlaPolicyRequest = z.infer<typeof updateSlaPolicyRequestSchema>
