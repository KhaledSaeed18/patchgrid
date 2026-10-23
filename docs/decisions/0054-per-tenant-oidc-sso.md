# 0054 — Per-tenant SSO: an identity provider vouches for its own workspace only

- **Status:** Accepted
- **Date:** 2026-10-23
- **Builds on:** [0024](0024-per-tenant-cookies-and-api-tenant-resolution.md), [0031](0031-identity-flow-hardening.md),
  [0045](0045-member-mfa-as-built.md), [0050](0050-outbound-webhooks.md) (SSRF), [0053](0053-passkeys.md); M13 in
  [0048](0048-roadmap-after-m10.md)

## Context

M13's second half: a workspace with single sign-on configured sends its members to their identity
provider (IdP), and a new member is provisioned on first sign-in. The protocol is OpenID Connect,
authorization code with PKCE, tested against a local Keycloak. SAML and SCIM stay out (ADR-0048).

Three properties of Patchgrid make this harder than "add a login button":

- **Identity is global.** A person has one account, one `pg_id` and memberships in several workspaces
  (ADR-0031). A workspace's IdP is run by that workspace's admins. If its say-so produced an ordinary
  `pg_id`, Acme's IdP admin could sign in as an Acme employee and open that person's *other*
  workspaces. Globex never agreed to trust Acme's IdP.
- **The configuration is tenant-chosen.** The issuer URL is typed by a tenant admin, and the API fetches
  from it: discovery, keys, the token endpoint. That is the SSRF shape ADR-0050 already met with webhooks.
- **Routing needs a domain the workspace has proved.** `TENANCY.md` §5 described DNS verification of
  `Organization.domain` and nothing built it. An unproved domain would let any workspace claim
  `@bigcorp.com` and receive its people's sign-ins.

## Decision

### The domain is proved by DNS before it routes anything

An owner claims a domain (`PUT /org/domain`). The API stores it with a random challenge and shows one
TXT record: `_patchgrid-verify.<domain>` with the value `patchgrid-verify=<challenge>`. `POST
/org/domain/verification` looks the record up and, when it matches, sets `domainVerifiedAt`. The
existing partial unique index makes "first verified wins" a constraint, so a second workspace gets a
`409`, not a silent second claim. Free-mail providers are on a denylist in the contracts. Changing the
domain clears the proof, and so does removing it. Neither is allowed while SSO is required, so a
workspace cannot strand its own members.

The resolver is `node:dns`, optionally pointed at `DNS_RESOLVERS`. Locally there is no DNS zone to
publish into, so the seed marks Acme's `acme.test` as verified, and the specs inject a resolver.

### One connection per workspace, its secret sealed, its URLs fetched like a webhook's

`SsoConnection` is tenant-owned: the issuer, the client id, the client secret, a default role for
people it provisions (`REQUESTER` or `AGENT`, never more; a CHECK says so) and an `enabled` flag. The
secret is sealed under `SSO_SECRETS_KEY` like a webhook secret (AES-256-GCM, kept apart from the
database) and is write-only: the API reports only that one is set.

Every request the API makes to an IdP (discovery, JWKS, token) goes through the guarded fetch that
webhooks use. Every resolved address is checked inside the connection's own `lookup`, private and
reserved ranges are refused, redirects are not followed, and the timeout is five seconds. https is
required. `SSO_ALLOW_PRIVATE_ISSUERS` admits the local Keycloak over http and is refused at boot in
production. Saving a connection runs discovery, so a typo is a `400` with the reason, not a broken
sign-in later. The discovered issuer must equal the configured one.

Changing the issuer deletes the workspace's identity links: a subject is only unique per issuer, and
a new IdP's `sub` must never inherit an old one's membership.

### Sign-in: the browser goes to the IdP, the API checks everything that comes back

- **Where to go.** The login page's "Sign in with SSO" asks for an email. `POST /auth/sso/discover`
  says whether that address's domain belongs to a workspace with an enabled connection (a fact about a
  domain, never about an account), and the browser navigates to `GET /auth/sso/start`. A slug can stand
  in for the email when the picker already knows the workspace.
