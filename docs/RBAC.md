# Patchgrid — Roles, Permissions and Access Control

The complete authorization spec. `TENANCY.md` covers isolation *between* tenants (RLS, credential
binding, composite keys); that layer runs below everything here and is not a substitute for it. This
document covers authorization *within* a tenant, plus the platform layer above tenants.

Decisions behind this file: ADR-0019 (model and enforcement), ADR-0020 (support access), ADR-0021 (API
tokens), ADR-0025 (multi-team membership).

## 1. Principles

1. **Deny by default.** `can()` returns false unless a rule grants the action. An unknown permission
   string is a denial and a logged error, never a pass.
2. **Authorization is a service-layer concern.** Controller guards are a cheap first filter; the decision
   that matters is made in the service, on the resolved subject. Hiding a button in the UI is a
   convenience, never a control.
3. **Three independent questions**, answered in this order, never conflated:
   - *Which tenant?* → credential binding + composite keys + RLS (`TENANCY.md`)
   - *May this actor perform this action on this subject?* → this document
   - *Is the organization within its plan limits?* → `QuotaService`, answered with `402`, not `403`
4. **Permissions derive from the actor's membership in the current organization**, never from a field on
   `User`. The only identity outside a tenant is `PlatformAdmin`.
5. **Not every grant is role-derived.** Ticket ownership, team membership, team leadership and watcher
   status all grant access independently of role.
6. **Every authorization-relevant change is audited** — role changes, invitations, team leadership, org
   settings, token issuance, support sessions.

## 2. Actors

| Actor | Identity | Scope |
| --- | --- | --- |
| **Member** | `User` + `Membership` in the current org | One org, role from the membership |
| **Service account** | `ApiToken` bound to a `Membership` with `kind: SERVICE_ACCOUNT` | One org, role ∩ token scopes, whichever is narrower (ADR-0021) |
| **Platform admin** | `PlatformAdmin` row | Above tenants; metadata always, tenant content only inside a consented support session (ADR-0020) |
| **Anonymous** | none | `apps/www` public pages, signup, slug availability, login, invite acceptance, password reset |

**The member and platform actor kinds are mutually exclusive per request**, resolved from the host:
`admin.patchgrid.xyz` produces a `platform` actor, a tenant subdomain produces a `member` actor. A
platform admin who is also a member of some tenant carries no platform power on that tenant's subdomain,
and no membership power on `admin.`.

## 3. Roles

Roles live on `Membership` and are strictly cumulative: `REQUESTER ⊂ AGENT ⊂ ADMIN ⊂ OWNER`.

| Role | In one line |
| --- | --- |
| `REQUESTER` | An employee who raises and follows their own tickets |
| `AGENT` | IT staff who work the queues |
| `ADMIN` | Configures the workspace: members, teams, categories, SLA policies, automation |
| `OWNER` | `ADMIN` plus the organization itself: plan, slug, ownership transfer, deletion |

**Team lead is not a role.** It is `TeamMembership.isLead` (ADR-0025), granting three capabilities
*scoped to that team*: approve/reject Changes for it, receive its SLA escalations, and manage its
membership (add/remove existing org members). A lead who is only an `AGENT` gains nothing else — they
cannot invite new users or change roles. A member may lead one team while working in another.

**Last-owner protection.** Every org has ≥ 1 `OWNER`. The last owner cannot be demoted, disabled,
removed, or leave. Transfer of ownership is an explicit two-step action (promote, then the outgoing owner
steps down). **The check takes `SELECT … FROM "Organization" WHERE id = :orgId FOR UPDATE` inside the
same transaction as the mutation** — two owners demoting each other simultaneously would otherwise both
observe "not the last one" and leave the org with zero owners (`TENANCY.md` §8).

## 4. Agent visibility scope

`Organization.agentVisibility` is an org setting, default `ALL_TICKETS`:

| Value | An `AGENT` may read |
| --- | --- |
| `ALL_TICKETS` | every ticket in the org |
| `OWN_TEAM_ONLY` | tickets in **any of their teams**, plus tickets with no team, plus tickets assigned to them personally, plus tickets they watch |

