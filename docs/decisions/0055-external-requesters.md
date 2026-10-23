# 0055 — External requesters are memberships without an account

- **Status:** Accepted
- **Date:** 2026-10-23
- **Settles:** the deferral in [0039](0039-inbound-mail-feed-and-verdict.md) of [0027](0027-email-dns-and-inbound-sender-authentication.md)'s `allowExternalRequesters`

## Context

ADR-0027 let a workspace opt in to mail from people who are not its members — a contractor, a
visitor, a tenant of the building — creating "a visibly badged external requester and no
membership". ADR-0039 deferred it, because "no membership" collides with the schema: a ticket's
requester is a NOT NULL `requesterMembershipId`, every row names people by membership (ADR-0023), the
requester scope branch and the notification fan-out both start from one, and authorization reasons
about a membership's role.

The options were to make the requester nullable and add a parallel "external contact" column to
every place a person appears, or to make the outside person a membership.

## Decision

**An external requester is a membership of kind `EXTERNAL`.** No `userId`, a `contactEmail` (lower-cased,
unique per workspace among external memberships by a partial index), role `REQUESTER` by a check
constraint. Every rule that holds for a membership holds for them unchanged: composite foreign keys,
the requester scope branch, "own", audit attribution.

- **Off by default** (`Organization.allowExternalRequesters`, an admin's setting). On, a DMARC-aligned
  message from an address that is no member's finds or makes that address's external membership and
  acts as it; off, it is dropped as `UNKNOWN_SENDER`, as before.
- **An `external` actor, built by the intake alone.** It never comes from a credential: there is no
  sign-in. `PermissionService` lets it raise a ticket, read and answer its own, and attach and download
  files on it — the requester grants still decide, "own" still has to hold — and nothing else. It
  never watches, never reads another's ticket, never touches a setting.
- **Told by email only.** The notification fan-out reaches them at the contact address; an inbox is an
  account's, so no `Notification` row is written for them, and no live stream exists for them. Their
  replies to our mail thread onto their own tickets exactly as a member's do (ADR-0027 §5).
- **Badged.** A ticket's requester carries `external: true`; the queue, the ticket and the member list
  say "External".
- **Stopped by pausing them.** An admin pauses or removes an external membership under Members; its
  mail is then dropped. They never hold a role but requester, and never a seat.

## Consequences

- Nothing that names a person had to learn a second way of naming one.
- An address that later becomes a member's account is a different membership: the external one keeps
  its tickets. Merging the two is not built; an agent can relate the tickets.
- The partial unique index means two first messages racing from one address make one membership; the
  loser finds the winner's.
- Turning the setting on opens the workspace to anyone who can pass DMARC for their own domain, so the
  per-sender hourly limit (ADR-0027 §6) and the inbound log are what an admin watches.
