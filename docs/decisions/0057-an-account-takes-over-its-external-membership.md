# 0057 — An account joining under an external requester's address takes that membership over

- **Status:** Accepted
- **Date:** 2026-10-23
- **Amends:** [0055](0055-external-requesters.md) (its last consequence)

## Context

ADR-0055 made an external requester a membership with no account, and left one case open: if that
address later joins the workspace with an account, by invitation, by its verified domain or through
SSO, the join creates a second membership. The external one keeps its tickets, so the person sees
none of their history and has two names in the agent's queue. ADR-0055 left merging unbuilt; an agent
could relate the tickets by hand.

A merge would repoint every row that names the external membership (tickets, comments, watchers,
links, notifications, audit) at the new one. That is a rewrite across a dozen tables, and the audit log
is append-only, so the old id would linger there anyway.

## Decision

**There is nothing to merge, because the second membership is never made.** When an account joins a
workspace and has no membership there, the join first looks for the workspace's external membership
under the account's address. If there is one, it becomes the member: `kind` turns `HUMAN`, `userId` is
set, `contactEmail` is cleared, and the role, name, inviter and join time come from the join. The id
does not change, so every row that named the external requester now names the member.

- **The address must be proven first,** because the claim hands over tickets. Each of the three join
  paths already proves it. An invitation is bound to its address and its link arrived in that inbox
  (ADR-0031). Domain join requires a verified email (`TENANCY.md` §5). SSO's provider vouches for
  the address within its proved domain.
- **It is conditional.** The update matches only while the row is still `EXTERNAL`, so two joins racing
  for one address cannot both take it. The loser falls through to an ordinary create, which the
  one-membership-per-account key then refuses, so the account still ends with one membership.
- **An external membership an admin paused or removed is still taken over, and becomes active.**
  Pausing an external stops mail from the address. Inviting the person, or a workspace letting its
  domain in, is a later and more deliberate decision, and a fresh membership would have admitted them
  anyway. The claim only adds their own history.
- The `MEMBER_JOINED` audit entry says `claimedExternal: true`, so the takeover is visible in the log.
- A member who was *removed* and is invited back is reactivated as before (ADR-0033). An external
  membership under the same address stays separate in that case. That needs a person who was a member,
  left, and then wrote in from outside, and it is left as it is.

## Consequences

- The person sees their earlier tickets as their own from their first sign-in, and the queue shows one
  requester, no longer badged external.
- ADR-0055's "merging the two is not built" no longer applies.
- After the takeover, mail from the address resolves to the member, as it would for any member.