`ADMIN` and `OWNER` always see everything. The setting affects reads, list queries, search and SSE
fan-out — never the ability to be *assigned* a ticket, and a cross-team reassignment remains possible for
admins. Changing the setting is an `OWNER`/`ADMIN` action and is audited.

This is expressed once, as a **subject scope filter** the list repositories consume. It is not
re-implemented per endpoint, and — because the `OWN_TEAM_ONLY` case is an `OR` across four different
columns that no single index can serve — `scopeFor()` returns a **list of branches** rather than one
predicate, so repositories emit a `UNION ALL` of index-friendly queries:

```ts
type ScopeFilter =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "any"; branches: ScopeBranch[] };
```

## 5. Watchers

`TicketWatcher { orgId, ticketId, membershipId, addedByMembershipId, addedAt }` — access that is not
role-derived.

- Any member who can read a ticket may add themselves as a watcher. An `AGENT`+ may add another member.
- A watcher receives the same notifications as the requester (public events only — never internal notes,
  never SLA internals).
- A `REQUESTER` who watches a ticket they did not raise gains **read access to public content only**:
  title, description, category, status, priority, public comments, public attachments. Never internal
  notes, never the audit log, never other tickets.
- Watchers are listed on the ticket; adding and removing is audited.
- **The requester and the current assignee are implicit watchers** and cannot be removed. They are not
  rows, so notification fan-out unions them with the explicit set. When the assignee changes, the former
  assignee stops receiving updates and is offered "keep watching", which creates an explicit row.

## 6. Permission catalog and matrix

**One table, not two.** The catalog and the matrix were previously separate lists of ~50 strings that
drifted immediately; the first column below *is* the catalog, mirrored as a `Permission` union type in
`@patchgrid/contracts`, and the matrix test consumes the same rows.

Legend: ✅ unconditional within the org · — denied · `own` the actor is the requester · `watch` the actor
is a watcher · `scope` subject passes §4 · `lead` actor leads the subject's team · `self` the subject is
the actor.

### Tickets

| Permission | Requester | Agent | Admin | Owner |
| --- | --- | --- | --- | --- |
| `ticket:create` (Incident, Service Request) | ✅ | ✅ | ✅ | ✅ |
| `ticket:create` (Problem, Change) | — | ✅ | ✅ | ✅ |
| `ticket:create_on_behalf` | — | ✅ | ✅ | ✅ |
| `ticket:read` | own, watch | scope | ✅ | ✅ |
| `ticket:update` | own, while `NEW` | scope | ✅ | ✅ |
| `ticket:transition` | own: cancel from `NEW`, close from `RESOLVED`, reopen | scope | ✅ | ✅ |
| `ticket:assign` | — | scope | ✅ | ✅ |
| `ticket:link` | — | scope | ✅ | ✅ |
| `ticket:watch` (self) | own, watch | scope | ✅ | ✅ |
| `ticket:watch_others` | — | scope | ✅ | ✅ |
| `ticket:approve_change` | — | `lead`, never own change | ✅, never own | ✅, never own (except the documented last-approver case, `DOMAIN.md` §2.3) |
| `ticket:read_audit` | — | scope | ✅ | ✅ |

### Comments and attachments

| Permission | Requester | Agent | Admin | Owner |
| --- | --- | --- | --- | --- |
| `comment:create_public` | own, watch | scope | ✅ | ✅ |
| `comment:create_internal` | — | scope | ✅ | ✅ |
| `comment:read_internal` | — | scope | ✅ | ✅ |
| `comment:update_own` (15 min window) | `self` | `self` | `self` | `self` |
| `comment:delete` (soft) | — | — | ✅ | ✅ |
| `attachment:upload` | own | scope | ✅ | ✅ |
| `attachment:download` | own, watch (public only) | scope | ✅ | ✅ |
| `attachment:delete` | own, within 15 min | own uploads | ✅ | ✅ |

