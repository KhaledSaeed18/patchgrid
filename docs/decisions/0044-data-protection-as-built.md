# 0044 — Data protection as built: a streamed export, self-service erasure, retention sweeps

- **Status:** Accepted
- **Date:** 2026-10-15
- **Refines:** [0028](0028-data-protection-export-erasure-retention.md)

## Context

ADR-0028 decides the policy:

- an owner-only async export, mailed as a 24-hour link and limited to one a day;
- erasure by pseudonymisation, refused to a last owner;
- a retention table.

Building it raises seven questions:

- How does an export of a tenant with gigabytes of attachments avoid being built in memory?
- What does an owner see while it runs, and where is the one-a-day limit kept?
- Which entities go in, and what stays out?
- Where does a person ask to be erased, and what happens to their memberships beyond the display name?
- Who is the "actor" of an erasure in each workspace's audit log?
- `FEATURES.md` says `GET /org/export`, but ADR-0028 says `POST`. Which is right?
- The token tables in the retention table are platform-class, so they have no tenant to sweep per.

## Decision

### Export

- **The route.** `POST /org/exports` (`org:export`) answers `202` with the export's row. ADR-0028's verb
  is right, because an export is a thing created. `FEATURES.md` is corrected to match.
- **A tenant-owned `OrgExport` row** records each export: who asked, when, its status (`QUEUED →
  RUNNING → READY | FAILED`, later `EXPIRED`), its object key and size, and when its link lapses.
  - The one-a-day limit is a check on that table under the organization row lock. Inside 24 hours it is
    `429` with `Retry-After`, a rate limit rather than a plan limit, so not `402`.
  - `GET /org/exports` lists them in Settings.
- **The job.** One per export runs on a tenant queue under `runAsTenant`. It streams a zip (`fflate`)
  into a multipart upload (`@aws-sdk/lib-storage`) at `org/<orgId>/exports/<exportId>.zip`. Nothing
  bigger than one attachment is ever in memory. Entities are read in keyset pages, one transaction per
  page.
- **The contents.**
  - `manifest.json`: the format version, the workspace's name and slug, when it was taken, and a count
    per file.
  - One `.ndjson` file per entity: members (with their email; the member list is the organization's),
    teams and team memberships, invitations, categories, SLA policies, tickets, comments (internal notes
    included), links, watchers, problem and change details, approvals, assets and their ticket links,
    knowledge articles, attachments, inbound email metadata, the audit log, API tokens and support
    sessions.
  - The bytes of each attachment, under `attachments/<id>/<filename>`. The attachments file gives each
    one's path and the SHA-256 computed while it was streamed.
  - **Left out:** every secret (token and invitation hashes), notifications (per-person delivery state,
    not the organization's record), usage counters, and inbound mail's raw bodies (already on their own
    30-day clock).
- **Delivery.**
  - When the zip is ready, the person who asked gets an email with a presigned link that lasts 24 hours.
  - Settings shows the same download while the export lasts, through `GET /org/exports/:id/download`,
    which mints a fresh short-lived link.
  - After 24 hours the retention sweep deletes the object and marks the row `EXPIRED`.
- **Audit.** `ORG_EXPORTED` is written when the export is asked for, in the same transaction as the row.

### Erasure

- **The route.**
  - `POST /auth/account/erase` sits on the picker's tenant-less surface (`@TenantOptional`, `pg_id`).
    It takes the account's password again, as any irreversible act should.
  - It is refused (`409`, naming the workspaces) while the account is the only active owner of a
    workspace that is not being deleted.
  - It is also refused while the account holds a platform grant. A grant is revoked by CLI first.
- **In each workspace**, through `runAsTenant`, one transaction per workspace:
  - the membership becomes `REMOVED` with `anonymisedAt` set, named "Former member", with no avatar;
  - it leaves every team, and its seat is released;
  - its watcher rows and notifications go;
  - `MEMBER_REMOVED` is audited with `{ erased: true }`, with the member themselves as the actor. The row
    reads "Former member removed Former member", which is exactly what happened.
  - Tickets they raised or are assigned keep pointing at the membership. An admin reassigns open work as
    they would for anyone who left.
- **On the account**, after the workspaces:
  - the email becomes `deleted+<sha256(email)[:16]>@invalid`, the name is cleared, the password hash is
    cleared, and `anonymisedAt` is set;
  - its second factors, picker rows, refresh tokens, reset and verification tokens are deleted;
  - every membership's epoch is bumped.
  - One email to the original address confirms the erasure. It is sent after commit, from memory, since
    the row no longer has the address.

### Retention

- **Per tenant, daily (`retention-sweep`):** notifications older than 90 days are deleted, and exports
  past their link are removed and marked `EXPIRED`.
- **Platform, daily (`credential-retention`):** refresh, password-reset and verification tokens 30 days
  past expiry are deleted. They are platform-class rows with no tenant to sweep per, so this is the one
  retention job that runs without one, like `audit-partition` (ADR-0034).
- The rest of the table was already enforced: audit partitions (ADR-0034), inbound raw mail (ADR-0039),
  pending uploads (ADR-0038) and soft-deleted organizations (ADR-0043).

## Consequences

- An export costs a stream, not a heap. Its size is bounded by the tenant's storage plan, not by the
  worker's memory.
- Erasure touches two tables per workspace plus the account, which is ADR-0023's promise kept. Nothing
  in a ticket or the audit log is rewritten.
- A person cannot erase themselves out of a workspace's ownership. They hand it over or delete it first.
