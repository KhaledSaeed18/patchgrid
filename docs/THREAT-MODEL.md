# Patchgrid — Threat Model

Written 2026-09-23, at the start of M1, **before** the schema — it is meant to shape the design, not to
certify it afterwards. The M9 security review is conducted against this document. Update it in the same
PR as any change that adds, removes or moves a trust boundary.

Method: assets → actors → trust boundaries → STRIDE per boundary. Each threat names its mitigation and
_where that mitigation is proven_ — a test, a lint rule, a boot assertion — because a mitigation nothing
checks is a hope. Milestone tags say when a mitigation lands; a boundary that does not exist yet is
modelled anyway, so the code written now does not foreclose the fix.

---

## 1. Assets

| #   | Asset                                                                                                             | Why it matters                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A1  | **Tenant content** — tickets, comments (esp. internal notes), attachments, KB, assets, audit log                  | Security incidents and breach notes live in an ITSM tool. One cross-tenant read is the product failing |
| A2  | **Tenant membership and roles** — who is in which org, with what power                                            | Controls A1. Escalation here is escalation everywhere                                                  |
| A3  | **Credentials** — passwords, refresh/access tokens, `pg_id`, API tokens, invite/reset/verify tokens, TOTP secrets | Each is a key to A1/A2. `pg_id` can mint a session for every workspace a user belongs to               |
| A4  | **The isolation mechanism itself** — `patchgrid_app`'s lack of `BYPASSRLS`, policies, composite keys              | A defect here is not one leak, it is every leak                                                        |
| A5  | **Audit integrity** — the tenant's `AuditLog`, `SUPPORT_READ` rows                                                | The customer's evidence of what happened, including what _we_ looked at                                |
| A6  | **Namespace** — slugs, the `patchgrid.xyz` zone, the certificate, mail reputation                                 | A takeover or a reused slug is a phishing and cookie-tossing position                                  |
| A7  | **Availability and quota** — per-tenant capacity, plan limits                                                     | One tenant must not be able to starve, or get free capacity from, another                              |

## 2. Actors

| Actor                               | Starts with                                         | Wants                                                                  |
| ----------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| **Anonymous internet**              | Nothing                                             | Accounts, enumeration, squatted slugs, a spam relay, downtime          |
| **Malicious tenant**                | A legitimately signed-up org of their own           | Another tenant's A1 — the adversary this architecture is built against |
| **Malicious member**                | A real membership, usually `REQUESTER` or `AGENT`   | More than their role grants: internal notes, other teams, promotion    |
| **Credential thief**                | A stolen cookie, leaked API token or forwarded link | To act as someone else for as long as possible                         |
| **Forged email sender**             | A tenant's inbound address                          | Tickets or comments attributed to someone else (M6)                    |
| **Hostile ticket text**             | Attacker-controlled title/body                      | To steer the LLM triage into acting (M7)                               |
| **Hostile identity provider**       | A workspace's SSO connection, or its admin console  | To vouch for someone it does not own, in a workspace that is not its own (M13) |
| **Curious or compromised operator** | A `PlatformAdmin` identity                          | Tenant content without the tenant knowing (M8)                         |
| **Supply chain**                    | A dependency, a CI action, a DNS/ACME token         | Code execution in CI or production; control of the zone                |

## 3. Trust boundaries

```
                         ┌──────────── patchgrid.xyz (one registrable domain = one "site") ─────────────┐
 Browser ──TB1──▶ apps/www · apps/app (Next) ──TB2──▶ apps/api ──TB3──▶ Service (authz) ──TB4──▶ Postgres
    │                                      server-side apiFetch          │                  RLS · composite FKs
    │                                                                    ├──TB5──▶ Redis / BullMQ / SSE
    └────────TB6 (presigned URL)──────────▶ object storage ◀─────────────┤
                                                                         ├◀─TB7── inbound mail provider (M6)
                                                                         ├──TB8──▶ Ollama / phishing-svc (M7)
                                                                         ├──TB11─▶ webhook receivers (M11)
 Browser ◀──── redirects ────▶ tenant identity provider ◀──TB12 (M13)─────┤
 Operator ──TB9 (admin., M8)─────────────────────────────────────────────┘
 Repo ──TB10──▶ CI ──▶ images, DNS, ACME
```

The boundary that matters most is not drawn as an arrow: **tenant ↔ tenant inside one database**
(TB4). Everything else is ordinary web security; that one is the product.

---

## 4. STRIDE per boundary

### TB1 · Internet → frontends, and anonymous identity flows (`/auth/*`, signup, slug lookup)

