# 0013 — Patchgrid is a full multi-tenant SaaS

- **Status:** Accepted
- **Date:** 2026-09-22
- **Supersedes:** the "not multi-tenant" non-goal in the original `PROJECT.md`

## Context

The original scope was a single-company, self-hosted ITSM where `Organization` existed mostly for demo-data tidiness. The product shape has changed: there is a public marketing site, a signed-up company gets its own subdomain, and an app surface serves many unrelated organizations from one deployment. That is a SaaS, and tenancy has to be designed in rather than bolted on — it touches authentication, every database query, every background job, seeding, and testing.

## Options considered

1. **Single tenant per deployment** — simplest; contradicts the product (a landing page selling sign-ups makes no sense if each customer needs their own server).
2. **Tenancy-aware schema, but orgs created only by an instance operator** — half a step; the marketing site would have nothing to convert to, and the interesting problems (provisioning, isolation under concurrency, per-tenant limits) never appear.
3. **Full multi-tenant SaaS** — a company signs up on the marketing site, an `Organization` is provisioned with its own subdomain, users belong to organizations through memberships, and every row of tenant data is isolated at the database level.

## Decision

Option 3. Specifically:

- A **tenant** is an `Organization`, identified publicly by an immutable-ish `slug` that becomes its subdomain (`acme.patchgrid.xyz`).
- A **User** is a global identity (one email, one password, one account). Membership in an organization is a separate `Membership` row carrying the role and team. A user may belong to several organizations and switch between them.
- Every tenant-owned table carries `orgId` and is protected by Postgres Row-Level Security (ADR-0015).
- Organizations are self-provisioned from the marketing site (ADR-0017) and get seeded defaults (teams, categories, SLA policies, starter KB) as part of provisioning.
- A small **platform** layer exists above tenants: platform admins, plans, and per-tenant limits. It is deliberately thin in v1 — no payment processing.

## Consequences

- `role` moves off `User` onto `Membership`; a user can be an Admin in one org and a Requester in another. Every permission check resolves against the *current* membership, never a global role.
- The JWT is bound to an `(userId, orgId)` pair. Switching organizations mints a new token; a token for one org presented on another org's subdomain is rejected.
- Uniqueness constraints that were global become per-org: ticket numbers, category names, team names, asset serial numbers. `User.email` stays globally unique.
- Every repository method takes an org context; every background job carries `orgId` in its payload and establishes tenant context before touching data.
- Seeding, testing and the demo story all get more interesting: fixtures create at least two organizations so cross-tenant leaks fail tests rather than reaching production.
- Out of scope for v1 and deferred to their own ADRs: billing/payments, per-tenant custom domains (`support.acme.com`), SSO/SAML per tenant, data residency, per-tenant backups/export.
