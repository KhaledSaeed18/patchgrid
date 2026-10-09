import type {
  MembershipStatus,
  Priority,
  Role,
  TicketType,
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