| STRIDE | Threat                                                     | Mitigation                                                                                              | Proven by / when           |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------- |
| S      | Credential stuffing / password guessing                    | Argon2id; throttle `/auth/*` per IP **before** tenant resolution; failed logins logged by email hash    | throttle test · M1; MFA M9 |
| S      | Stolen refresh token                                       | Rotation; presenting a rotated token revokes the whole chain                                            | auth integration · M1      |
| S      | A phishing page relays a passkey sign-in                   | The origin is signed into every assertion and must be a workspace host or `app.` by the CORS policy; `admin.`, `www.`, the apex and foreign hosts are refused before the signature (ADR-0053) | ceremonies spec · M13      |
| S      | A `pg_id` or a password alone adds a factor of its own     | Adding a passkey or an authenticator app takes the step-up rule's proof: a held factor, the password only when none is held (ADR-0053 erratum) | passkeys integration · M13 |
| S      | A cloned security key                                      | User verification required; the signature counter must rise, checked after the signature so a forgery cannot set off the mail; a regression is refused and mailed | ceremonies spec · M13      |
| T      | A ceremony's challenge replayed or reused for another purpose | Kept in Redis five minutes, spent with `GETDEL`, bound to its purpose and its person; Redis down is a `503`, never unchecked | ceremonies spec · M13      |
| S      | Leaked invitation link joins the wrong person              | Token `<orgId>.<secret>`, hashed, single-use, 7 days, **bound to the invited address** (TM-3, ADR-0031) | M1                         |
| S      | Reused slug inherits old bookmarks, links and cookies      | `OrganizationSlugHistory` rows kept forever; a released slug is never reusable; 302 not 301             | slug tests · M1            |
| I      | Account enumeration via signup, login, reset               | Uniform status, body and timing; the difference goes to the inbox (TM-4, ADR-0031)                      | M1                         |
| D      | Bulk subdomain squatting                                   | Unverified user owns ≤ 1 org; `RESERVED_SLUGS`; signup throttled per IP and per email                   | M1                         |
| E      | Signup form as a spam relay                                | No outbound mail on an unverified user's behalf; they cannot invite                                     | M1                         |
| E      | Domain auto-join with an address the user does not control | Requires a verified email **and** a DNS-TXT-verified domain; one org per domain; free-mail denylist     | M1                         |

### TB2 · Browser / Next server → API: _which tenant is this request for?_

| STRIDE | Threat                                                              | Mitigation                                                                                                                       | Proven by / when                    |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| S      | Tenant chosen by `Host`, body, query or header                      | The **credential** carries `orgId`; no endpoint accepts `orgId`; `X-Patchgrid-Tenant` is a consistency assertion only (ADR-0024) | route review, isolation #3 · M1     |
| S      | Access cookie forged, or tossed from a sibling subdomain            | Signed JWT verified once (pipeline step 7); per-tenant cookie names; ceiling is logout — **R-1**                                 | M1                                  |
| S      | Org-A token presented for org B                                     | `403`                                                                                                                            | isolation #3 · M1                   |
| T      | CSRF from a sibling subdomain (same-site, so `SameSite` is no help) | `X-Requested-With: patchgrid` forces a preflight the API controls; `Origin` must resolve to the credential's org                 | CORS unit tests (M0) · CSRF test M1 |
| I      | Cross-tenant id probing                                             | Reads of invisible rows are `404`, never `403`; ids are not secrets                                                              | isolation #2 · M1                   |
| I      | Slug existence (`404` vs `401`)                                     | Accepted — **R-2**                                                                                                               | —                                   |
| D      | Unauthenticated flood buys Redis/DB lookups                         | Per-IP throttle precedes tenant resolution; per-org and per-token throttles after                                                | M1                                  |
| E      | Disabled or demoted member keeps a live access token                | Redis revocation epoch per membership; fails **closed for mutations** — reads are **R-3**                                        | authz · M1                          |
| E      | `pg_id` mints a session for a membership that is gone               | `pg_id` is a rotating `RefreshToken` row; minting re-reads `Membership` and the epoch (TM-5, ADR-0031)                           | M1                                  |

### TB3 · Actor → action, within one tenant (authorization)

| STRIDE | Threat                                                                                   | Mitigation                                                                                              | Proven by / when        |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------- |
| E      | An endpoint ships without a permission check                                             | Deny by default; route-coverage reflection test fails the build                                         | authz #3 · M1 (CI gate) |
| E      | Admin promotes self; lead approves own change; token widens scope                        | Pure `can()` over the catalog/matrix table; explicit `SCOPE_GRANTS`; forbidden families for tokens      | authz #1, #6, #8 · M1   |
| E      | Last owner removed by a concurrent demotion race                                         | `SELECT … FOR UPDATE` on `Organization` inside the mutation                                             | authz #6 · M1           |
| E      | Client sets `priority` or `status` directly                                              | `priority` rejected with `400`; `status` only via `POST /tickets/:id/transitions`                       | M2                      |
| I      | Requester reads internal notes; `OWN_TEAM_ONLY` agent sees other teams via search or SSE | `comment:read_internal`; one `scopeFor()` consumed by lists, search and SSE fan-out                     | authz #4, #5 · M1–M3    |
| I      | UI hides a button the API would still honour, or shows one it would refuse               | UI renders `permissions[]` and per-subject `capabilities` computed by the same `can()`                  | M1–M2                   |
| T      | Lost update between two agents                                                           | `version` on `Ticket`/`KnowledgeArticle`; mismatch `409`                                                | M2                      |
| R      | A change without an attributable actor                                                   | Audit written in the same transaction; `actorKind` distinguishes `MEMBER`/`SERVICE`/`SYSTEM`/`PLATFORM` | M1–M2                   |