- **Start.** The API makes a PKCE verifier, a `state` and a `nonce`, keeps them in Redis for ten minutes
  under the state, sets `pg_sso` to the state (httpOnly, path `/api/v1/auth/sso`, `SameSite=Lax`, so the
  IdP's top-level redirect carries it back), and redirects to the authorization endpoint with
  `scope=openid email profile`, `code_challenge_method=S256` and the email as `login_hint`.
- **Callback.** `GET /auth/sso/callback` requires the cookie to equal `state` (a login-CSRF defence),
  spends the flow with `GETDEL`, exchanges the code with the verifier, and validates the ID token with
  `openid-client`: signature by the IdP's keys, issuer, audience, expiry and nonce. Then it requires
  `email_verified: true` **and an email at the workspace's verified domain**. The second check is what
  makes the workspace's control of its IdP no more than its control of its own domain.
- **Who it is.** Inside the tenant, `SsoIdentity` maps `(connection, sub)` to a membership. With no link
  yet, the account with that email is used, or created verified and without a password. Its membership
  is linked if it is active, or created at the connection's default role (an `AGENT` takes a seat, so a
  full plan is refused). A **disabled or removed membership is never revived by a sign-in**, because
  removal has to stick. The join is audited as `MEMBER_JOINED` with `via: "sso"`, and the picker's
  projection is written in the same transaction, exactly as invitation acceptance does it.
- **Failures** redirect to `app.<root>/login?sso=<code>` with one of a fixed set of codes. An IdP's own
  error text is never shown to the browser and never logged with the state.

### An SSO session is scoped to the workspace whose IdP vouched for it

The `pg_id` minted at the callback, and every pair minted from it, carries `RefreshToken.ssoOrgId`. The
column is copied on rotation, so refreshing never launders it. `SessionService` enforces three rules at
open and refresh, the same two places ADR-0045 checks `requireMfa`:

1. **A scoped session opens only its own workspace.** Any other is `403 sso-session-scoped`. The person
   signs in with their own credentials to reach Globex, which is what Globex agreed to.
2. **`requireSso` admits a non-owner only with a session scoped to this workspace**, otherwise `403
   sso-required`. **Owners are exempt**: they keep their password, factors and passkeys as the way in
   when the IdP is down or misconfigured. That is the break-glass path, and it is why a workspace cannot
   require SSO with no owner able to fix it.
3. **`requireMfa` is satisfied by a scoped session.** The workspace delegated authentication strength to
   its IdP. A password session in the same workspace still needs a factor.

Like `requireMfa`, the requirement gates the next authentication, never a session already open.

An SSO-scoped identity is **refused on every tenant-less route unless the route says otherwise**. The
allow-list: who am I, open a session (for its own workspace), factor status, the passkey list, a
passkey proof, step-up. The rest is account-wide: password, factors, passkeys, erasure, creating a
workspace, accepting an invitation, cancelling another workspace's deletion. Those answer `403
sso-session-scoped`. Most of them already require a proof that an IdP cannot supply. Deny-by-default
means the next account route is safe without anyone remembering this paragraph.

### Step-up through the IdP

A person provisioned by SSO has no password and may have no factor, so ADR-0045's proof has nothing to
check. `GET /auth/sso/start?intent=step-up` sends them back to their IdP with `prompt=login` and
`max_age=0`. The callback additionally requires an `auth_time` no older than the flow, the same person
as the browser's `pg_id`, and then re-issues the workspace's pair with `sua`. That is ADR-0045's claim,
earned by a fresh authentication at the IdP. A full-page round trip cannot resume the action in place,
so the dialog brings the person back to the page and they do it again.

### Changing SSO is a step-up action

Whoever controls the connection can sign in as anyone at the domain, owners included. Saving the
connection and changing the requirement are owner-only (`org:manage_sso`) and take a step-up, like
minting a token. The domain itself is `org:manage_domain`, also owner-only. Proving a domain needs
control of its DNS, which no stolen cookie gives.

### What this is not

- No SCIM and no IdP-initiated sign-in. Deprovisioning at the IdP ends nothing in Patchgrid. An admin
  disables the member, which the next request honours (ADR-0024).
- No RP-initiated logout at the IdP: signing out of Patchgrid signs out of Patchgrid.
- One connection per workspace, and no per-IdP role mapping beyond the default role.
- Operators never sign in through a tenant's IdP.

## Consequences

- Acme's IdP can sign people into Acme and nowhere else. A person's other workspaces see an SSO session
  as a stranger's.
- A workspace that requires SSO still has its owners, with their own credentials, as the way back in.
- `docker compose --profile sso up -d` runs Keycloak on `localhost:8180` with an `acme` realm. The seed
  points Acme's connection at it and marks `acme.test` verified, so `kim@acme.test` is provisioned on
  first sign-in.
- The integration specs carry a small in-process OpenID provider (discovery, keys, token endpoint,
  signed ID tokens), so every check in the callback is exercised against real signatures without
  Keycloak in CI.
- Two tenant-owned tables join the isolation suite, and `RefreshToken`, `Organization` and the
  organization summary each gain a column.
- New permissions `org:manage_domain` and `org:manage_sso`, the latter in `STEP_UP_ACTIONS`. New
  problems `sso-required` and `sso-session-scoped`.
