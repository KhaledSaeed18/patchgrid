# 0042 — API tokens as built: one token, one service account

- **Status:** Accepted
- **Date:** 2026-10-15
- **Refines:** [0021](0021-api-tokens-as-service-accounts.md) and `RBAC.md` §10

## Context

ADR-0021 decides what a token is: a scoped actor bound to a `SERVICE_ACCOUNT` membership, Argon2id-hashed,
shown once, effective permission role ∩ scopes. Building it leaves six questions open:

- Does each token get its own membership, or do tokens share one?
- What happens to that membership when an admin edits it from the member list?
- Argon2id costs tens of milliseconds by design. Does every API request pay it?
- How does revocation reach the next request?
- The create response holds the only copy of the secret, and `Idempotency-Key` stores responses in
  Redis. Can the two coexist?
- When is the expiry warning sent, and to whom?

## Decision

- **One token, one service account.**
  - Creating a token creates its membership in the same transaction: kind `SERVICE_ACCOUNT`, no user,
    named after the token, role `AGENT` or `REQUESTER`, chosen once. It also writes the token's
    `ApiTokenIndex` row in that transaction.
  - Attribution names the token, not "the integrations account".
- **The token owns its membership's lifecycle.**
  - The member list shows a service account, marked as one. It refuses to change its role, disable,
    enable or remove it, with `409`.
  - Revoking the token disables the membership in the same transaction. Its past tickets and audit
    rows keep a name.
  - A service account is never an assignee, never in a team, and never a watcher: there is no one to
    tell.
  - A token that starts work on an unassigned ticket does not become its assignee.
- **Format and verification.**
  - The token is `pg_<prefix>_<secret>`. The prefix is 12 random `[a-z0-9]`, unique, and safe to log.
    The secret is 32 random bytes in base64url. The row stores the secret's Argon2id hash.
  - Each process remembers a verified token's SHA-256 for five minutes, keyed by prefix. A request
    whose secret has that digest skips Argon2id.
  - The token row is still read on every request: revoked, expired, and the membership's status. That
    read is the revocation check, as the membership read is for a member. It is in force on the next
    request with no epoch, and the cached digest grants nothing on its own.
- **Limits before verification.**
  - A per-token throttler runs at step 6 beside the per-org one, keyed by prefix: 300 requests a minute.
  - A prefix is public, so this is also what stops it from buying unlimited Argon2id work.
- **`lastUsedAt`** is written at most once a minute per token, by a conditional update. A monitoring
  system polling every second must not turn every read into a write.
- **No idempotent replay for creation.**
  - `POST /org/api-tokens` does not honour `Idempotency-Key`, because the stored answer would be the
    secret, at rest in Redis.
  - A retried create makes a second token. It is visible in the list and can be revoked. This is the one
    exception to "entity-creating POSTs honour `Idempotency-Key`", and the route says why.
- **Scopes are fixed at creation.**
  - A token needs at least one scope. To change scopes, revoke the token and create a new one.
  - `webhooks:write` stays reserved and is not offered.
- **Expiry.**
  - A token may expire after 30, 90 or 365 days, or never.
  - Seven days before it lapses, a per-tenant sweep emails whoever created it, if they are still an
    active admin or owner. Otherwise it emails the owners. It sends once (`expiryWarnedAt`).
- **Audit.** `TOKEN_CREATED` and `TOKEN_REVOKED` record the name, prefix, role, scopes and
  expiry, never the secret.

## Consequences

- Every machine actor is one row in the member list, so "what can act here that isn't a person"
  needs no second screen.
- The verification cache is an optimisation of cost, not of correctness. Dropping it costs latency and
  changes no answer.
- A token used against another workspace's origin is still the resolver's `403` (ADR-0024). Nothing
  here changes tenant resolution.
