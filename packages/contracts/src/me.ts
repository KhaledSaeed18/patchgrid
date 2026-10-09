import { z } from "zod"

import { emailSchema } from "./auth.ts"
import { idSchema } from "./id.ts"
import { permissionSchema } from "./permissions.ts"
import { slugSchema } from "./slug.ts"
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
  }),
  teams: z.array(z.object({ id: idSchema, name: z.string(), isLead: z.boolean() })),
  permissions: z.array(permissionSchema),
})
export type Me = z.infer<typeof meSchema>
