import { z } from "zod"

import { supportStateSchema } from "./support.ts"

import { emailSchema } from "./auth.ts"
import { idSchema } from "./id.ts"
import { permissionSchema } from "./permissions.ts"
import { slugSchema } from "./slug.ts"
import { ticketTypeSchema } from "./ticket-number.ts"
import { agentVisibilitySchema, planSchema, roleSchema } from "./tenancy.ts"

/**
 * `GET /me` (RBAC.md §7): who the caller is in THIS workspace. `permissions`
 * is role-level — what the role may ever do — and drives navigation only;
 * per-record buttons come from each record's own `capabilities`. `user` is
 * `null` for a service account, which has no human behind it (ADR-0021).
 */
export const meSchema = z.object({
  user: z.object({ id: idSchema, email: emailSchema, name: z.string() }).nullable(),
  membership: z.object({
    id: idSchema,
    role: roleSchema,
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  org: z.object({
    id: idSchema,
    name: z.string(),
    slug: slugSchema,
    plan: planSchema,
    agentVisibility: agentVisibilitySchema,
    /** Every member must hold a confirmed second factor to open this workspace (ADR-0045). */
    requireMfa: z.boolean(),
  }),
  teams: z.array(z.object({ id: idSchema, name: z.string(), isLead: z.boolean() })),
  permissions: z.array(permissionSchema),
  /** A support session that matters to this browser, or `null` (ADR-0041). */
  support: supportStateSchema.nullable(),
  /**
   * The types this member may raise — `ticket:create` decided per type, so
   * the form offers exactly what will be accepted.
   */
  creatableTypes: z.array(ticketTypeSchema),
})
export type Me = z.infer<typeof meSchema>
