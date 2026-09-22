# 0020 — Consent-based, read-only, audited support access

- **Status:** Accepted
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** "Every read is audited" is implemented **per request**, not per returned row:
> one `SUPPORT_READ` entry per API call carrying the endpoint, entity type, capped entity ids, result
> count and filters. Per-row auditing would write thousands of rows for a single page view and make the
> customer's log unreadable — defeating the transparency this ADR exists for. The audit write is buffered
> outside the read's transaction, and a failure to record **terminates the session**. Content access runs
> through `runAsTenant(orgId)`, so RLS stays enforcing during support access (ADR-0022). Revocation is
> immediate via the epoch (ADR-0024), not on access-token expiry.

## Context

A platform operator eventually needs to look inside a tenant to help with a problem — and that capability is the single most abusable thing in any multi-tenant product. The first draft said only that platform admins "cannot read ticket content", which is honest but leaves real support impossible and, worse, invites someone to quietly add a bypass later when a customer is stuck.

## Options considered

1. **No access ever.** Strongest privacy; support requires the customer to export and share data, which they will do badly or not at all. Realistically, a backdoor gets added under pressure.
2. **Unrestricted impersonation with an audit log.** What many SaaS products do. Operationally easiest; the customer has no say, cannot see it happening, and "we log it" is a weak answer to "who read my incident about our security breach".
3. **Consent-based, time-boxed, read-only sessions**, audited into the *tenant's own* log and visible in their UI while active.

## Decision

Option 3.

- An `OWNER` grants access from org settings with a stated reason and a duration (max 72 h). A platform admin may request access; only an owner may grant it. There is no path that produces content access without an owner's action.
- A session is **read-only**. Platform admins never write tenant data and never act as a user — there is no identity impersonation, so nothing in the tenant's audit log can ever misattribute an action to a customer's employee.
- Permissions during a session are exactly an `ADMIN`'s **read** permissions minus `token:read`. Token secrets, password hashes and refresh tokens are unreadable by anyone, always.
- **Every read is audited into the tenant's own `AuditLog`** as `SUPPORT_READ` with the entity and the admin's identity. The customer sees precisely what was looked at, in the same place they see everything else.
- Visibility while active: a persistent banner for the tenant's admins and owners, plus email to all owners on grant, on first use, and on expiry.
- Any owner revokes instantly; sessions auto-expire; both are audited. No session may be granted for a `PENDING_DELETION` org.
- Outside a session, platform admins see only metadata: name, slug, plan, status, counts, dates — enough to run the platform, not enough to read anyone's mail.

## Consequences

- Support is slower than "log in as the user", which is the intended trade. Bugs that need write access get reproduced on a test tenant instead.
- The audit requirement means the support read path is instrumented at the repository layer, not sprinkled through controllers — a `SupportSessionInterceptor` records reads while a session context is active.
- This is a strong thing to be able to explain: it demonstrates that access control was designed around the customer's trust rather than the operator's convenience.
- If write-capable support ever becomes necessary, it is a new ADR and needs a different consent flow — most likely per-action approval rather than a session grant.
