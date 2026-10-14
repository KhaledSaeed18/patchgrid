import type { OrganizationStatus, Plan } from "@patchgrid/contracts"

export const ORG_STATUS_LABEL: Record<OrganizationStatus, string> = {
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  PENDING_DELETION: "Deletion pending",
}

export const PLAN_LABEL: Record<Plan, string> = { FREE: "Free", PRO: "Pro" }
