import type { MembershipStatus, Role } from "@patchgrid/contracts"

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
