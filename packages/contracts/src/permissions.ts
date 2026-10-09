import { z } from "zod"

import type { Role } from "./tenancy.ts"

/**
 * The permission catalog and the role matrix — one table (RBAC.md §6).
 *
 * Every key below is a permission; its value says, per role, whether the role
 * holds it unconditionally (`true`), never (`false`), or only when the subject
 * satisfies at least one of the listed conditions. `PermissionService.can()` in
 * the API evaluates exactly this data, and `permissions.test.ts` holds it
 * against the tables in `docs/RBAC.md`, so the document, the type and the
 * decision cannot drift apart.
 */

/**
 * The relationship and state conditions a grant may depend on (RBAC.md §6
 * legend). Each is answered from a `Subject` the service loads first; the
 * decision itself does no I/O.
 */
export const PERMISSION_CONDITIONS = [
  /** The actor is the subject's requester, author, uploader or owner. */
  "own",
  /** The actor watches the subject ticket. */
  "watch",
  /** The subject passes the actor's visibility scope (RBAC.md §4). */
  "scope",
  /** The actor leads the subject's team. */
  "lead",
  /** The subject is the actor. */
  "self",
  /** `own`, and the ticket is still `NEW`. */
  "own_while_new",
  /** The ticket type is one a requester may raise: Incident or Service Request. */
  "user_facing_type",
  /** The actor leads the change's team and did not raise it. */
  "lead_not_own",
  /** The actor did not raise the subject. */
  "not_own",
  /** The target member is below `ADMIN` and is not the actor. */
  "below_admin_not_self",
  /** The target member is not an `OWNER` and is not the actor. */
  "not_owner_not_self",
  /** `self`, inside the edit window (15 minutes). */
  "self_within_window",
  /** `own`, inside the edit window (15 minutes). */
  "own_within_window",
] as const
export type PermissionCondition = (typeof PERMISSION_CONDITIONS)[number]

/** `true` always · `false` never · a list: when any one condition holds. */
export type Grant = boolean | readonly [PermissionCondition, ...PermissionCondition[]]
export type RoleGrants = Readonly<Record<Role, Grant>>

const all = { REQUESTER: true, AGENT: true, ADMIN: true, OWNER: true } as const
const agents = { REQUESTER: false, AGENT: true, ADMIN: true, OWNER: true } as const
const admins = { REQUESTER: false, AGENT: false, ADMIN: true, OWNER: true } as const
const owners = { REQUESTER: false, AGENT: false, ADMIN: false, OWNER: true } as const
/** Agents within their scope; admins and owners everywhere. */
const scoped = { REQUESTER: false, AGENT: ["scope"], ADMIN: true, OWNER: true } as const
const selfOnly = { REQUESTER: ["self"], AGENT: ["self"], ADMIN: ["self"], OWNER: ["self"] } as const