### TB4 · API → Postgres, and tenant ↔ tenant inside it

| STRIDE | Threat                                                                                             | Mitigation                                                                                                                    | Proven by / when                      |
| ------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| I      | A repository query forgets `orgId`                                                                 | Explicit `orgId` argument **and** the client extension **and** RLS — three independent layers                                 | isolation #4, #6 · M1                 |
| T      | A row written with a foreign `orgId`                                                               | `WITH CHECK` on every policy                                                                                                  | isolation #5 · M1                     |
| T/I    | A correctly-tenanted row references another tenant's row (RI checks run with row security **off**) | Composite `(orgId, id)` foreign keys; people referenced by `membershipId` (ADR-0023)                                          | isolation #10 · M1                    |
| I      | A pooled connection carries the previous request's tenant                                          | `set_config(…, true)` — transaction-local only; await **inside** the context (ADR-0015 erratum)                               | isolation #4 · M1                     |
| I      | Unset or empty GUC                                                                                 | `NULLIF(…, '')::uuid` — both yield zero rows, neither raises                                                                  | isolation #12 · M1                    |
| E      | App role can bypass RLS                                                                            | `patchgrid_app` has no `BYPASSRLS`, no ownership; `FORCE ROW LEVEL SECURITY`; boot refuses otherwise; migration URL ≠ app URL | `db:doctor` (M0), boot assertion (M0) |
| E      | A new table ships without a policy, grant or composite key                                         | Schema-introspection assertions in CI                                                                                         | isolation #7, #10, #11 · M1           |
| E      | `runAsPlatform` used to read tenant content                                                        | It carries no tenant context, so tenant tables return zero rows; imports restricted by module                                 | ESLint (M0) · call-site test M1       |
| E      | A projection (`UserOrgIndex`) used to authorize                                                    | Columns named `roleForDisplay`; repository exposes only `listWorkspacesForUser()`; stale-projection test                      | authz · M1                            |
| T      | Raw SQL skips the extension                                                                        | Raw SQL only in `packages/database`                                                                                           | ESLint (M0)                           |

### TB5 · API ↔ Redis, BullMQ, SSE

| STRIDE | Threat                                                          | Mitigation                                                                                                     | Proven by / when  |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------- |
| I      | A job runs without tenant context, or in the wrong one          | Every tenant-queue payload carries `orgId`; processor wraps in `runAsTenant`; a payload without it is rejected | isolation #8 · M3 |
| I      | SSE delivers another tenant's, or an unreadable ticket's, event | Channels `org:<orgId>:…` bound to the token's org; fan-out filtered by `scopeFor()`                            | M3                |
| T      | Redis flush grants free quota                                   | Postgres `UsageCounter` is authoritative; conditional increment in the creating transaction                    | isolation #9 · M1 |
| D      | One tenant starves the queues                                   | Dispatcher → per-tenant jobs, never one global scan; per-tenant priority                                       | M3                |

### TB6 · Browser ↔ object storage (M5)

| STRIDE | Threat                                         | Mitigation                                                                                                                             | Proven by / when |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| E      | Uploaded file executes as script (stored XSS)  | Allow-list excludes SVG/HTML/XHTML; byte sniffing at `complete`; `Content-Disposition: attachment`; served from its own registrable domain, boot-asserted (ADR-0037) | M5               |
| I      | Object from another tenant fetched             | Keys `org/<orgId>/…`; presigned GET issued only after `ticket:read` on the owning ticket; 2-minute TTL                                 | M5               |
| D      | Oversized upload or orphaned objects eat quota | Exact signed `Content-Length`; storage quota increments **and** decrements; hourly sweep deletes row and object                        | M5               |

### TB7 · Inbound mail provider → API (M6)

Per ADR-0027: verify the webhook signature first; resolve the tenant from the recipient, never guess;
require a DMARC-aligned `PASS`; map the sender to an active `Membership` (unknown senders dropped by
default); thread only when the verified sender is a participant — knowing `INC-000042` is not
authorization to post on it; never auto-reply to a failed sender (no backscatter). Residual: **R-7**.

Built in M6 (ADR-0039), each step proven by `apps/api/test/inbound/inbound.int-spec.ts`:

