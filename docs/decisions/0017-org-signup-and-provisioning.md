# 0017 — Organization signup, provisioning, and membership

- **Status:** Accepted
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** Provisioning seeds **eight** SLA policies, not four: the uniqueness key is
> `(orgId, ticketType, priority)` and policies apply to both `INCIDENT` and `SERVICE_REQUEST`
> (`DOMAIN.md` §4.1). "Suspended orgs return 402/403" is corrected to **403** — `402` is reserved
> exclusively for plan limits. Invitation tokens carry their org (`<orgId>.<secret>`) so the API can
> establish tenant context before the lookup (ADR-0022), and an unverified user may own at most one
> organization.
- **Supersedes:** [0004](0004-auth-invite-only-jwt-cookies.md) in part — the invite-only decision. The session mechanism from 0004 (JWT access + rotating refresh in httpOnly cookies, Argon2id) stands unchanged.

## Context

ADR-0004 assumed a single internal deployment where an operator seeds the first admin and everyone else is invited. As a multi-tenant SaaS (ADR-0013) the product must let a stranger arrive on the marketing site and end up with a working workspace, while staff inside an organization are still invite-only.

## Options considered

**Signup shape**
1. Org-first (pick a workspace name, then create your account) — good for the "claim your subdomain" moment; awkward if the email is already registered.
2. **User-first, then workspace** — sign up as a person, verify email, then create or join an organization. Handles the "already have an account, creating a second workspace" case naturally, which the multi-org membership model requires anyway.

**Email verification**
1. Verify before the org exists — blocks the exciting part behind an inbox round-trip.
2. **Provision immediately, restrict until verified** — the user reaches their workspace at once; until the email is verified, outbound email is suppressed and members cannot be invited. Verification link expires in 24 h.

**Joining an existing org**
1. Invite only.
2. **Invite + optional verified-domain auto-join** — an org may allow anyone with a verified email at its own domain (`@acme.com`) to join with a default role. Off by default; the domain must be proven by a DNS TXT record.

## Decision

- **Users are global.** `User { id, email (globally unique), passwordHash, name, emailVerifiedAt }`. Membership is `Membership { userId, orgId, role, teamId?, status, invitedById?, joinedAt }` — a user can belong to many organizations, with a different role in each.
- **Roles live on `Membership`**: `OWNER | ADMIN | AGENT | REQUESTER`. `OWNER` is `ADMIN` plus: manage the plan, rename/change the slug, transfer ownership, delete the organization. Every org has at least one owner; the last owner cannot leave or be demoted.
- **Signup flow**: marketing CTA → create account (email + password, or accept an invite) → verify email (non-blocking) → create workspace: name, slug (live availability check against the reserved list and existing slugs), optional domain → redirect to `https://<slug>.patchgrid.xyz`.
- **Provisioning** runs in one transaction: `Organization`, the owner `Membership`, default teams (IT Support, Network, Security), the default category tree, the four default SLA policies, and starter knowledge-base articles. Anything slower (sample tickets for a trial, search indexing) is a background job so signup stays fast. Provisioning is idempotent and keyed by org id, so a retried job cannot double-seed.
- **Slug changes** are allowed to owners, at most once every 30 days, and the old slug is held as a redirect for 30 days (`OrganizationSlugHistory`) so bookmarks and emailed links survive.
- **Invitations** are per-organization, carry a role and optional team, are single-use, hashed at rest, and expire in 7 days. Inviting someone who already has an account adds a membership on acceptance rather than creating a second user.
- **Org switching**: `app.patchgrid.xyz` lists the caller's memberships; choosing one mints a token bound to that `orgId` and redirects to its subdomain. The token is always bound to exactly one org (ADR-0014).
- **Limits per plan** (`FREE`, `PRO`) are enforced by a `QuotaService` — seats and monthly ticket volume in v1. No payment processing; `PRO` is set manually by a platform admin. Billing is a later ADR.
- **Lifecycle**: an organization can be `ACTIVE | SUSPENDED | PENDING_DELETION`. Owners request deletion; it is soft for 30 days (subdomain returns 404, data retained), then hard-deleted by a job. Suspended orgs return 402/403 with a clear message.

## Consequences

- Every permission check resolves the caller's `Membership` for the current org, never a field on `User`. There is no global role except `PlatformAdmin`, which is a separate table.
- Deactivating a member revokes only that org's sessions, not the user's account.
- The seed creates **two** organizations with overlapping-looking data, plus one user who is a member of both — this is what makes isolation bugs visible in development and tests.
- Email verification state gates outbound email to prevent the signup form being used as a spam relay; the portal ticket-submission and signup endpoints are rate-limited per IP and per email.
- Rejected for v1 and available as later ADRs: SSO/SAML per tenant, SCIM provisioning, custom domains, self-serve billing, org-to-org data migration.
