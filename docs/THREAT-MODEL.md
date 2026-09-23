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
| E      | Uploaded file executes as script (stored XSS)  | Allow-list excludes SVG/HTML/XHTML; byte sniffing at `complete`; `Content-Disposition: attachment`; separate origin — **but see TM-1** | M5               |
| I      | Object from another tenant fetched             | Keys `org/<orgId>/…`; presigned GET issued only after `ticket:read` on the owning ticket; 2-minute TTL                                 | M5               |
| D      | Oversized upload or orphaned objects eat quota | Exact signed `Content-Length`; storage quota increments **and** decrements; hourly sweep deletes row and object                        | M5               |

### TB7 · Inbound mail provider → API (M6)

Per ADR-0027: verify the webhook signature first; resolve the tenant from the recipient, never guess;
require a DMARC-aligned `PASS`; map the sender to an active `Membership` (unknown senders dropped by
default); thread only when the verified sender is a participant — knowing `INC-000042` is not
authorization to post on it; never auto-reply to a failed sender (no backscatter). Residual: **R-7**.

### TB8 · Model output → agent (M7)

Ticket text is attacker-controlled, so model output is **data an agent accepts**, never an instruction and
never auto-applied. The model suggests impact and urgency, never priority. It runs locally, so tenant text
never leaves the deployment. Triage is asynchronous; a timeout or failure never blocks ticket creation.

### TB9 · Operator → tenants (M8)

No impersonation, ever. Content access only inside an owner-granted, read-only, time-boxed support
session, run through `runAsTenant` so RLS stays enforcing, with one `SUPPORT_READ` per request written
to the tenant's own log. A failed audit write ends the session. Revocation is immediate via the epoch.
Platform admins are created only by CLI, and MFA is mandatory for them (M9). How a request becomes a
platform actor is **underspecified — see TM-2**.

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
| R-8 | **TOTP is phishable in real time**                                                                                                                                                                                                                                                                                                                                                                                | Passkeys are the next ADR; the factor model does not obstruct them (ADR-0029)                                                      |
| R-9 | **A support session can read internal notes**                                                                                                                                                                                                                                                                                                                                                                     | Otherwise it cannot diagnose anything; the consent screen says so in those words                                                   |

---

## 6. Findings from drawing the boundaries

Five places where the spec was wrong or silent. **TM-3, TM-4 and TM-5 are decided** (ADR-0031, 2026-09-23).
**TM-1 and TM-2 are open**; each needs a decision before the milestone named, and each corrects an
accepted document.

| #        | Finding                                                                                                                                                                                                                                                                                                                                                                                    | Proposed fix                                                                                                                                                                                                                                                                                                  | Needed by              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **TM-1** | **`files.patchgrid.xyz` is same-site with every session.** `DNS.md` §1 and `ARCHITECTURE.md` §Security posture say a separate origin means "an uploaded document is never same-site with a session cookie". Same-site is decided by the registrable domain, so `files.patchgrid.xyz` receives the `Domain=.patchgrid.xyz` cookies, and any active content it served could toss them (R-1). | Serve attachments from a **separate registrable domain** (the `githubusercontent.com` pattern) — e.g. `patchgrid-files.xyz`, name to be chosen. Keep `files` in `RESERVED_SLUGS`. Correct `DNS.md` and `ARCHITECTURE.md`; ADR-0005 gets an erratum.                                                           | M5                     |
| **TM-2** | **The platform actor is "resolved from the host"** (`RBAC.md` §2). This is the same inversion ADR-0024 corrected for tenants: `api.patchgrid.xyz` never sees `admin.` in its `Host`.                                                                                                                                                                                                       | A **distinct platform credential**, never minted by tenant login and only after MFA. `Origin: admin.patchgrid.xyz` corroborates it, exactly as a tenant `Origin` does. A tenant credential presented from `admin.` is `403`, and so is a platform credential from a tenant origin.                            | M8                     |
| **TM-3** | **Invitation acceptance is not bound to the invited email.** The token proves possession of a link, not identity. A forwarded or leaked `ADMIN` invite admits whoever clicks it, including a logged-in user with a different account.                                                                                                                                                      | Accept only when the accepting account's email equals `Invitation.email` (normalised). A new account created through the link may be marked verified, because the link proves control of the inbox. A mismatch returns the same generic failure as a bad token.                                               | **Decided** — ADR-0031 |
| **TM-4** | **Account enumeration is unaddressed**, and signup ("login if the email exists") is an explicit oracle.                                                                                                                                                                                                                                                                                    | Reset always returns `202`. Signup returns `202` and emails either "verify your address" or "you already have an account". Login says "invalid email or password". All three are throttled per IP and per email hash. Or accept it explicitly as R-10; either way, decide it.                                 | **Decided** — ADR-0031 |
| **TM-5** | **`pg_id` is the most powerful cookie and is unspecified**: format, lifetime, rotation, storage, revocation. It can mint a session pair for every workspace the user belongs to.                                                                                                                                                                                                           | Treat it as a refresh token: opaque, rotating, hashed in `RefreshToken` with `orgId` null (the column is already optional), 7-day lifetime. Minting a tenant pair re-reads `Membership` inside `runAsTenant`, never `UserOrgIndex`, and checks the epoch. Password change and "log out everywhere" revoke it. | **Decided** — ADR-0031 |