`comment:*` and `attachment:*` are always evaluated **after** `ticket:read` on the same subject — a
permission on a ticket you cannot see is not reachable. An attachment inherits the visibility of its
parent comment.

### Assets and knowledge

| Permission | Requester | Agent | Admin | Owner |
| --- | --- | --- | --- | --- |
| `asset:read` | `ownerMembershipId = self` | ✅ | ✅ | ✅ |
| `asset:read_all` | — | ✅ | ✅ | ✅ |
| `asset:write` | — | ✅ | ✅ | ✅ |
| `asset:delete` | — | — | ✅ | ✅ |
| `kb:read_published` | ✅ | ✅ | ✅ | ✅ |
| `kb:read_internal` | — | ✅ | ✅ | ✅ |
| `kb:read_draft` | — | own drafts | ✅ | ✅ |
| `kb:write` | — | ✅ | ✅ | ✅ |
| `kb:publish` | — | ✅ | ✅ | ✅ |
| `kb:delete` | — | own | ✅ | ✅ |

`asset:read` is the self-scoped grant; `asset:read_all` is what lifts it to the whole org. They are
separate permissions so `scopeFor("asset")` has something to branch on.

### Members, teams and configuration

| Permission | Requester | Agent | Admin | Owner |
| --- | --- | --- | --- | --- |
| `member:read` (display name + avatar) | ✅ | ✅ | ✅ | ✅ |
| `member:read_contact` (email, last login) | — | ✅ | ✅ | ✅ |
| `member:invite` | — | — | ✅ | ✅ |
| `member:update_role` | — | — | ✅ (below `ADMIN`, never own) | ✅ |
| `member:promote_admin` | — | — | — | ✅ |
| `member:disable` | — | — | ✅ (not Owners, never own) | ✅ |
| `member:remove` | — | — | ✅ (not Owners, never own) | ✅ |
| `team:read` | — | ✅ | ✅ | ✅ |
| `team:write` | — | — | ✅ | ✅ |
| `team:manage_own_members` | — | `lead` | ✅ | ✅ |
| `category:read` | ✅ | ✅ | ✅ | ✅ |
| `category:write` | — | — | ✅ | ✅ |
| `sla:read` | — | ✅ | ✅ | ✅ |
| `sla:write` | — | — | ✅ | ✅ |
| `automation:read` | — | ✅ | ✅ | ✅ |
| `automation:write` | — | — | ✅ | ✅ |

`category:read` exists because a Requester must see the tree to file a ticket — the previous draft had no
such permission, which the route-coverage test would have failed on the portal's first endpoint.
An Admin cannot change their own role or disable themselves; only an Owner can act on an Owner.

### Organization, notifications, integrations, support

| Permission | Requester | Agent | Admin | Owner |
| --- | --- | --- | --- | --- |
| `notification:read` / `notification:update` | `self` | `self` | `self` | `self` |
| `org:read_settings` | — | ✅ | ✅ | ✅ |
| `org:update_settings` | — | — | ✅ | ✅ |
| `org:read_audit` | — | — | ✅ | ✅ |
| `org:export` | — | — | — | ✅ |
| `org:change_slug` | — | — | — | ✅ |
| `org:manage_plan` | — | — | — | ✅ |
| `org:transfer_ownership` | — | — | — | ✅ |
| `org:delete` / `org:cancel_deletion` | — | — | — | ✅ |
| `token:read` / `token:create` / `token:revoke` | — | — | ✅ | ✅ |
| `support:read_sessions` | — | — | ✅ | ✅ |
| `support:grant_access` / `support:revoke_access` | — | — | — | ✅ |

`support:request_access` is a **platform** permission, not a tenant one — a platform admin may ask, only
an owner may grant (§9).

### Field-level rules on `Ticket`

