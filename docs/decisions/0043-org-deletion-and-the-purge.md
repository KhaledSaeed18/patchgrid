# 0043 — Deleting a workspace: a 30-day window, then a purge that keeps only a tombstone

- **Status:** Accepted
- **Date:** 2026-10-15
- **Refines:** [0017](0017-org-signup-and-provisioning.md) (lifecycle), `TENANCY.md` §3, [0028](0028-data-protection-export-erasure-retention.md) (tenant erasure)

> **Erratum (2026-10-15).** "A restore that wins the race wins" is not enough on its own. A restore that
> landed after the purge had begun emptying tables would bring back an empty workspace. Time decides
> instead:
>
> - an owner's cancel and an operator's restore are refused (`409`) from the purge date on;
> - the purge starts no earlier than an hour after that date (`PURGE_GRACE_HOURS`), so two clocks cannot
>   disagree about which side owns the workspace.
>
> The purge also clears `staging/org/<orgId>/` beside `org/<orgId>/`: uploads land in staging first
> (ADR-0038).

## Context

`TENANCY.md` §3 says:

- an owner requests deletion;
- the subdomain then 404s for 30 days, and a platform admin can restore it;
- after that a job purges the rows and the `org/<orgId>/` objects under `runAsTenant`;
- "an anonymised platform record of the deletion is kept";
- `TENANCY.md` §2 adds that a released slug is never reusable.

Building it leaves five gaps:

- **What the record is.** Deleting the `Organization` row frees its slug for the next signup, which §2
  forbids. Keeping the row means the status needs a terminal value, and none of `ACTIVE`,
  `SUSPENDED` or `PENDING_DELETION` is one.
- **Who can cancel, and where.** RBAC grants an owner `org:cancel_deletion`. But a pending workspace's
  subdomain 404s, so no tenant route can reach it.
- **What a pending workspace still does.** Sessions, API tokens, support sessions and sweeps.
- **How the purge stays safe** if a restore races it, or if it dies halfway.
- **What happens to the rows the retention table calls permanent.** `SupportSession` is "an
  accountability record".

## Decision

- **The organization row becomes a tombstone.**
  - A new status, `DELETED`, is terminal.
  - The purge keeps the row with its id, slug, plan, creation date, `deletionRequestedAt` and a new
    `deletedAt`. Its name becomes "Deleted workspace" and its email domain is cleared.
  - The slug stays taken forever, as §2 requires. Its `OrganizationSlugHistory` rows stay too.
  - Resolution treats `DELETED` exactly like `PENDING_DELETION`: `404`.
  - A `PlatformAuditLog` row `PLATFORM_ORG_PURGED` records when the purge ran and what it removed (row and
    object counts). It names no person.
- **Requesting.**
  - Only an owner can request (`org:delete`), from Settings, by typing the workspace's slug.
  - In one transaction: the status becomes `PENDING_DELETION`, `deletionRequestedAt` is set, the
    picker's projection is mirrored, and `ORG_DELETION_REQUESTED` is audited.
  - After commit, every member's sessions end (epoch bump), the lookup cache drops the org, and every
    owner and admin gets an email saying when the purge happens and how to cancel.
- **Cancelling.**
  - An owner cancels from the workspace picker on `app.`. The workspace stays listed there for its
    owners, marked with its purge date.
  - The route `POST /orgs/:id/cancel-deletion` is `@TenantOptional`. It confirms through
    `runAsTenant` that the caller is an active owner of that org, then returns it to `ACTIVE` and
    audits `ORG_DELETION_CANCELLED`.
  - A platform admin can do the same from the back-office, audited in the tenant's log as `PLATFORM`.
  - Either way the workspace returns exactly as it was. Sessions ended at the request stay ended;
    members sign in again.
- **While pending, nothing runs.**
  - Resolution 404s, so every credential is useless: sessions, API tokens and support sessions alike.
  - The dispatcher already skips the tenant's sweeps (ADR-0018).
  - Inbound mail is dropped (ADR-0027).
  - Nothing is revoked one by one: a cancel brings back API tokens unchanged.
- **The purge.**
  - A daily `org-purge` dispatcher lists the orgs pending for 30 days. Each gets one job, which runs
    under `runAsTenant`, so RLS is enforcing throughout.
  - The job first locks the organization row. If the org is no longer `PENDING_DELETION`, or is not
    yet due, it stops. A restore that wins the race wins.
  - It then deletes the objects under `org/<orgId>/`, then the tenant's rows table by table, children
    first, one transaction per table. A job that dies halfway is retried and finishes the rest.
  - The last transaction removes the org's platform projections (`UserOrgIndex`, `ApiTokenIndex`,
    refresh tokens), makes the tombstone, and writes `PLATFORM_ORG_PURGED`. Until it commits, the org is still
    `PENDING_DELETION`, so a retry finds it again.
  - Accounts (`User`) are not touched. A person who belonged only to this workspace keeps an account
    with an empty picker. Erasing an account is ADR-0028's flow, not this one.
- **Support sessions are purged with the rest.** They are tenant data, and the tenant is what is being
  erased. The operator's side of each session stays in `PlatformAuditLog` (requested, entered), so the
  platform's own accountability survives without keeping the customer's. The retention table's
  "permanent" holds while the workspace exists.
- **Audit partitions already archived** (`audit_archive`, ADR-0034) are past retention and unreachable by
  the app role. They follow the archive's own lifecycle and are not part of the purge.

## Consequences

- A workspace can only be lost by an owner's deliberate act followed by 30 days of silence. Any owner
  or a platform admin can undo it in that time.
- The tombstone is the "anonymised platform record". It holds no name, domain or person, only that a
  workspace with this id and slug existed and when it ended.
- `organizationStatusSchema` gains `DELETED`. Every exhaustive switch over it has to answer for it, and
  the type checker makes sure each one does.
