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
  TICKET_CREATED: "raised a ticket",
  TICKET_UPDATED: "edited a ticket",
  TICKET_ASSIGNED: "assigned a ticket",
  TICKET_TRANSITIONED: "moved a ticket on",
  COMMENT_ADDED: "commented on a ticket",
  COMMENT_EDITED: "edited a comment",
  COMMENT_DELETED: "removed a comment",
  WATCHER_ADDED: "added a watcher",
  WATCHER_REMOVED: "removed a watcher",
  SLA_WARNING: "flagged a ticket close to its deadline",
  SLA_BREACHED: "flagged a missed deadline",
  TICKET_LINKED: "linked a ticket",
  TICKET_UNLINKED: "removed a link",
  ATTACHMENT_ADDED: "attached a file",
  ATTACHMENT_REMOVED: "removed a file",
  CHANGE_APPROVED: "approved the change",
  CHANGE_REJECTED: "rejected the change",
  CHANGE_SELF_APPROVED: "approved their own change — nobody else could",
  ASSET_CREATED: "added an asset",
  ASSET_UPDATED: "updated an asset",
  ASSET_DELETED: "deleted an asset",
  TICKET_ASSET_LINKED: "named an asset on the ticket",
  TICKET_ASSET_UNLINKED: "took an asset off the ticket",
  ARTICLE_CREATED: "wrote an article",
  ARTICLE_UPDATED: "edited an article",
  ARTICLE_VISIBILITY_CHANGED: "changed who can read an article",
  ARTICLE_DELETED: "deleted an article",
  ORG_SUSPENDED: "suspended the workspace",
  ORG_UNSUSPENDED: "restored the workspace",
  ORG_PLAN_CHANGED: "changed the workspace's plan",
  SUPPORT_ACCESS_REQUESTED: "asked for support access",
  SUPPORT_ACCESS_GRANTED: "granted support access",
  SUPPORT_ACCESS_DECLINED: "declined support access",
  SUPPORT_ACCESS_REVOKED: "revoked support access",
  SUPPORT_ACCESS_EXPIRED: "saw support access expire",
  SUPPORT_READ: "read as support",
  TOKEN_CREATED: "created an API token",
  TOKEN_REVOKED: "revoked an API token",
  WEBHOOK_CREATED: "added a webhook",
  WEBHOOK_UPDATED: "changed a webhook",
  WEBHOOK_DELETED: "removed a webhook",
  WEBHOOK_SECRET_ROTATED: "rotated a webhook's signing secret",
  WEBHOOK_DELIVERIES_REPLAYED: "replayed webhook deliveries",
  WEBHOOK_DISABLED: "turned off a webhook that kept failing",
  ORG_DELETION_REQUESTED: "asked for this workspace to be deleted",
  ORG_DELETION_CANCELLED: "cancelled this workspace's deletion",
  ORG_EXPORTED: "exported this workspace",
  ORG_MFA_REQUIREMENT_CHANGED:
    "changed whether two-factor authentication is required",
  ORG_DOMAIN_CLAIMED: "claimed an email domain for the workspace",
  ORG_DOMAIN_VERIFIED: "proved the workspace's email domain",
  ORG_DOMAIN_REMOVED: "removed the workspace's email domain",
  SSO_CONNECTION_SAVED: "changed the single sign-on connection",
  ORG_SSO_REQUIREMENT_CHANGED: "changed whether single sign-on is required",
  SSO_IDENTITY_LINKED: "linked a member to the identity provider",
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