| Field | Who may change it | When |
| --- | --- | --- |
| `title`, `description` | requester | only while `NEW` |
| | agent+ | any non-terminal state |
| `categoryId` | requester on create; agent+ any time | — |
| `impact`, `urgency` | requester on create only; agent+ any time | recomputes `priority` and SLA targets from the stored clock origins (`DOMAIN.md` §4.2) |
| `priority` | **nobody** — computed (`DOMAIN.md` §3) | — |
| `requesterMembershipId` | agent+ with `ticket:create_on_behalf` | on create only |
| `assigneeMembershipId`, `teamId` | agent+ (subject to §4) | non-terminal states |
| `status` | only via `POST /tickets/:id/transitions` | per the transition table |
| `version` | system only — optimistic concurrency | supplied by the client, compared, incremented |
| SLA fields, clock origins, `number`, `orgId`, `source` | system only | — |
| `ProblemDetails`, `ChangeDetails` | agent+ | before the type's terminal states |

## 7. What the API returns so the UI never re-derives rules

A flat permission list cannot express "may update **own** tickets **while `NEW`**". If `GET /me` were the
only source, the UI would render an Edit button on every ticket and learn the truth from a `403` — which
is exactly the re-derivation the design forbids. So there are two levels:

- **`GET /me`** → `{ user, membership, org, teams: [{ id, name, isLead }], permissions[] }`. The
  permission list is **role-level**: what this role can *ever* do. It drives navigation and page-level
  gating only.
- **`GET /tickets/:id`** → the ticket plus `availableActions[]` (ADR-0006) **and** `capabilities`:

```jsonc
{
  "availableActions": ["resolve", "wait", "cancel"],
  "capabilities": {
    "editableFields": ["title", "description", "impact", "urgency", "categoryId"],
    "canCommentPublic": true,
    "canCommentInternal": true,
    "canAddWatcher": true,
    "canUploadAttachment": true,
    "canReadAudit": true
  }
}
```

`capabilities` is computed by the same `can()` calls the mutation endpoints will make, on the same
resolved subject — so the button that is shown is the button that will succeed. List endpoints carry a
reduced form per row where per-row affordances matter.

## 8. Platform admin

`PlatformAdmin` is outside tenancy and deliberately narrow.

| Capability | Allowed |
| --- | --- |
| List organizations; read name, slug, plan, status, counts, created date | ✅ always |
| Suspend / unsuspend an org; set plan; restore a pending deletion | ✅ always, audited in the tenant's log |
| Read tenant **content** (tickets, comments, attachments, KB, member details) | ❌ — only inside a consented support session (§9) |
| Write tenant content | ❌ — support sessions are **read-only** in v1 |
| Read platform-level user records (email, login times) for support and abuse handling | ✅ |
| Impersonate a user's identity to act on their behalf | ❌ ever |

- **Bootstrap**: platform admins are created only by a CLI command run against the database
  (`pnpm platform:grant <email>`), audited to a platform log. There is no API route that creates one, so
  there is no route to abuse.
- Actions on tenant *metadata* run through `runAsPlatform()`; anything touching tenant *content* runs
  through `runAsTenant(orgId)` so RLS stays enforcing throughout (ADR-0022). Both log actor, reason and
  target on every call.
- A platform admin who is also an `OWNER` of some tenant may grant themselves a support session for
  **that** tenant, because they are genuinely its owner. It is audited identically and appears in the
  tenant's banner like any other.

## 9. Support access (consent-based)

Read-only, owner-granted, time-boxed, loudly visible. See ADR-0020.

```
SupportSession { id, orgId, platformAdminId, grantedByMembershipId, reason,
                 grantedAt, expiresAt, firstUsedAt?, revokedAt?, endedAt? }
```

- An `OWNER` grants access from org settings, choosing a duration (max 72 h) and seeing what it permits.
  A platform admin may *request* access; only an owner grants it.
- While active: read-only access scoped to exactly an `ADMIN`'s **read** permissions minus `token:read`.
  This deliberately includes `comment:read_internal` and `org:read_audit` — a support session that cannot
  see internal notes cannot diagnose anything — and the consent screen says so in those words.
  Credentials, token values, password hashes and refresh tokens are never readable by anyone.
