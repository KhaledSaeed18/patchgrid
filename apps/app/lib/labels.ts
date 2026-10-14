import type {
  ArticleVisibility,
  AssetStatus,
  AssetType,
  ChangeRisk,
  Impact,
  LinkKind,
  MembershipStatus,
  NotificationType,
  Priority,
  Role,
  TicketAction,
  TicketStatus,
  TicketType,
  Urgency,
} from "@patchgrid/contracts"

/** How roles and statuses read on screen. One place, so every page says the same thing. */
export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  AGENT: "Agent",
  REQUESTER: "Requester",
}

export const STATUS_LABEL: Record<MembershipStatus, string> = {
  ACTIVE: "Active",
  INVITED: "Invited",
  DISABLED: "Disabled",
  REMOVED: "Removed",
}

export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  INCIDENT: "Incident",
  SERVICE_REQUEST: "Service request",
  PROBLEM: "Problem",
  CHANGE: "Change",
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
}

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  NEW: "New",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  PENDING: "Waiting for a reply",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
  KNOWN_ERROR: "Known error",
  DRAFT: "Draft",
  AWAITING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  IMPLEMENTED: "Implemented",
  ROLLED_BACK: "Rolled back",
}

/**
 * The button for each transition. Which ones a ticket offers is the server's
 * `availableActions`; this only names them.
 */
export const TICKET_ACTION_LABEL: Record<TicketAction, string> = {
  assign: "Assign",
  start: "Start work",
  wait: "Wait on requester",
  resume: "Resume",
  resolve: "Resolve",
  close: "Close",
  reopen: "Reopen",
  cancel: "Cancel ticket",
  workaround: "Mark as known error",
  submit: "Submit for approval",
  approve: "Approve",
  reject: "Reject",
  complete: "Mark implemented",
  rollback: "Roll back",
}

export const RISK_LABEL: Record<ChangeRisk, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
}

/** A link as read from the ticket it is shown on (DOMAIN.md §1). */
export const LINK_KIND_LABEL: Record<LinkKind, string> = {
  CAUSED_BY: "Caused by",
  CAUSES: "Causes",
  RESOLVED_BY: "Resolved by",
  RESOLVES: "Resolves",
  DUPLICATE_OF: "Duplicate of",
  HAS_DUPLICATE: "Has duplicate",
  RELATES_TO: "Relates to",
}

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  LAPTOP: "Laptop",
  DESKTOP: "Desktop",
  MONITOR: "Monitor",
  PHONE: "Phone",
  TABLET: "Tablet",
  PRINTER: "Printer",
  NETWORK: "Network device",
  SERVER: "Server",
  SOFTWARE: "Software licence",
  OTHER: "Other",
}

export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  IN_STOCK: "In stock",
  IN_USE: "In use",
  IN_REPAIR: "In repair",
  RETIRED: "Retired",
}

/** Who reads an article, as its editor chooses (DOMAIN.md §9.2). */
export const ARTICLE_VISIBILITY_LABEL: Record<ArticleVisibility, string> = {
  DRAFT: "Draft",
  INTERNAL: "Internal",
  PUBLISHED: "Published",
}

export const ARTICLE_VISIBILITY_HINT: Record<ArticleVisibility, string> = {
  DRAFT: "Only you and admins can read it.",
  INTERNAL: "Agents can read it; requesters can't.",
  PUBLISHED: "Everyone in the workspace can read it.",
}

export const IMPACT_LABEL: Record<Impact, string> = {
  LOW: "Just me",
  MEDIUM: "My team",
  HIGH: "Many people or a whole site",
}

export const URGENCY_LABEL: Record<Urgency, string> = {
  LOW: "It can wait",
  MEDIUM: "It's slowing me down",
  HIGH: "I can't work",
}

/** Each kind of notification, as the email preferences name it. */
export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  TICKET_CREATED: "A ticket I raised is received, or one arrives for my team",
  TICKET_RAISED_FOR_YOU: "Someone raises a ticket for me",
  TICKET_ASSIGNED: "A ticket is assigned to me",
  COMMENT_PUBLIC: "A reply on a ticket I'm part of",
  COMMENT_INTERNAL: "An internal note on a ticket assigned to me",
  STATUS_CHANGED: "A ticket I'm part of waits on me, is resolved or closed",
  TICKET_REOPENED: "A ticket I work on is reopened",
  WATCHER_ADDED: "Someone adds me as a watcher",
  SLA_WARNING: "A ticket nears its SLA target",
  SLA_BREACHED: "A ticket misses its SLA target",
  CHANGE_AWAITING_APPROVAL: "A change awaits my approval",
  CHANGE_APPROVED: "A change I raised or carry out is approved",
  CHANGE_REJECTED: "A change I raised or carry out is rejected",
}
