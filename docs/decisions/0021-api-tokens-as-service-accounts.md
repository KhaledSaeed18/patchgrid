# 0021 — API tokens as scoped service accounts

- **Status:** Accepted
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** "The token *is* the tenant binding" left the lookup circular: `ApiToken` is
> tenant-owned, so it cannot be read before a tenant is known. A platform-class `ApiTokenIndex { prefix,
> orgId }` resolves the org first, then `runAsTenant` verifies the secret against the real row (ADR-0022).
> "Effective permission = role ∩ scopes" is now backed by an explicit `SCOPE_GRANTS` mapping (`RBAC.md`
> §10) — without it the intersection was undefined. `comment:read_internal` is never implied by
> `tickets:*` and requires an opt-in `comments:internal` scope.

## Context

`Ticket.source` has included `API` since the first draft, with nothing behind it: no authentication mechanism, no identity for a machine caller, no audit actor. Either that value is removed, or programmatic access is designed properly. Monitoring systems raising incidents automatically is a genuine ITSM use case and the natural integration story for this product.

## Options considered

1. **Remove `API` from `source`** — cleanest, but gives up the most natural integration in an ITSM tool.
2. **Long-lived JWTs for machines** — no new storage; unrevocable before expiry, and opaque in logs.
3. **A separate machine auth path** with its own permission rules — a second authorization system to keep in sync with the first, which is how divergence bugs are born.
4. **Tokens bound to a synthetic `Membership`**, so a machine is just another actor inside the existing model, with scopes that can only narrow what the role already allows.

## Decision

Option 4, scheduled for M8 (integrations are polish, not core).

- `ApiToken { id, orgId, name, tokenHash, prefix, scopes[], membershipId, createdById, lastUsedAt?, expiresAt?, revokedAt? }`.
- Each token is bound to a synthetic `Membership` (role `AGENT`, or `REQUESTER` for intake-only integrations), so **RBAC and RLS apply unchanged**. A token is an actor, never a bypass.
- Effective permissions = role matrix **∩** token scopes. Scopes are coarse (`tickets:read`, `tickets:write`, `assets:read`, `assets:write`, `kb:read`, `webhooks:write`) and may only narrow.
- Regardless of scopes, tokens never grant `member:*`, `org:*`, `token:*` or `support:*` — a leaked token cannot escalate, invite, or mint more tokens.
- Format `pg_<prefix>_<secret>`, presented as `Authorization: Bearer …`, stored as an Argon2id hash, shown exactly once at creation. The `prefix` identifies a token in logs and makes leaked-credential scanning possible without storing secrets.
- Token requests skip cookie and host binding — the token *is* the tenant binding — but a token used against another org's subdomain is `403`.
- Created and revoked by `ADMIN`/`OWNER` only; both actions audited; `lastUsedAt` is surfaced so stale tokens are visible. Optional expiry, with a warning email before it lapses.
- Tickets created by a token get `source: API`, and the audit actor is the service account, so machine-made changes are attributable and distinguishable from human ones.
- Rate limits are per token, separate from the per-user and per-IP limits.

## Consequences

- One authorization model covers humans and machines; there is no second set of rules to drift.
- The synthetic membership appears in the members list, visibly marked as a service account, so an admin can see every non-human actor in one place.
- Webhooks (outbound, this product calling someone else) are a separate concern and a later ADR; `webhooks:write` is reserved in the scope list so it does not need renaming later.