- **Reads are audited per request, not per row.** One `SUPPORT_READ` row per API call:
  `{ sessionId, platformAdminId, endpoint, entityType, entityIds[] (capped at 50), resultCount, filters }`.
  Per-row auditing would put thousands of rows into the customer's log for a single page view and make
  the transparency feature unreadable — the opposite of its purpose. Recorded by a
  `SupportSessionInterceptor` at the repository boundary.
- The audit write is **buffered outside the read's transaction** — a failed audit write must not fail a
  read — but a failure **terminates the session**: if we cannot record what was looked at, looking stops.
- Visibility while active: a persistent banner for the tenant's admins and owners, plus email to all
  owners on grant, on first use, and on expiry.
- Any owner can revoke instantly — backed by the revocation epoch (`TENANCY.md` §6), not by token
  expiry. Sessions auto-expire; expiry and revocation are audited.
- Support sessions cannot be granted for `PENDING_DELETION` orgs.

## 10. Service accounts and API tokens

See ADR-0021. Summary:

- `ApiToken { id, orgId, name, tokenHash, prefix, scopes[], membershipId, createdByMembershipId,
  lastUsedAt?, expiresAt?, revokedAt? }`, plus a platform-class `ApiTokenIndex { prefix, orgId }` so the
  bearer strategy can establish tenant context before reading a tenant-owned table (ADR-0022).
- A token is bound to a `Membership` with `kind: SERVICE_ACCOUNT` and role `AGENT` (or `REQUESTER` for
  intake-only integrations), so **RBAC and RLS apply unchanged** — a token is another actor, never a
  bypass. It appears in the members list, visibly marked.
- Effective permission = role matrix **∩** token scopes. Scopes only narrow, never widen.

**The scope → permission mapping is data, not prose**, and lives beside the catalog:

| Scope | Grants |
| --- | --- |
| `tickets:read` | `ticket:read`, `ticket:read_audit`, `attachment:download`, `category:read` |
| `tickets:write` | `ticket:create`, `ticket:create_on_behalf`, `ticket:update`, `ticket:transition`, `ticket:assign`, `ticket:link`, `ticket:watch`, `comment:create_public`, `attachment:upload` |
| `comments:internal` | `comment:create_internal`, `comment:read_internal` — **opt-in, never implied by `tickets:*`** |
| `assets:read` / `assets:write` | `asset:read`, `asset:read_all` / `asset:write` |
| `kb:read` | `kb:read_published`, `kb:read_internal` |
| `webhooks:write` | reserved; grants nothing in v1 |

- Regardless of scopes, a token never grants `member:*`, `org:*`, `token:*`, `support:*`, or
  `comment:read_internal` unless `comments:internal` is explicitly present. A leaked monitoring token
  cannot read your internal notes, escalate, invite, or mint more tokens.
- Presented as `Authorization: Bearer pg_<prefix>_<secret>`; stored as an Argon2id hash; the secret is
  shown exactly once. `prefix` allows identification in logs and leak scanning.
- Token requests skip cookie and `Origin` binding — the token *is* the tenant binding — and a token used
  against another org's subdomain is `403`.
- Tickets created by a token get `source: API`; the audit actor kind is `SERVICE`, so machine changes are
  never misread as a colleague's.
- Rate limits are per token, separate from per-user and per-IP limits. Revocation is immediate via the
  epoch (`TENANCY.md` §6).

## 11. Enforcement

```ts
type Actor =
  | { kind: "member";   userId: string; orgId: string; membershipId: string; role: Role;
      teamIds: string[]; leadOfTeamIds: string[] }
  | { kind: "service";  orgId: string; membershipId: string; role: Role; scopes: Scope[] }
  | { kind: "platform"; userId: string; supportSessionId?: string; supportOrgId?: string };

interface PermissionService {
  can(actor: Actor, permission: Permission, subject?: Subject): boolean;
  assert(actor: Actor, permission: Permission, subject?: Subject): void;   // throws ForbiddenError
  scopeFor(actor: Actor, resource: ResourceKind): ScopeFilter;             // drives list queries
  permissionsFor(actor: Actor): Permission[];                              // role-level, for navigation
  capabilitiesFor(actor: Actor, subject: Subject): Capabilities;           // per-subject, for buttons
}
```