- The signature is Standard Webhooks HMAC over the raw bytes, with five minutes of tolerance.
- The tenant is the envelope recipient, and the answer is `202` whatever it resolves to.
- The verdict comes only from the `Authentication-Results` header carrying our receiver's authserv-id.
  Comments inside it are stripped, so a `dmarc=pass` can't hide there.
- The sender acts through the ordinary permission checks, as the member they are.
- Messages are deduplicated per org by `Message-ID`, and a worker claims a message before acting on it.
- Each sender is limited to 20 messages an hour per workspace.
- Our own mail is marked `Auto-Submitted`, so it never comes back in as a ticket.

### TB8 · Model output → agent (M7, built last)

Ticket text is attacker-controlled, so model output is **data an agent accepts**, never an instruction and
never auto-applied. The model suggests impact and urgency, never priority. It runs locally, so tenant text
never leaves the deployment. Triage is asynchronous; a timeout or failure never blocks ticket creation.

### TB9 · Operator → tenants (M8)

No impersonation, ever. Content access only inside an owner-granted, read-only, time-boxed support
session, run through `runAsTenant` so RLS stays enforcing, with one `SUPPORT_READ` per request written
to the tenant's own log. A failed audit write ends the session. Revocation is immediate via the epoch.
Platform admins are created only by CLI, and MFA is mandatory for them (M9). How a request becomes a
platform actor comes from its own credential, minted only after a second factor (ADR-0040, which
resolved TM-2).

### TB10 · Repository → CI → production

Exact pins where `latest` is dangerous (Prisma); pnpm blocks postinstall scripts outside `allowBuilds`;
`pnpm audit --audit-level=high`, gitleaks over full history, CodeQL `security-extended`, grouped
Dependabot. In production (M10), the ACME token can write only a delegated `_acme-challenge` zone, never
`patchgrid.xyz`. `CAA` records pin the certificate issuer. Every reserved label has an explicit DNS
record, so a dangling record cannot become a subdomain takeover, which would also be a cookie-tossing
position.

---

## 5. Accepted residual risks

Stated so they are decisions, not discoveries.

| #   | Risk                                                                                                                                                                                                                                                                                                                                                                                                              | Why accepted                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | **Cookie tossing.** Anything that can run script or emit `Set-Cookie` on _any_ `*.patchgrid.xyz` origin can overwrite `pg_at_<victim>`. The precondition is precise: tenants do not control their subdomain's responses (we serve them), so the attacker needs XSS in `apps/app`, a subdomain takeover, or active content on the attachment host (TM-1). Tokens are signed, so the ceiling is logging a user out. | Structural fix is the Public Suffix List, which breaks the shared session (ADR-0026). Revisit if tenants are ever mutually hostile |
| R-2 | **Slug existence oracle** — tenant resolution answers `404` vs `401` before authentication                                                                                                                                                                                                                                                                                                                        | True of every subdomain SaaS; slugs are public by nature                                                                           |
| R-3 | **Revocation fails open for reads during a Redis outage** — a revoked member may read for ≤ 15 minutes                                                                                                                                                                                                                                                                                                            | Deliberate availability trade (ADR-0024); writes fail closed                                                                       |
| R-4 | **UUIDv7 reveals creation time**                                                                                                                                                                                                                                                                                                                                                                                  | Ids are not secrets and nothing authorizes on them                                                                                 |
| R-5 | **A presigned URL is a bearer capability** for its TTL                                                                                                                                                                                                                                                                                                                                                            | 2-minute GET / 5-minute PUT, issued only after an RBAC check                                                                       |
| R-6 | **No antivirus scanning** of attachments                                                                                                                                                                                                                                                                                                                                                                          | Out of scope with a stated reason (ADR-0005); mitigated by the allow-list, sniffing and forced download                            |
| R-7 | **Inbound trust rests on the mail provider's verdict**                                                                                                                                                                                                                                                                                                                                                            | We already depend on it to deliver the message at all                                                                              |
| R-8 | **TOTP is phishable in real time**                                                                                                                                                                                                                                                                                                                                                                                | Passkeys are not (ADR-0053, M13); a member may hold both, and TOTP stays for those who choose it. Operators keep TOTP only         |
| R-9 | **A support session can read internal notes**                                                                                                                                                                                                                                                                                                                                                                     | Otherwise it cannot diagnose anything; the consent screen says so in those words                                                   |
| R-10 | **Deprovisioning at the identity provider ends nothing in Patchgrid** (ADR-0054): a person removed there keeps an open session until it expires or an admin disables their membership | No SCIM (out of scope, ADR-0048); the session is bounded by the refresh lifetime, and disabling a member is honoured on the next request |
| R-11 | **Whoever controls a workspace's domain controls its people's Patchgrid accounts** — through its IdP (scoped to the workspace) and through password-reset mail to addresses on the domain (not scoped) | True of every email-identified product; proving the domain by DNS is what makes the first equal to the second rather than worse |

