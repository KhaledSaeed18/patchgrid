import { Injectable, Logger } from "@nestjs/common"
import {
  type AgentVisibility,
  grantFor,
  isPermission,
  type Permission,
  type PermissionCondition,
  PERMISSIONS,
  SCOPE_GRANTS,
  USER_FACING_TICKET_TYPES,
} from "@patchgrid/contracts"

import type { Actor, TenantActor } from "../auth/actor"
import { NotFoundProblem, NotPermittedProblem } from "../common/problems/problem.exception"
import type { ScopeBranch, ScopedResource, ScopeFilter } from "./scope-filter"
import type { Subject } from "./subject"

/** The org settings a scope depends on — read by the caller from the resolved organization. */
export type ScopePolicy = { agentVisibility: AgentVisibility }

const CONDITIONS: Readonly<Record<PermissionCondition, (s: Subject) => boolean>> = {
  own: (s) => s.own === true,
  watch: (s) => s.watch === true,
  scope: (s) => s.scope === true,
  lead: (s) => s.lead === true,
  self: (s) => s.self === true,
  own_while_new: (s) => s.own === true && s.ticketStatus === "NEW",
  user_facing_type: (s) =>
    s.ticketType !== undefined && (USER_FACING_TICKET_TYPES as readonly string[]).includes(s.ticketType),
  lead_not_own: (s) => s.lead === true && s.own === false,
  not_own: (s) => s.own === false,
  below_admin_not_self: (s) =>
    s.self === false && (s.targetRole === "AGENT" || s.targetRole === "REQUESTER"),
  not_owner_not_self: (s) => s.self === false && s.targetRole !== undefined && s.targetRole !== "OWNER",
  self_within_window: (s) => s.self === true && s.withinEditWindow === true,
  own_within_window: (s) => s.own === true && s.withinEditWindow === true,
}

/**
 * The policy function (ADR-0019, RBAC.md §11). **Pure**: actor, permission and
 * a loaded `Subject` in, a boolean out — no I/O, no clock, no `orgId`, because
 * tenancy was settled before any of this runs. The decision is the matrix in
 * `@patchgrid/contracts`, evaluated; nothing here restates it.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name)

  /** Deny by default: an unknown permission, an actor outside a tenant, a missing fact — all false. */
  can(actor: Actor | undefined, permission: Permission, subject?: Subject): boolean {
    if (!isPermission(permission)) {
      this.logger.error({ msg: "unknown permission denied", permission })
      return false
    }
    if (actor === undefined || !isTenantActor(actor)) return false
    if (actor.kind === "service" && !scopesAllow(actor, permission)) return false

    const grant = grantFor(actor.role, permission)
    if (typeof grant === "boolean") return grant
    if (subject === undefined) return false
    return grant.some((condition) => CONDITIONS[condition](subject))
  }

  /** For actions on something the actor can already see: `403`. */
  assert(actor: Actor | undefined, permission: Permission, subject?: Subject): void {
    if (!this.can(actor, permission, subject)) throw new NotPermittedProblem()
  }

  /** For reads: an invisible record is indistinguishable from an absent one — `404` (RBAC.md §11). */
  assertVisible(actor: Actor | undefined, permission: Permission, subject?: Subject): void {
    if (!this.can(actor, permission, subject)) throw new NotFoundProblem()
  }

  /**
   * Role-level: everything this actor could EVER do, conditions aside. Drives
   * navigation (`GET /me`) and the route guard's first filter — never a
   * decision about a particular record.
   */
  permissionsFor(actor: Actor | undefined): Permission[] {
    if (actor === undefined || !isTenantActor(actor)) return []
    return PERMISSIONS.filter(
      (permission) =>
        grantFor(actor.role, permission) !== false &&
        (actor.kind !== "service" || scopesAllow(actor, permission)),
    )
  }

  /** Which rows of a resource this actor may list (RBAC.md §4). */
  scopeFor(actor: Actor | undefined, resource: ScopedResource, policy: ScopePolicy): ScopeFilter {
    if (actor === undefined || !isTenantActor(actor)) return { kind: "none" }
    const me = actor.membershipId

    switch (resource) {
      case "ticket": {
        if (!this.can(actor, "ticket:read", { scope: true, own: true, watch: true })) return { kind: "none" }
        if (actor.role === "OWNER" || actor.role === "ADMIN") return { kind: "all" }
        if (actor.role === "REQUESTER") {
          return any([
            { kind: "requester", membershipId: me },
            { kind: "watcher", membershipId: me },
          ])
        }
        if (policy.agentVisibility === "ALL_TICKETS") return { kind: "all" }
        const teamIds = actor.kind === "member" ? actor.teamIds : []
        return any([
          ...(teamIds.length > 0 ? [{ kind: "teams", teamIds } as const] : []),
          { kind: "no-team" },
          { kind: "assignee", membershipId: me },
          { kind: "watcher", membershipId: me },
        ])
      }
      case "asset": {
        if (this.can(actor, "asset:read_all")) return { kind: "all" }
        if (this.can(actor, "asset:read", { own: true })) {
          return any([{ kind: "owner", membershipId: me }])
        }
        return { kind: "none" }
      }
    }
  }
}

function isTenantActor(actor: Actor): actor is TenantActor {
  return actor.kind === "member" || actor.kind === "service"
}

/** Effective = role ∩ scopes (ADR-0021). Scopes only ever narrow. */
function scopesAllow(actor: Extract<TenantActor, { kind: "service" }>, permission: Permission): boolean {
  return actor.scopes.some((scope) => (SCOPE_GRANTS[scope] as readonly Permission[]).includes(permission))
}

function any(branches: ScopeBranch[]): ScopeFilter {
  const [first, ...rest] = branches
  return first === undefined ? { kind: "none" } : { kind: "any", branches: [first, ...rest] }
}
