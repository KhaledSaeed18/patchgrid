import type {
  Impact,
  MembershipStatus,
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
  workaround: "Record workaround",
  submit: "Submit for approval",
  approve: "Approve",
  reject: "Reject",
  complete: "Mark implemented",
  rollback: "Roll back",
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