- `can()` is **pure** — role, subject and relationship flags in, boolean out, no I/O. The whole matrix is
  unit-testable without a database.
- Anything needing data (is this actor a watcher? is this ticket's team one of theirs?) is loaded by the
  service into a `Subject` first, then passed in.
- `can()` never considers `orgId`. By the time it runs, tenancy is already resolved; conflating the two
  layers is how subtle leaks happen.
- **`403` vs `404`, as a rule rather than a judgement call:** a *read* of any tenant-owned entity the
  actor may not see returns `404`. An *action* on an entity the actor can already see, but may not
  perform, returns `403`. Nothing else is left to taste, because "wherever existence is sensitive" drifts
  the moment two people implement it.

## 12. Auditing authorization changes

Beyond ticket mutations (`DOMAIN.md` §7), these are audited into the tenant's `AuditLog`:

`MEMBER_INVITED`, `MEMBER_JOINED`, `MEMBER_ROLE_CHANGED`, `MEMBER_DISABLED`, `MEMBER_REMOVED`,
`TEAM_CREATED/UPDATED/DELETED`, `TEAM_MEMBER_ADDED/REMOVED`, `TEAM_LEAD_CHANGED`,
`ORG_SETTINGS_UPDATED`, `ORG_SLUG_CHANGED`, `ORG_PLAN_CHANGED`, `ORG_SUSPENDED/UNSUSPENDED`,
`ORG_DELETION_REQUESTED/CANCELLED`, `ORG_EXPORTED`, `OWNERSHIP_TRANSFERRED`, `AGENT_VISIBILITY_CHANGED`,
`TOKEN_CREATED/REVOKED`, `SUPPORT_ACCESS_REQUESTED/GRANTED/REVOKED/EXPIRED`, `SUPPORT_READ`,
`WATCHER_ADDED/REMOVED`, `SLA_POLICY_CHANGED`, `AUTOMATION_RULE_CHANGED`,
`COMMENT_EDITED`, `COMMENT_DELETED`, `CHANGE_SELF_APPROVED`.

Admins and owners read this at `GET /org/audit` (`org:read_audit`), filterable by actor, action and date
— each of which has a matching index (`ARCHITECTURE.md` §Indexes).

## 13. Testing

The matrix is data, so it is tested as data.

1. **Exhaustive matrix test** — every `(role, permission, subject-relationship)` combination is asserted
   against a table in the test file. Adding a permission without a matrix row fails the suite; so does a
   matrix row with no catalog entry, because both now come from the same source.
2. **Deny-by-default test** — an unknown permission string returns false and logs.
3. **Endpoint coverage test** — every controller route is enumerated by reflection; a route with neither
   `@Public`, `@TenantOptional` nor a permission assertion in its service fails CI. This is what stops an
   unguarded endpoint shipping.
4. **Scope filter tests** — `OWN_TEAM_ONLY` agents (including multi-team ones), requesters and watchers
   get exactly the expected row sets from real queries, through every branch of the `UNION ALL`.
5. **Negative integration tests** per role: internal notes never appear in a requester's response;
   `403`s surface as `404`s per the §11 rule; a token cannot touch `member:*`/`org:*`.
6. **Escalation tests** — last-owner protection *under concurrency* (two simultaneous demotions leave one
   owner), a lead cannot approve their own change, an admin cannot promote themselves to owner or change
   their own role, a token cannot widen its own scopes, a `comments:internal`-less token cannot read
   internal notes.
7. **Support-session tests** — no content access without an active session; reads are logged once per
   request to the tenant's audit log; expiry and revocation take effect on the next request via the
   epoch, not after the access token expires.
8. **Scope-mapping test** — for every `(scope-set, role)` pair, the effective permission set equals
   `matrix(role) ∩ union(SCOPE_GRANTS)`, and never contains a forbidden family.

These run as part of `pnpm test:authz`; the tenancy isolation suite (`ENGINEERING.md`) remains separate
because it tests a different layer.
