import type { Member, MembershipKind, MembershipStatus, Role } from "@patchgrid/contracts"

import type { TenantActor } from "../auth/actor"
import type { PermissionService } from "../authz/permission.service"

/** Everything a role can be set to, in rank order. */
const ROLES: readonly Role[] = ["REQUESTER", "AGENT", "ADMIN", "OWNER"]

/**
 * What `actor` may do to `target` (RBAC.md §6–7), from the same grants the
 * member actions assert, so the list and the actions cannot disagree. A
 * service account is its token's (ADR-0042) and a removed member is gone:
 * nothing is offered on either. Setting `ADMIN` or `OWNER` is the owners'
 * (`member:promote_admin`), and `OWNER` the ownership transfer as well.
 */
export function memberCapabilities(
  permissions: PermissionService,
  actor: TenantActor,
  target: { id: string; role: Role; status: MembershipStatus; kind: MembershipKind },
): Member["capabilities"] {
  const none = { roles: [], canDisable: false, canEnable: false, canRemove: false }
  if (target.kind === "SERVICE_ACCOUNT" || target.status === "REMOVED") return none
  const subject = { self: target.id === actor.membershipId, targetRole: target.role }
  // An external requester is paused or removed to stop their mail; they never hold another role (ADR-0027 §4).
  if (target.kind === "EXTERNAL") {
    const pauses = permissions.can(actor, "member:disable", subject)
    return { roles: [], canDisable: pauses && target.status === "ACTIVE", canEnable: pauses && target.status === "DISABLED", canRemove: permissions.can(actor, "member:remove", subject) }
  }
  const roles = !permissions.can(actor, "member:update_role", subject)
    ? []
    : ROLES.filter(
        (role) =>
          role === "REQUESTER" ||
          role === "AGENT" ||
          (permissions.can(actor, "member:promote_admin") && (role === "ADMIN" || permissions.can(actor, "org:transfer_ownership"))),
      )
  const pauses = permissions.can(actor, "member:disable", subject)
  return {
    roles,
    canDisable: pauses && target.status === "ACTIVE",
    canEnable: pauses && target.status === "DISABLED",
    canRemove: permissions.can(actor, "member:remove", subject),
  }
}
