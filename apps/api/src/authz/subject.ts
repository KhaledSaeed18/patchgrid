import type { Role, TicketStatus, TicketType } from "@patchgrid/contracts"

/**
 * What a decision needs to know about the thing being acted on (RBAC.md §11).
 *
 * The service loads it — from the record it already fetched, the actor's team
 * facts and the clock — and `PermissionService.can()` reads it without any I/O.
 * Every field is optional and **absence never grants**: a condition that needs
 * a fact the service did not supply is false. `not_own` needs `own: false`, not
 * a missing `own`.
 */
export type Subject = {
  /** The actor is the subject's requester, author, uploader or owner. */
  own?: boolean
  /** The actor watches the subject ticket. */
  watch?: boolean
  /** The subject passes the actor's visibility scope — usually: the scoped query found it. */
  scope?: boolean
  /** The actor leads the subject's team. */
  lead?: boolean
  /** The subject is the actor's own membership. */
  self?: boolean
  ticketType?: TicketType
  ticketStatus?: TicketStatus
  /** The role the target member holds now, for member actions. */
  targetRole?: Role
  /** Inside the 15-minute edit window, measured by the service with the injected clock. */
  withinEditWindow?: boolean
}
