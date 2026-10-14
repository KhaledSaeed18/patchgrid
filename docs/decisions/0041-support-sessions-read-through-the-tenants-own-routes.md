# 0041 — A support session reads through the tenant's own routes, as a read-only support actor

- **Status:** Accepted
- **Date:** 2026-10-15
- **Refines:** [0020](0020-consent-based-support-access.md), and `RBAC.md` §11's sketch of a platform
  actor carrying a session id

## Context

ADR-0020 decides what a support session is: owner-granted, at most 72 hours, read-only, an `ADMIN`'s read
permissions minus `token:read`, one `SUPPORT_READ` audit row per request in the tenant's own log, a
banner, owner email on grant, first use and expiry, and instant revocation. It does not decide how an
operator actually reads.

There are two ways:

1. **A back-office viewer.** Platform routes re-expose tickets, comments and articles for a session.
   Every read path is written twice, and each one has to re-apply visibility, internal-note rules and
   attachment rules. The second copy is where the first leak would be.
2. **The tenant's own routes.** The operator opens the workspace itself, with a credential that is
   neither a member's nor the platform's. Every read goes through the same services, permission checks,
   scope filters and RLS a member's does.

## Decision

Option 2.

- **Requesting and granting.**
  - An operator requests access to a workspace from the back-office, with a reason. That creates a
    `SupportSession` in `REQUESTED`, visible to the workspace's owners and admins.
  - An owner grants it for a duration up to 72 hours, on a consent screen that says in words what it
    permits, including internal notes and the audit log.
  - An owner may also decline it, or revoke it at any time.
  - No session is ever granted for a `PENDING_DELETION` workspace.
- **Entering.**
  - With an active session, the operator's platform session (ADR-0040) mints a **support token** by
    `POST /platform/support/sessions/:id/enter`. It is a JWT with its own audience, naming the
    workspace, the session and the operator.
  - The token lives in a cookie `pg_st_<slug>`. It expires at the session's end or the platform
    session's end, whichever comes first.
  - Tenant resolution reads it exactly as it reads `pg_at_<slug>`, and prefers it when both are present.
    An operator who is also a member of that workspace is, in that browser, support and nothing else.
- **The support actor.**
  - The auth guard verifies the token, then the session row on every request: granted, not revoked,
    not expired, this operator, this workspace. It also checks the epoch key `support:<sessionId>`.
    A revocation is in force on the next request.
  - The actor is `{ kind: "support", sessionId, platformAdminId, orgId }`. It has role `ADMIN` for the
    matrix, narrowed to `SUPPORT_READ_PERMISSIONS`: the read permissions ADR-0020 lists, held in
    contracts and pinned by a test. Its `membershipId` is the session id, which never equals a
    membership, so no "own", "assignee" or "watcher" relation can ever hold for it.
- **Read-only at the door.** The guard refuses every non-`GET` request from a support actor with `403`,
  before any handler runs. Reads with a side effect skip it for a support actor: an article's view count
  is not counted, and a notification is not marked read.
- **One `SUPPORT_READ` per request.**
  - An interceptor writes it after the response is computed, outside the read's transaction, into the
    tenant's log as actor kind `PLATFORM`. It records the route, the result's ids (at most 50), the
    result count and the query filters.
  - If that write fails, the session is ended there and then (`endedAt`, reason `AUDIT_FAILED`) and the
    epoch is bumped. If we cannot record what was looked at, looking stops.
- **Visible both ways.**
  - `GET /me` tells the workspace's admins and owners that a session is active (who, until when), and
    the shell shows a banner.
  - For the operator, `/me` says they are support. Their shell shows a read-only banner, and offers
    nothing that writes.
- **Mail.** The owners get one email when the session is granted, one on its first use, and one when it
  ends: expired, revoked, or ended by an audit failure.
- **Expiry is swept.** Every five minutes a per-tenant sweep marks expired sessions ended, audits
  `SUPPORT_ACCESS_EXPIRED`, and emails the owners.

## Consequences

- Support sees the product exactly as an admin does, which is the point of support. There is no second
  rendering of tenant data to keep in step.
- The support actor is one more `TenantActor` kind. Everything that already handles `service` actors
  handles it the same way; anything that needs a person (notifications, the stream) refuses it.
- A request the session has no permission for is the ordinary `403`, or `404` for reads. The audit row
  is written either way, so a probe is visible too.