---

## 6. Findings from drawing the boundaries

Five places where the spec was wrong or silent. **TM-3, TM-4 and TM-5 are decided** (ADR-0031, 2026-09-23).
TM-1 was decided in M5 (ADR-0037) and TM-2 in M8 (ADR-0040).

| #        | Finding                                                                                                                                                                                                                                                                                                                                                                                    | Proposed fix                                                                                                                                                                                                                                                                                                  | Needed by              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **TM-1** | **`files.patchgrid.xyz` is same-site with every session.** `DNS.md` §1 and `ARCHITECTURE.md` §Security posture say a separate origin means "an uploaded document is never same-site with a session cookie". Same-site is decided by the registrable domain, so `files.patchgrid.xyz` receives the `Domain=.patchgrid.xyz` cookies, and any active content it served could toss them (R-1). | Serve attachments from a **separate registrable domain** (the `githubusercontent.com` pattern) — e.g. `patchgrid-files.xyz`, name to be chosen. Keep `files` in `RESERVED_SLUGS`. Correct `DNS.md` and `ARCHITECTURE.md`; ADR-0005 gets an erratum.                                                           | **Decided** — ADR-0037 |
| **TM-2** (decided: ADR-0040) | **The platform actor is "resolved from the host"** (`RBAC.md` §2). This is the same inversion ADR-0024 corrected for tenants: `api.patchgrid.xyz` never sees `admin.` in its `Host`.                                                                                                                                                                                                       | A **distinct platform credential**, never minted by tenant login and only after MFA. `Origin: admin.patchgrid.xyz` corroborates it, exactly as a tenant `Origin` does. A tenant credential presented from `admin.` is `403`, and so is a platform credential from a tenant origin.                            | M8                     |
| **TM-3** | **Invitation acceptance is not bound to the invited email.** The token proves possession of a link, not identity. A forwarded or leaked `ADMIN` invite admits whoever clicks it, including a logged-in user with a different account.                                                                                                                                                      | Accept only when the accepting account's email equals `Invitation.email` (normalised). A new account created through the link may be marked verified, because the link proves control of the inbox. A mismatch returns the same generic failure as a bad token.                                               | **Decided** — ADR-0031 |
| **TM-4** | **Account enumeration is unaddressed**, and signup ("login if the email exists") is an explicit oracle.                                                                                                                                                                                                                                                                                    | Reset always returns `202`. Signup returns `202` and emails either "verify your address" or "you already have an account". Login says "invalid email or password". All three are throttled per IP and per email hash. Or accept it explicitly as R-10; either way, decide it.                                 | **Decided** — ADR-0031 |
| **TM-5** | **`pg_id` is the most powerful cookie and is unspecified**: format, lifetime, rotation, storage, revocation. It can mint a session pair for every workspace the user belongs to.                                                                                                                                                                                                           | Treat it as a refresh token: opaque, rotating, hashed in `RefreshToken` with `orgId` null (the column is already optional), 7-day lifetime. Minting a tenant pair re-reads `Membership` inside `runAsTenant`, never `UserOrgIndex`, and checks the epoch. Password change and "log out everywhere" revoke it. | **Decided** — ADR-0031 |

### TB11 · Tenant-chosen URL → the network (webhooks, M11)

A tenant admin names the address the platform sends to, so the request can be aimed back at our own
network. Only `https`, no credentials, no redirects, 10 seconds, 4 KB of the answer kept. Every address
the host resolves to is checked **inside the connection's own `lookup`**, so the vetted address is the
one dialled. IPv6 is an allow-list (global unicast, less its reserved blocks), and IPv4 inside IPv6 is
judged as that IPv4. A refusal tells the tenant the kind of failure, never the address. Payloads carry
ids and states only, so a leaked delivery log holds no ticket text. Secrets are sealed under a key the
database never holds. No token manages webhooks. Per-tenant in-flight leases and a circuit per endpoint
keep one tenant's dead receiver from becoming everyone's queue (ADR-0050, §8).

### TB12 · A workspace's identity provider → sign-in (M13)

A tenant admin chooses the issuer, and the issuer's answer decides who is signed in. So the boundary
has two directions: the API fetching from a URL a tenant typed, and the API believing what that URL
signs. Both are bounded (ADR-0054).

- **Fetching.** Discovery, keys and the token endpoint go through TB11's guarded request: vetted
  addresses at connect, no redirects, five seconds, a bounded body. `https` only, unless
  `SSO_ALLOW_PRIVATE_ISSUERS`, which boot refuses in production. Saving a connection runs discovery, and
  the issuer the document names must be the one configured.
