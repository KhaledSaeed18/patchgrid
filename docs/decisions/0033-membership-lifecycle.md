# 0033 — Membership lifecycle: invite, join, disable, remove

- **Status:** Accepted
- **Date:** 2026-10-09
- **Refines:** [0017](0017-org-signup-and-provisioning.md) (invitations), [0019](0019-rbac-model-and-enforcement.md) (member permissions), [0031](0031-identity-flow-hardening.md) (invite binding)

## Context

`FEATURES.md` M1 lists "invite, accept, disable, remove, change role" and `RBAC.md` §6 gives each a
permission, but no document says what _remove_ does that _disable_ does not, what happens to a removed
person's history, or how an invitation turns into a membership. Two constraints make the naive answers
wrong:

- **Rows reference people by `membershipId`** (ADR-0023). Tickets, comments and audit rows will point
  at a membership for as long as they exist, so a `Membership` row can never be deleted once it has
  done anything — the foreign keys are `Restrict`, deliberately.
- **`Membership` is unique on `(orgId, userId)`.** A person has at most one membership per
  organization, ever, so "invite them back" has to mean "this row again", not a second row.

## Options considered

**Remove**

1. **Delete the row.** What the word suggests. Impossible after the member's first ticket, and
   rewriting history to `NULL` would make the audit log lie about who did what.
2. **Remove = disable.** One state. But an admin who removes someone expects them gone from the member
   list, from the workspace picker and from the seat count, not parked next to the active members.
3. **A terminal `REMOVED` status.** The row stays — history keeps its author — but the person loses
   the workspace entirely: team memberships deleted, picker row deleted, sessions revoked. Only a new
   invitation brings the same row back.

**When the membership row is created**

1. **At invitation**, with status `INVITED`, so a pending invitee can already be assigned or named.
2. **At acceptance.** The `Invitation` row is the pending state; no membership exists until someone
   proves they own the invited address.

## Decision

Option 3 for remove; membership rows are created at acceptance.

| Status     | Meaning                                                     | Sessions | Picker (`UserOrgIndex`)  | Teams    | Seat (`AGENT`+) | Leaves by                    |
| ---------- | ----------------------------------------------------------- | -------- | ------------------------ | -------- | --------------- | ---------------------------- |
| `ACTIVE`   | A working member                                            | yes      | listed, enterable        | kept     | counts          | disable, remove              |
| `DISABLED` | Temporarily out — leave, offboarding in progress, suspicion | revoked  | listed as disabled       | kept     | does not count  | enable, remove               |
| `REMOVED`  | Gone; the row survives only so history keeps its author     | revoked  | deleted                  | deleted  | does not count  | a new invitation, accepted   |

- **`INVITED` is not produced in v1.** The `Invitation` row is the pending state. The enum value stays
  for the day an invitee must be assignable before accepting; nothing reads it today.
- **Enable** (`DISABLED → ACTIVE`) uses `member:disable` — the permission governs the switch in both
  directions, with the same subject rules: an admin may not act on an owner or on themselves.
- **Accepting an invitation for a `REMOVED` membership reactivates that row** with the invitation's
  role and team. Inviting the address of an `ACTIVE` or `DISABLED` member is a `409`: the first is
  already in, the second is a decision to enable, not to invite.
- **Inviting at `ADMIN` or `OWNER`, like changing a role to them, also needs `member:promote_admin`**
  (owners only). An admin cannot mint a peer through the invitation side door.
- **One pending invitation per address per organization.** Re-inviting revokes the outstanding one;
  an admin can also revoke explicitly (`member:invite`).
- **Every status or role change bumps the membership's revocation epoch** and updates or deletes its
  `UserOrgIndex` row in the same transaction as the change (ADR-0022, ADR-0024).
- **The last owner cannot be demoted, disabled or removed.** The check takes
  `SELECT … FROM "Organization" WHERE id = $1 FOR UPDATE` first, so two owners demoting each other at
  once serialise and the second sees one owner left (`RBAC.md` §3).

**Acceptance** (`TENANCY.md` §5, ADR-0031). The token is `<orgId-base36>.<secret>`; the org part opens
the tenant context so the `Invitation` (tenant-owned) can be read under RLS, and every failure — bad
format, unknown org, wrong secret, expired, used, revoked, wrong address — is the same `404`.

- A **signed-in** holder (`pg_id`) accepts with `POST /invitations/accept`; their account email must
  equal the invited address.
- A holder with **no account** accepts with `POST /invitations/accept-new`, giving a name and password;
  the account is created verified, because the link proves the inbox.
- `GET /invitations/preview` tells the page which of the two to show — the workspace name, the role,
  and whether the invited address already has an account. That last fact is disclosed only to someone
  holding a valid token for that address, the boundary ADR-0031 draws.

Each acceptance writes the membership, the picker row, the initial team (if any) and the `MEMBER_JOINED`
audit row in one transaction, and the response opens the workspace's session.

New audit actions beyond `RBAC.md` §12's list: `MEMBER_ENABLED` and `INVITATION_REVOKED`.

## Consequences

- A member list hides `REMOVED` rows by default; an "include removed" filter is an admin view, and
  history still renders the removed person's display name.
- Seat counting is "`ACTIVE` memberships with role `AGENT` or above" — a disabled agent frees a seat.
  `QuotaService` (its own M1 item) adds the seat check to invitation and acceptance.
- A person removed from an org and invited back keeps one row and one history, which is what an admin
  reading the audit log expects.
- Reversal: if pre-acceptance assignment is ever needed, invitations start producing `INVITED` rows;
  the status table above already accounts for it.
