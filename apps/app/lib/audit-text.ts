import type { AuditAction, AuditEntry, Role } from "@patchgrid/contracts"

import { ROLE_LABEL } from "./labels"

/**
 * One audit entry as a sentence an admin can read ("Dana changed Sam's role
 * from Agent to Admin"), from the entry and the names the page already holds.
 * Unknown shapes degrade to the action's name rather than to nothing.
 */
export type Names = (membershipId: string) => string | undefined

const ACTION_NAMES: Record<AuditAction, string> = {
  MEMBER_INVITED: "invited",
  INVITATION_REVOKED: "withdrew an invitation",
  MEMBER_JOINED: "joined",
  MEMBER_ROLE_CHANGED: "changed a role",
  MEMBER_DISABLED: "paused access",
  MEMBER_ENABLED: "restored access",
  MEMBER_REMOVED: "removed a member",
  TEAM_CREATED: "created a team",
  TEAM_UPDATED: "updated a team",
  TEAM_DELETED: "deleted a team",
  TEAM_MEMBER_ADDED: "added a team member",
  TEAM_MEMBER_REMOVED: "removed a team member",
  TEAM_LEAD_CHANGED: "changed a team lead",
  ORG_SETTINGS_UPDATED: "updated the workspace settings",
  ORG_SLUG_CHANGED: "changed the workspace address",
  AGENT_VISIBILITY_CHANGED: "changed what agents can see",
  SLA_POLICY_CHANGED: "changed an SLA policy",
}

export function actorName(entry: AuditEntry): string {
  if (entry.actor.kind === "SYSTEM") return "Patchgrid"
  if (entry.actor.kind === "PLATFORM") return "Patchgrid support"
  return entry.actor.displayName ?? "A former member"
}

export function describe(entry: AuditEntry, names: Names): string {
  const who = actorName(entry)
  const target = names(entry.entityId) ?? "a member"
  const diff = entry.diff
  const roleChange = asChange(diff.role)
  switch (entry.action) {
    case "MEMBER_INVITED":
      return `${who} invited ${str(diff.email) ?? "someone"}${role(diff.role) === undefined ? "" : ` as ${role(diff.role)?.toLowerCase()}`}`
    case "MEMBER_JOINED":
      return `${who} joined${role(diff.role) === undefined ? "" : ` as ${role(diff.role)?.toLowerCase()}`}`
    case "MEMBER_ROLE_CHANGED":
      return roleChange === null
        ? `${who} changed ${target}'s role`
        : `${who} changed ${target}'s role from ${role(roleChange.from) ?? "?"} to ${role(roleChange.to) ?? "?"}`
    case "MEMBER_DISABLED":
      return `${who} paused ${target}'s access`
    case "MEMBER_ENABLED":
      return `${who} restored ${target}'s access`
    case "MEMBER_REMOVED":
      return `${who} removed ${target} from the workspace`
    case "TEAM_MEMBER_ADDED":
    case "TEAM_MEMBER_REMOVED": {
      const member = str(diff.membershipId)
      const name =
        (member !== undefined ? names(member) : undefined) ?? "a member"
      return `${who} ${entry.action === "TEAM_MEMBER_ADDED" ? "added" : "removed"} ${name} ${entry.action === "TEAM_MEMBER_ADDED" ? "to" : "from"} a team`
    }
    case "ORG_SLUG_CHANGED": {
      const slug = asChange(diff.slug)
      return slug === null
        ? `${who} changed the workspace address`
        : `${who} moved the workspace from ${String(slug.from)} to ${String(slug.to)}`
    }
    default:
      return `${who} ${ACTION_NAMES[entry.action]}`
  }
}

function asChange(value: unknown): { from: unknown; to: unknown } | null {
  return typeof value === "object" &&
    value !== null &&
    "from" in value &&
    "to" in value
    ? value
    : null
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function role(value: unknown): string | undefined {
  return typeof value === "string" && value in ROLE_LABEL
    ? ROLE_LABEL[value as Role]
    : undefined
}

export { ACTION_NAMES }