- **Believing.** The authorization code is exchanged with PKCE (S256). `openid-client` checks the ID
  token's signature against the issuer's keys, and its issuer, audience, expiry and nonce. The callback is
  accepted only in the browser that started it (the `pg_sso` cookie must equal `state`) and only once
  (`GETDEL`). The address must be verified by the provider **and** be at the workspace's DNS-proved
  domain. A provider can therefore vouch only for people whose mail its workspace already controls.
- **Containment.** The session it starts is scoped to its workspace (`RefreshToken.ssoOrgId`, copied
  through every rotation and pair). It opens no other workspace. Every tenant-less route refuses it
  unless the route admits it — "who am I" and "open my workspace" only — so no account-wide change
  (password, factors, passkeys, erasure, a new workspace, an invitation), no account-wide logout and no
  view of the person's other workspaces is had on a provider's say-so. Withdrawing the connection ends
  every session it started.
- **Provisioning.** A new person joins at the connection's default role, `REQUESTER` or `AGENT`, never
  above (a CHECK), and takes a seat if an agent. A disabled or removed membership is never revived. An
  unverified account at the address loses its password before the provider's person gets it (a
  pre-registered squatter keeps nothing). A new issuer unlinks every subject.
- **Control.** The connection and "SSO required" are owner-only and take a step-up, because whoever
  controls them can sign in as anyone at the domain, owners included. Owners are exempt from the
  requirement, which is the way back in when the provider is down or hostile, and they never step up
  at the provider: an owner's irreversible actions take the owner's own credentials (§10).

---

## 7. The M9 security review (2026-10-16)

Three independent read-only reviews of the boundaries above, against the code as built, before M9
closed. Every confirmed finding was fixed in the same change set, with a test where one can hold it.
Suspected items were checked and either fixed or recorded below. Nothing crossed a tenant boundary;
the themes were budgets that could be spent by strangers, bearer capabilities in the wrong channel,
and one gap in the step-up rule.

| # | Boundary | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | TB2 | The per-org throttle counted requests on an **unverified** cookie claim, so anyone knowing an org's id could exhaust its budget and lock its members out | The org throttler runs after `AuthGuard`, on verified requests only; the per-IP limit still precedes resolution |
| 2 | TB1 | A known API-token **prefix** spent that integration's 300/min from anywhere, and every wrong secret cost a full Argon2id verify (HANDOFF open item) | The token throttle is keyed on prefix **and** address; the verifier remembers rejected secrets per prefix, so a replayed guess is a hash lookup |
| 3 | TB2 | A bare `pg_id` could **enrol a second factor** and lock the person out | Enrolment takes the password (ADR-0045 erratum) |
| 4 | TB3 | **Inviting an owner** bypassed the step-up and `org:transfer_ownership` that promoting one requires | The invitation path asserts both for `OWNER` |
| 5 | TB1 | Invitation tokens and search text travelled in **query strings** into logs and, with OpenTelemetry, spans | Query strings are dropped from request logs; `token`, `q` and `cursor` are redacted from HTTP spans; Redis spans carry the command only |
| 6 | TB9 | A support session's **attachment download** was logged without the attachment id | `SUPPORT_READ` records the route parameters as well as the query |
| 7 | TB6 | The export mail carried a **24-hour presigned link** to the whole workspace | The mail links to Settings, which signs the owner in and issues a 15-minute link on the click |
| 8 | TB9 | Erasure left the person's address on **inbound mail** rows | `InboundEmail.fromAddress` is tombstoned with the rest |
| 9 | TB7 | A verified sender could attach a `RELATES_TO` link to a ticket they could **not see** | The link is made only when the sender could have made it through the API |
| 10 | TB1 | `/session/refresh?next=/\evil` was an **open redirect** (backslash form) | The page uses the same `parseNext` as login |
| 11 | TB1 | A completed MFA **challenge** could be replayed inside its five minutes | Each challenge's `jti` is spent once, in Redis, like a used code |
| 12 | TB2 | A deletion request could leave a cached `ACTIVE` summary for 60 s, during which a token kept working (HANDOFF open item) | `invalidate` leaves a marker that forbids storing for one TTL; API tokens are refused on an org-level epoch from the request until a restore |
| 13 | TB2 | Client-supplied `X-Request-Id` was unbounded | Honoured only in a proxy's shape: 1–128 chars of `[A-Za-z0-9._-]` |
| 14 | TB10 | gitleaks ran from `latest`; three compose images were `latest`; actions were tag-pinned | Digest pins for images, commit pins for actions, Dependabot moves both |
| 15 | TB7 | The inbound webhook had only the generous default per-IP limit | 60 a minute per address |
| 16 | TB10 | The browser suite resolved `*.lvh.me` through public DNS | Pinned in the runner's hosts file |

Checked and left as they are, with the reason:

