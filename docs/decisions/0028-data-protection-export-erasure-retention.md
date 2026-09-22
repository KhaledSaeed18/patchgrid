# 0028 — Data protection: tenant export, pseudonymised erasure, retention

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

Patchgrid holds other companies' operational data — including, by design, their security incidents. The
specification had nothing on export, erasure, retention or what happens to a departed employee's
comments, and two of its own rules point in opposite directions: `AuditLog` is "never deleted"
(`DOMAIN.md` §7), while any data-protection regime a customer operates under gives individuals a right to
erasure. Left unresolved, the first customer question about either one is answered by improvisation.

There is also a product angle. "Can I get my data out?" is the question a buyer asks about a small
vendor, and the honest answer is a feature, not a policy page.

## Options considered

**Erasure vs. audit integrity**
1. **Delete the person's rows.** Satisfies the naive reading of erasure; destroys the audit chain, orphans
   ticket history, and makes the log — the product's most-cited feature — untrustworthy.
2. **Refuse erasure, citing audit obligations.** Defensible for genuine legal-hold data, indefensible as
   a blanket answer.
3. **Pseudonymisation.** The identifiers that link content to a natural person are destroyed; the
   content and its causal chain survive under a stable opaque key. This is the standard reconciliation
   and the one regulators describe.

**Export**
1. Synchronous endpoint — times out on any real tenant.
2. **Async job producing a signed, expiring archive**, which is also a useful demonstration of the
   tenant-scoped job pipeline.

## Decision

### Tenant export

`POST /org/export` (`org:export`, **OWNER** only) enqueues a per-tenant job that writes a zip to object
storage under the tenant's own prefix and emails the owner a presigned link valid 24 h. Contents:
newline-delimited JSON per entity, an attachment manifest with storage keys and checksums, and the
attachment bytes. Audited as `ORG_EXPORTED`. Rate-limited to one per 24 h.

The job runs under `runAsTenant` like everything else — the export path is not a privileged path, which
means a bug in it cannot read a neighbour.

### Erasure, by pseudonymisation

A `User` may request account deletion. What happens:

- `User.email` → a tombstone (`deleted+<sha256(email)[:16]>@invalid`), `passwordHash` cleared, `name`
  cleared, `anonymisedAt` set. The row survives because foreign keys point at it.
- Every `Membership` for that user: `anonymisedAt` set, `displayName` → "Former member", `avatarUrl`
  cleared. Because tenant rows reference `membershipId` rather than `userId` (ADR-0023), every ticket,
  comment and audit entry keeps a valid, stable, non-identifying actor.
- `AuditLog` rows are **not** touched. They reference `actorMembershipId`, which no longer resolves to a
  person. The chain of custody survives; the person does not.
- Free-text content (comment bodies, ticket descriptions) is **not** scrubbed. It belongs to the
  organization, not the individual, and scrubbing it would destroy the incident record. Stated plainly
  so nobody is surprised: erasure removes the link between content and a natural person, not the content.
- The last `OWNER` of an organization cannot erase their account until ownership is transferred or the
  org is deleted (`RBAC.md` §3).

A tenant's own data is erased by deleting the organization (`TENANCY.md` §3): 30-day soft window, then a
hard purge of rows and object-storage keys, leaving only an anonymised platform record that a deletion
occurred.

### Retention

| Data | Retained |
| --- | --- |
| `AuditLog` | 2 years (`FREE`), 7 years (`PRO`) — monthly partitions detached past the window |
| `Notification` | 90 days |
| `InboundEmail` raw bodies | 30 days; the parsed ticket is permanent |
| `PENDING` attachments | 1 hour (row **and** object) |
| `RefreshToken`, `PasswordResetToken`, `EmailVerification` | 30 days past expiry |
| `SupportSession` | permanent — it is an accountability record |
| Soft-deleted organizations | 30 days |

Retention is enforced by per-tenant jobs, never a global sweep (ADR-0018).

### What is deliberately out of scope

Data residency, per-tenant encryption keys, a subprocessor register and a signed DPA. All are real
obligations for a commercial product and none of them are engineering decisions this project should
pretend to have made. Listed in `PROJECT.md` non-goals with the reason.

## Consequences

- The `membershipId`-everywhere decision (ADR-0023) pays for itself a second time here: erasure becomes
  an update to two tables rather than a cascade across twenty.
- "Never deleted" in `DOMAIN.md` §7 is now precisely "never deleted within its retention window, and
  never edited". That is both honest and implementable.
- Export is a demonstrable feature for the portfolio and a genuine trust signal.
- Partitioned `AuditLog` (`ARCHITECTURE.md`) is what makes retention a `DETACH PARTITION` rather than a
  multi-hour `DELETE`.