export const PERMISSION_MATRIX = {
  // Tickets
  "ticket:create": { REQUESTER: ["user_facing_type"], AGENT: true, ADMIN: true, OWNER: true },
  "ticket:create_on_behalf": agents,
  "ticket:read": { REQUESTER: ["own", "watch"], AGENT: ["scope"], ADMIN: true, OWNER: true },
  "ticket:update": { REQUESTER: ["own_while_new"], AGENT: ["scope"], ADMIN: true, OWNER: true },
  /** A requester's transitions are further narrowed by the transition table (DOMAIN.md §2). */
  "ticket:transition": { REQUESTER: ["own"], AGENT: ["scope"], ADMIN: true, OWNER: true },
  "ticket:assign": scoped,
  "ticket:link": scoped,
  "ticket:watch": { REQUESTER: ["own", "watch"], AGENT: ["scope"], ADMIN: true, OWNER: true },
  "ticket:watch_others": scoped,
  /** The owner's last-approver exception is a domain rule (DOMAIN.md §2.3), not a grant. */
  "ticket:approve_change": {
    REQUESTER: false,
    AGENT: ["lead_not_own"],
    ADMIN: ["not_own"],
    OWNER: ["not_own"],
  },
  "ticket:read_audit": scoped,

  // Comments and attachments — always evaluated after `ticket:read` on the same ticket.
  "comment:create_public": { REQUESTER: ["own", "watch"], AGENT: ["scope"], ADMIN: true, OWNER: true },
  "comment:create_internal": scoped,
  "comment:read_internal": scoped,
  "comment:update_own": {
    REQUESTER: ["self_within_window"],
    AGENT: ["self_within_window"],
    ADMIN: ["self_within_window"],
    OWNER: ["self_within_window"],
  },
  "comment:delete": admins,
  "attachment:upload": { REQUESTER: ["own"], AGENT: ["scope"], ADMIN: true, OWNER: true },
  "attachment:download": { REQUESTER: ["own", "watch"], AGENT: ["scope"], ADMIN: true, OWNER: true },
  "attachment:delete": { REQUESTER: ["own_within_window"], AGENT: ["own"], ADMIN: true, OWNER: true },

  // Assets and knowledge
  "asset:read": { REQUESTER: ["own"], AGENT: true, ADMIN: true, OWNER: true },
  "asset:read_all": agents,
  "asset:write": agents,
  "asset:delete": admins,
  "kb:read_published": all,
  "kb:read_internal": agents,
  "kb:read_draft": { REQUESTER: false, AGENT: ["own"], ADMIN: true, OWNER: true },
  "kb:write": agents,
  "kb:publish": agents,
  "kb:delete": { REQUESTER: false, AGENT: ["own"], ADMIN: true, OWNER: true },

  // Members, teams and configuration
  "member:read": all,
  "member:read_contact": agents,
  "member:invite": admins,
  /** Setting a role of `ADMIN` or above additionally needs `member:promote_admin`. */
  "member:update_role": { REQUESTER: false, AGENT: false, ADMIN: ["below_admin_not_self"], OWNER: true },
  "member:promote_admin": owners,
  "member:disable": { REQUESTER: false, AGENT: false, ADMIN: ["not_owner_not_self"], OWNER: true },
  "member:remove": { REQUESTER: false, AGENT: false, ADMIN: ["not_owner_not_self"], OWNER: true },
  "team:read": agents,
  "team:write": admins,
  "team:manage_own_members": { REQUESTER: false, AGENT: ["lead"], ADMIN: true, OWNER: true },
  "category:read": all,
  "category:write": admins,
  "sla:read": agents,
  "sla:write": admins,
  "automation:read": agents,
  "automation:write": admins,

  // Organization, notifications, integrations, support
  "notification:read": selfOnly,
  "notification:update": selfOnly,
  "org:read_settings": agents,
  "org:update_settings": admins,
  "org:read_audit": admins,
  "org:export": owners,
  "org:change_slug": owners,
  "org:manage_plan": owners,
  "org:transfer_ownership": owners,
  "org:delete": owners,
  "org:cancel_deletion": owners,
  "token:read": admins,
  "token:create": admins,
  "token:revoke": admins,
  "support:read_sessions": admins,
  "support:grant_access": owners,
  "support:revoke_access": owners,
} as const satisfies Record<string, RoleGrants>

export type Permission = keyof typeof PERMISSION_MATRIX
export const PERMISSIONS = Object.keys(PERMISSION_MATRIX) as Permission[]
export const permissionSchema = z.enum(PERMISSIONS as [Permission, ...Permission[]])

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSION_MATRIX, value)
}

/** The grant a role holds for a permission. */
export function grantFor(role: Role, permission: Permission): Grant {
  return PERMISSION_MATRIX[permission][role]
}

/**
 * API token scopes (ADR-0021, RBAC.md §10). Coarse, and they only ever narrow
 * what the service account's role already allows: effective = role ∩ scopes.
 */
export const tokenScopeSchema = z.enum([
  "tickets:read",
  "tickets:write",
  "comments:internal",
  "assets:read",
  "assets:write",
  "kb:read",
  "webhooks:write",
])
export type TokenScope = z.infer<typeof tokenScopeSchema>

/** The mapping is data, not prose. `comments:internal` is never implied by `tickets:*`. */
export const SCOPE_GRANTS = {
  "tickets:read": ["ticket:read", "ticket:read_audit", "attachment:download", "category:read"],
  "tickets:write": [
    "ticket:create",
    "ticket:create_on_behalf",
    "ticket:update",
    "ticket:transition",
    "ticket:assign",
    "ticket:link",
    "ticket:watch",
    "comment:create_public",
    "attachment:upload",
  ],
  "comments:internal": ["comment:create_internal", "comment:read_internal"],
  "assets:read": ["asset:read", "asset:read_all"],
  "assets:write": ["asset:write"],
  "kb:read": ["kb:read_published", "kb:read_internal"],
  /** Reserved; grants nothing in v1. */
  "webhooks:write": [],
} as const satisfies Record<TokenScope, readonly Permission[]>

/** No set of scopes reaches these families (RBAC.md §10). */
export const TOKEN_FORBIDDEN_FAMILIES = ["member", "org", "token", "support"] as const