- **`trust proxy` is `1`** (`bootstrap.ts`). Correct for exactly one proxy hop; the deployment (M10)
  must set it to the real hop count or every per-IP limit becomes attacker-chosen. Recorded for M10.
- **A `complete` racing the attachment sweep** can orphan a final object (suspected). Bounded by quota
  and a stale presign; a leak, not a bypass. Left for the sweep to learn `storageKey` when it matters.
- **Raw SQL outside `prisma.transaction()`** runs with no GUC and so returns nothing (fail-closed).
  Every site reads inside a transaction today; a lint is the right fix when a second site appears.
- **R-1 stands**: a `pg_id` in the wrong hands still opens workspaces; finding 3 narrows what it can
  change, and password reset keeps the factor — email possession must not undo it.

## 8. The M11 review (2026-10-17)

Three independent read-only reviews before M11 closed: the outbox relay, webhook security and
webhook delivery. Nothing crossed a tenant boundary, and nothing in signing, secret handling or
authorization was found wanting. Every confirmed finding was fixed in one change set, with a test where
one can hold it.

| # | Area | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | TB11 | The delivery log echoed resolver errors (`postgres resolves to 172.18.0.3`), so a tenant could map internal names to private addresses | The log says the kind of failure only; the address goes to the server's log |
| 2 | TB11 | IPv4-compatible (`::7f00:1`), SIIT and local-use NAT64 forms, and the RFC 9637 documentation range, passed the IPv6 check | IPv6 is an allow-list of global unicast, less its reserved blocks |
| 3 | TB9 | Audit rows held full webhook URLs, often credentials, readable in a support session that `webhook:manage` keeps out | The audit keeps the origin and a fingerprint of the path |
| 4 | TB5 | A tenant at its in-flight cap sent jobs round every second through a transaction, and the sweep added a fresh copy of each per minute | The lease is taken before any query (plan cached); a turned-away job waits 0.5 s doubling to 30 s; job ids are the scheduled time, so duplicates collapse |
| 5 | ADR-0050 | A circuit coming due released every waiting delivery at once, and doubled per failure, not per probe | One attempt takes the probe by moving the reopening time, conditionally; the rest wait for its answer |
| 6 | ADR-0049 | A drain retried a failed event straight away, so three wakes in a second parked it, and a deadlock counted as the event's fault | The backoff lives on the cursor (2 s, 8 s, 32 s); deadlocks, serialization failures and timeouts are the job's, not the event's |
| 7 | ADR-0049 | A failure could be recorded outside the consumer's lock, on a cursor already past the event | Recorded under the lock, and only while the cursor is before the event |
| 8 | TB4 | The purge removed cursors before events, so a stray drain between could replay a deleted workspace's log | Events go first |
| 9 | ADR-0050 | A new endpoint received events from before it existed when the consumer was behind | An endpoint hears only of events after its creation |
| 10 | ADR-0050 | A second rotation inside the overlap cut off receivers on the first secret; a replay into a turned-off endpoint died at once; a secret that would not open looped forever; a claim missed by a clock a few ms behind waited for the sweep | Each is refused, refused, marked dead with its reason, and given a 2 s tolerance |

Checked and left as they are, with the reason:

- **Email after a drain is best effort.** ADR-0049's erratum says so; a `mail` consumer of the log is
  the fix when it matters (HANDOFF).
- **Parked events have no replay path** yet. They are on record with their error; replaying them is an
  admin action to build with the dead-letter view.
- **A pending flag can lapse behind a long queue**, costing a duplicate drain: fairness, not
  correctness.

## 9. The M12 review (2026-10-17)

Two read-only reviews: the reporting read side, and saved views with bulk actions. Nothing crossed a
tenant boundary, no view widened anyone's sight, and no bulk path did what the single route refuses.
Every confirmed finding was fixed in one change set.

| # | Area | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | ADR-0051 | An assignment that moved only the team, or unassigned, wrote no event: the fact stayed stale until the reconcile | `ticket-changed` is appended whenever no `ticket-assigned` is |
| 2 | ADR-0051 | A reconcile batch read before an SLA flag could land its older fact after the consumer's newer one, at the same version | The reconcile holds the consumer's lock while it writes |
| 3 | ADR-0051 | Times to resolve and the resolved count included Changes and Problems, whose "resolution" is a lead time | Only tickets with a resolution clock |
| 4 | ADR-0051 | Cancelling a ticket hid a response that had already breached | A cancelled ticket counts when its response breached |
| 5 | TB3 | The CSV download ran a team's or a person's name as a spreadsheet formula | Cells starting with `=`, `+`, `-`, `@`, a tab or a return are defused |
| 6 | ADR-0051 | Every ticket written in the minutes before the reconcile was logged as drift | Drift only past a five-minute grace; the fact is refreshed either way |
| 7 | TB5 | A fault on one ticket turned a bulk run into a 500 with no results, and the page said nothing changed | That ticket is `failed`, the run goes on; the page refreshes and says some may have changed |
| 8 | TB5 | One bulk request is two hundred writes, priced as one request | 10 a minute per address, 30 per workspace, and one run per member at a time |
| 9 | ADR-0052 | Refusals read "The request failed validation"; a bad assignee was refused two hundred times | The field's own reason; the assignment is checked once first |
| 10 | ADR-0052 | Approvals could be run in bulk; an admin outside a team could not remove its orphaned view; the priority filter had no index; a picked row that changed since still counted | Approve and reject are not bulk actions; admins reach team views; `(orgId, priority, createdAt, id)`; a stale pick no longer counts |

Checked and left as they are, with the reason:

- **Reports describe tickets as they are now** (ADR-0051 erratum): a reopen moves a ticket's resolution to
  the month it was last resolved. Keeping every resolution is an event-history read model, not a fact row.
- **A clock stopped exactly at its deadline is met**, where the scan breaches at the deadline: a
  millisecond apart, never observed.
- **A view stays shared with a team its author left.** It runs as each reader, so it shows nothing it
  should not; the team's lead or an admin removes it.


## 10. The M13 review (2026-10-23)

Three read-only reviews: the SSO sign-in path, the scope of an SSO session with its settings and
tenancy, and passkeys with the app side of both. Nothing crossed a tenant boundary in the database, and
no SSO session could become an unscoped one. The findings were about **what a workspace's identity
provider could reach beyond its workspace**, and checks the design assumed but the code did not make.
Every confirmed finding was fixed in one change set, with a test where one can hold it.

| # | Area | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | TB12 | The ID token's signature was never checked: `openid-client` does so only when asked, and a local provider has no TLS | `enableNonRepudiationChecks`; a forged signature and a foreign audience are refused in the spec |
| 2 | TB12 | A page could send a visitor through its own workspace's provider into its own workspace (login CSRF; the `state` cookie is the visitor's own) | A cross-site start is refused (`Sec-Fetch-Site`, code `foreign`) |
| 3 | TB12 | "Log out everywhere" from an SSO session ended the person's sessions in every workspace | It ends that workspace's sessions only |
| 4 | TB12 | Wrong codes at step-up from an SSO session locked the person's factors in every workspace | SSO sessions step up at their provider only; factor routes refuse them |
| 5 | TB12 | `GET /auth/identity` told a provider's admin the person's other workspaces and roles | A scoped identity lists its workspace only, and no factor status |
| 6 | TB12 | Disabling the connection or replacing its issuer left every session it had started alive for days | Both revoke those sessions and bump those members' epochs |
| 7 | TB12 | A new issuer reused the stored client secret, presenting it to whatever host the new issuer named | A new issuer or client id needs a new secret |
| 8 | TB12 | Whoever runs the provider could sign in as an owner and step up into `org:manage_sso`, deletion and tokens | Owners never step up at the provider; they re-prove with their own credentials |
| 9 | ADR-0054 | Requiring SSO silently shut out members below owner whose addresses are off the domain; an invitation accepted then failed after the join | A soft block (`409 sso-members-outside`, retried with `confirm`); acceptance answers `session: null` |
| 10 | ADR-0053 | A recovery code proving a new passkey or authenticator revoked the session the next request needed, burning a second code | Those two routes refuse a recovery code; recovery codes for a new factor are decided under the person's lock |

Smaller ones, fixed with the above: the address claim is held to the contracts' email schema; races
between two first sign-ins and policy refusals at step-up come back as codes, not error pages; a step-up
that fails lands back on its page; a domain claimed at signup gets its TXT challenge; a proof must match
the challenge it checked; the discovery cache drops old versions; a browser already signed in as the
person keeps its identity and gains the scoped pair; the picker, the login landing, the step-up dialog
and the SSO form follow the API's answers.

Checked and left as they are, with the reason:

- **The provider is trusted to be single-tenant for the workspace** (ADR-0054 erratum 8): `email_verified`
  is believed and Google's `hd` is not checked. Configuring a social or multi-tenant issuer is the
  workspace owner's error, and the settings page asks for the workspace's own provider.
- **Step-up at the provider depends on it honouring `max_age=0`.** One that ignores it answers `stale`;
  its members confirm with Patchgrid credentials instead.
- **A passkey assertion counts on any workspace host and `app.`.** One RP ID across the hosts is the
  design (ADR-0053), so script injected on any tenant host could run a ceremony for a visitor. This is
  no wider than the credentialed CORS those hosts already have, and no such injection is known.
- **API tokens keep working when SSO becomes required.** They are service accounts, not people, and
  "SSO required" gates the next authentication of a person (ADR-0042, ADR-0054).
- **Deprovisioning at the provider ends nothing in Patchgrid** (R-10), and **a domain's owner controls
  password reset for addresses on it** (R-11).
