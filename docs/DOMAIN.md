# Patchgrid — Domain Rules

This file is the ITSM business-logic spec. If code and this file disagree, one of them is wrong — fix it, don't work around it. Every rule here maps to a unit-tested Service method.

**Everything in this file is scoped to one organization.** Tenancy, membership and isolation live in `TENANCY.md`; authorization within an organization lives in `RBAC.md`. This document assumes a resolved tenant and an authorized actor; "the org" always means the tenant of the current request.

## 1. Record types

| Type | Purpose | Has SLA | Has approval gate | Can link to |
| --- | --- | --- | --- | --- |
| `INCIDENT` | Restore a broken/degraded service fast | Yes | No | Problem (`CAUSED_BY`), other tickets (`RELATES_TO`, `DUPLICATE_OF`) |
| `SERVICE_REQUEST` | Fulfil a standard, pre-approved request | Yes | No (catalog items are pre-approved by definition) | other tickets (`RELATES_TO`, `DUPLICATE_OF`) |
| `PROBLEM` | Find and fix a root cause behind incidents | No | No | Change (`RESOLVED_BY`); incidents point *at* it via `CAUSED_BY` |
| `CHANGE` | Planned modification, approved before execution | No | Yes | other tickets (`RELATES_TO`); a Problem points *at* it via `RESOLVED_BY` |

**Link relations are stored in one canonical direction and rendered from both ends.** `CAUSES` is not a
relation — it is `CAUSED_BY` read backwards, and storing both invites two rows asserting the same fact
with nothing keeping them consistent. The four relations are:

| Relation | Stored as | Reads as |
| --- | --- | --- |
| `CAUSED_BY` | incident → problem | "caused by PRB-x" / "causes INC-y" |
| `RESOLVED_BY` | problem → change | "resolved by CHG-x" / "resolves PRB-y" |
| `DUPLICATE_OF` | duplicate → survivor | "duplicate of INC-x" / "has duplicates" |
| `RELATES_TO` | symmetric; normalised so `fromTicketId < toTicketId` | "relates to" both ways |

Unique on `(orgId, fromTicketId, toTicketId, relation)`, with `fromTicketId <> toTicketId` as a `CHECK`.
A `DUPLICATE_OF` target that is itself a duplicate is followed to the survivor rather than chained, so
merge chains cannot form a cycle.

Every type shares the core `Ticket` row (number, title, description, category, requester, assignee, team, impact, urgency, priority, timestamps). Type-specific fields live in **extension tables** (`ProblemDetails`, `ChangeDetails`) — see ADR-0002.

**Ticket numbers** are per-type, zero-padded, generated server-side and never reused: `INC-000042`,
`SR-000007`, `PRB-000003`, `CHG-000011` (ADR-0009). The `TicketCounter` row lock serialises creation per
`(org, type)` for the rest of the transaction, so it is taken **last** — after the quota increment,
priority computation and SLA maths — keeping the critical section to the insert itself.

## 2. Status state machines

One `TicketStatus` enum holds the union of all statuses. The Ticket service owns a **per-type transition
table**; any transition not listed below is rejected with `409 Conflict`. A `CHECK` constraint
additionally enumerates the valid `(type, status)` pairs, so a service bug becomes a database error
rather than an impossible row (ADR-0002).

Every table below has the same six columns, because the table *is* the data structure:
`from · action · to · who · guards · effects`. A guard that lives only in prose does not get implemented.

### 2.1 Incident and Service Request

```
NEW ──assign──▶ ASSIGNED ──start──▶ IN_PROGRESS ──resolve──▶ RESOLVED ──close──▶ CLOSED
 │                 │                    │  ▲                    │                  │
 │                 │            wait    ▼  │ resume             │ reopen           │ reopen
 │                 │                 PENDING ◀──────────────────┴──────────────────┘
 │                 │                    │                       (reopen → IN_PROGRESS)
 └─── cancel ──────┴──── cancel ────────┴──▶ CANCELLED ◀── cancel ── IN_PROGRESS
```

| From | Action | To | Who | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| `NEW` | `assign` | `ASSIGNED` | Agent+, automation | assignee or team is a member/team of this org | sets `assigneeMembershipId` and/or `teamId` |
| `NEW`, `ASSIGNED` | `start` | `IN_PROGRESS` | Assignee, Admin+ | — | if unassigned, the actor becomes assignee |
| `IN_PROGRESS` | `wait` | `PENDING` | Assignee, Admin+ | public comment required (the reason the requester must act) | `pausedAt = now`; resolution clock pauses |
| `PENDING` | `resume` | `IN_PROGRESS` | Assignee, Admin+, **or automatically when the ticket's own requester posts a `PUBLIC` comment** | — | `pausedMinutes += now − pausedAt`; `pausedAt = null` |
| `IN_PROGRESS` | `resolve` | `RESOLVED` | Assignee, Admin+ | resolution note required (public comment) | `resolvedAt = now` |
| `RESOLVED` | `close` | `CLOSED` | Requester (own), Agent+, auto-close worker after 7 days | — | `closedAt = now` |
| `RESOLVED` | `reopen` | `IN_PROGRESS` | Requester (own), Agent+ | — | clears `resolvedAt`; `reopenCount += 1`; fresh resolution clock |
| `CLOSED` | `reopen` | `IN_PROGRESS` | Requester (own), Agent+ | **`now ≤ closedAt + 30 days`** | clears `resolvedAt`/`closedAt`; `reopenCount += 1`; fresh resolution clock |
| `NEW` | `cancel` | `CANCELLED` | Requester (own), Agent+ | — | terminal; SLA clocks stop and are never evaluated |
| `ASSIGNED`, `IN_PROGRESS`, `PENDING` | `cancel` | `CANCELLED` | Agent+ | reason comment required | terminal; SLA clocks stop and are never evaluated |

`IN_PROGRESS → CANCELLED` exists deliberately: spam, duplicates and mistaken tickets are most often
recognised *while being worked*, and forcing them through `RESOLVED` would pollute the resolution and
SLA statistics this product exists to report on. Duplicate merging (§10) depends on it.

**Everything not in the table is denied**, and the following denials are deliberate rather than
oversights: `PENDING → RESOLVED` (resume first, so the pause arithmetic closes cleanly),
`RESOLVED → CANCELLED`, `CLOSED → CANCELLED`, and any transition out of `CANCELLED` — cancellation is
final, and a mistakenly cancelled ticket is reopened as a new one with a `RELATES_TO` link.

`REOPENED` is an **action** and an audit-log entry, not a status: a reopened ticket goes straight back to
`IN_PROGRESS`. Keeping it out of the status enum avoids a status meaning "in progress but flagged", which
every list view would then need to special-case.

### 2.2 Problem

```
NEW ──assign──▶ ASSIGNED ──start──▶ IN_PROGRESS ──workaround──▶ KNOWN_ERROR ──resolve──▶ RESOLVED ──close──▶ CLOSED
                                         │                                            ▲
                                         └────────── resolve (no workaround needed) ──┘
```

| From | Action | To | Who | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| `NEW` | `assign` | `ASSIGNED` | Agent+ | — | sets assignee and/or team |
| `NEW`, `ASSIGNED` | `start` | `IN_PROGRESS` | Assignee, Admin+ | — | if unassigned, actor becomes assignee |
| `IN_PROGRESS` | `workaround` | `KNOWN_ERROR` | Assignee, Admin+ | `ProblemDetails.workaround` required | `knownErrorAt = now` |
| `IN_PROGRESS`, `KNOWN_ERROR` | `resolve` | `RESOLVED` | Assignee, Admin+ | `ProblemDetails.rootCause` required | `resolvedAt = now` |
| `RESOLVED` | `close` | `CLOSED` | Agent+, auto-close after 7 days | — | `closedAt = now` |
| any non-terminal | `cancel` | `CANCELLED` | Agent+ | reason comment required | terminal |

Problems have **no `PENDING`** (they are not waiting on a requester) and **no SLA clocks**. Incidents
linked to a `KNOWN_ERROR` can be resolved by applying the documented workaround. A Problem is never
created by a Requester.

### 2.3 Change

```
DRAFT ──submit──▶ AWAITING_APPROVAL ──approve──▶ APPROVED ──start──▶ IN_PROGRESS ──complete──▶ IMPLEMENTED ──close──▶ CLOSED
  ▲                      │                                                │
  └──── reject ──────────┘                                                └──── rollback ──▶ ROLLED_BACK ──close──▶ CLOSED
  (REJECTED is recorded on ChangeApproval; the ticket returns to DRAFT for edit & resubmit, or is CANCELLED)
```

| From | Action | To | Who | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| `DRAFT` | `submit` | `AWAITING_APPROVAL` | Change requester (Agent+), Admin+ | `plannedStart`, `plannedEnd`, `implementationPlan`, `rollbackPlan`, `risk` all present | notifies eligible approvers |
| `AWAITING_APPROVAL` | `approve` | `APPROVED` | Admin+, or a **lead of the change's team** — never the change's own requester or assignee | see *eligible approvers* below | `ChangeApproval { decision: APPROVED }` |
| `AWAITING_APPROVAL` | `reject` | `DRAFT` | same as approve | reason required | `ChangeApproval { decision: REJECTED, reason }` |
| `APPROVED` | `start` | `IN_PROGRESS` | Assignee, Admin+ | before `plannedStart − 1 h` requires `confirm: true` | — |
| `IN_PROGRESS` | `complete` | `IMPLEMENTED` | Assignee, Admin+ | `outcomeNotes` required | — |
| `IN_PROGRESS` | `rollback` | `ROLLED_BACK` | Assignee, Admin+ | `outcomeNotes` required | — |
| `IMPLEMENTED`, `ROLLED_BACK` | `close` | `CLOSED` | Agent+, auto-close after 7 days | — | terminal |
| `DRAFT`, `AWAITING_APPROVAL`, `APPROVED` | `cancel` | `CANCELLED` | Change requester, Admin+ | — | terminal |

**Eligible approvers**, stated exhaustively because the obvious rule deadlocks:

1. Any `ADMIN` or `OWNER` who is neither the change's requester nor its assignee; **or**
2. any member with `isLead` on the change's team, who is neither requester nor assignee.

A Change with no team simply has no route (2); admins remain eligible.

3. **If (1) and (2) are both empty**, an `OWNER` may approve their own change. The `ChangeApproval` row
   records `selfApproved: true`, the UI labels it as such, and it is audited as a distinct action. This
   is not a loophole — it is the honest description of how a one-admin organization operates, and every
   freshly provisioned workspace is one. Blocking submission instead would make the very first Change in
   a new workspace fail.

"Not before `plannedStart − 1 hour`" is a soft block, not a warning: the transition returns `409` with
`type: …/change-window-early` unless the body carries `confirm: true`. Successful mutations never carry
advisory text — the API has no channel for it, and a dialog the user must dismiss is the honest UI.

Only Agents and Admins can create Changes. Requesters cannot.

### 2.4 Terminal states

`CLOSED` and `CANCELLED` are terminal for all types, with one exception, now expressed as a guard in
§2.1: `CLOSED` Incidents and Service Requests can be reopened within **30 days** of `closedAt`. After
that the requester must open a new ticket (the UI offers "open a new ticket linked to this one" →
`RELATES_TO`).

## 3. Priority matrix

| Impact \ Urgency | Low | Medium | High |
| --- | --- | --- | --- |
| **High** | Medium | High | Critical |
| **Medium** | Low | Medium | High |
| **Low** | Low | Low | Medium |

- Computed in the Ticket service on create and whenever `impact` or `urgency` changes. A client-supplied `priority` is rejected with `400`.
- Applies to all four types (it is a useful sort key for Problems and Changes too), but **SLA policies are attached only to Incidents and Service Requests**.
- The LLM triage (later milestone) produces `suggestedImpact` / `suggestedUrgency`, never a priority, so the matrix remains the single source of truth.

## 4. SLA rules

Applies to `INCIDENT` and `SERVICE_REQUEST` only. Clocks run **24×7** in v1 (ADR-0003). All timestamps
are `timestamptz`, stored and compared in UTC (ADR-0023).

### 4.1 Policy

```
SLAPolicy { orgId, ticketType, priority,
            responseTargetMinutes, resolutionTargetMinutes,
            responseWarningMinutes, resolutionWarningMinutes }
```

Uniqueness: one policy per `(orgId, ticketType, priority)` — 2 types × 4 priorities = **8** seeded on
provisioning, identical across the two types initially so an admin can loosen Service Request targets
without touching Incidents.

The two warning thresholds are separate on purpose. A single threshold cannot serve a 15-minute response
target and a 4-hour resolution target at once: at 15 minutes for both, a Critical incident emits a
response warning at `t = 0`, the instant it is created.

| Priority | Response | Warn before | Resolution | Warn before |
| --- | --- | --- | --- | --- |
| Critical | 15 min | 5 min | 4 h | 45 min |
| High | 30 min | 10 min | 8 h | 1 h |
| Medium | 1 h | 15 min | 24 h | 2 h |
| Low | 4 h | 1 h | 72 h | 4 h |

Editing a policy **does not** retarget tickets that already have absolute deadlines — `respondBy` and
`resolveBy` are stored, not derived on read, so history stays interpretable. Open tickets keep the
targets they were created under; the change is audited as `SLA_POLICY_CHANGED` and takes effect for
tickets created or re-prioritised afterwards.

### 4.2 Clock lifecycle

Both clocks have an explicit **origin** stored on the ticket, and every rule is the same two formulas:

```
respondBy = responseClockStartedAt   + responseTargetMinutes
resolveBy = resolutionClockStartedAt + resolutionTargetMinutes + pausedMinutes
```

`responseClockStartedAt` and `resolutionClockStartedAt` both default to `createdAt`. Making the origin a
column rather than an implicit `createdAt` is what stops the two rules below from contradicting each
other — a reopen moves the origin forward, and a later priority change must not silently move it back.

| Event | Response clock | Resolution clock |
| --- | --- | --- |
| Ticket created | origin = `createdAt` | origin = `createdAt` |
| First **public** comment by an Agent/Admin, or status → `RESOLVED`, whichever is first | `respondedAt = now`; clock stops; `responseBreached` frozen | — |
| Status → `PENDING` | already satisfied (entry requires a public agent comment, which stopped it) | `pausedAt = now` |
| `PENDING` → `IN_PROGRESS` | — | `pausedMinutes += now − pausedAt`; `pausedAt = null`; `resolveBy` recomputed |
| `impact` / `urgency` change → new priority | if not yet responded, recompute from the **stored origin** | recompute from the **stored origin** |
| Status → `RESOLVED` | if not responded, counts as the response | `resolvedAt = now`; clock stops; `resolutionBreached` frozen |
| `reopen` | not restarted; `respondedAt` retained | `resolutionClockStartedAt = now`; `pausedMinutes = 0`; `resolutionBreached = false`; `resolutionWarningSentAt = null` |
| `CANCELLED` | stopped, never evaluated | stopped, never evaluated |

The `PENDING` row used to claim the response clock was "not affected, agents must still respond". That
state is unreachable: entering `PENDING` requires a public agent comment (§2.1), which stops the response
clock in the same transaction. Stating it as unreachable is more useful than stating a rule that can
never fire.

SLA computation is therefore a pure function of `(origins, policy, pausedMinutes, now)` — no database,
no clock reads, fully unit-testable with an injected `Clock`.

### 4.3 Background worker

A BullMQ repeatable job (`sla-scan`, every 60 s, dispatched **per tenant** — ADR-0018) selects open
Incidents and Service Requests with an active clock and:

1. **Warning**: `now ≥ target − warningMinutes` and not yet warned → set `responseWarningSentAt` /
   `resolutionWarningSentAt`, notify assignee + the lead of the ticket's team (in-app + email),
   audit-log `SLA_WARNING`. Never fires when `target − warningMinutes ≤ createdAt`.
2. **Breach**: `now ≥ target` and not yet breached → set `responseBreached` / `resolutionBreached`,
   notify assignee + team lead + all Admins, audit-log `SLA_BREACHED`.

Escalation in the core milestones is exactly the above — hard-coded. When the automation rule engine
lands (§10), `SLA_WARNING` / `SLA_BREACHED` become rule *triggers* and the hard-coded notifications
become the default rules in the seed.

The worker is idempotent: every flag it sets is checked before it acts, so a job that runs twice does
nothing twice.

## 5. Routing and taxonomy

- `Category` is self-referential, **max depth 3**: Category → Subcategory → Item (e.g. Hardware → Laptop → Screen Replacement). Depth is stored and enforced in the service; re-parenting recomputes `depth` for the whole subtree and is rejected if it would exceed 3.
- Names are unique **per parent**, not per org — a real taxonomy has `Hardware → Other` *and* `Software → Other`.
- Categories are **never hard-deleted**, only `isActive: false`: tickets reference them historically, and a deleted category would orphan years of reporting. Inactive categories disappear from pickers and remain on existing tickets.
- A ticket may reference a category at **any depth** (a requester may only know "Hardware"). Agents refine it during triage.
- Each `Category` may have a `defaultTeamId`. On create, if the ticket has no team, it inherits the nearest ancestor's `defaultTeamId` — walked in code, which is trivial at depth ≤ 3. If no ancestor has one, the ticket has no team and lands in the **unassigned** queue, which is a real queue an agent works, not a dead letter.
- Reassignment (agent or team) is always allowed for Agents/Admins and always audit-logged.

## 6. Roles and permissions

**The authorization model lives in `RBAC.md`** — actors, the permission catalog, the full matrix, agent visibility scope, watchers, field-level rules, platform admin, support sessions, service accounts, and how it is enforced and tested. It is a separate document because it spans far more than ticketing.

What matters for the rules in *this* file:

- Roles are on `Membership`, cumulative `REQUESTER ⊂ AGENT ⊂ ADMIN ⊂ OWNER`, resolved for the current tenant.
- **Team lead** (`TeamMembership.isLead`) is a capability, not a role: approve/reject Changes for that team, receive its SLA escalations, manage its membership. A member may lead one team while working in another (ADR-0025).
- Change approval may never be performed by the change's own requester or assignee — enforced in the transition rules (§2.3), not merely in the matrix. The one documented exception, for an organization with no other eligible approver, is in §2.3 and is audited as `CHANGE_SELF_APPROVED`.
- An `AGENT`'s ticket visibility depends on `Organization.agentVisibility` (`ALL_TICKETS` by default, or `OWN_TEAM_ONLY` — which means *any* of their teams). Every list, search and SSE fan-out applies the scope filter from `PermissionService.scopeFor()`; no endpoint re-implements it.
- A **watcher** (requester or agent) sees a ticket's public content and receives its public notifications, without any role granting it. Internal notes and the audit log are never visible to a `REQUESTER`, watcher or not.
- Blocked by a plan limit is `402`, not `403` (`TENANCY.md` §8).
- Authorization assumes a single resolved tenant; isolation between tenants is a lower layer (`TENANCY.md` §7) and is never expressed through roles.

## 7. Comments, attachments, audit

- `Comment.visibility` is `PUBLIC` or `INTERNAL`. The repository layer filters `INTERNAL` out for
  Requesters — it must be impossible for a Requester-scoped query to return one.
- A comment may be **edited by its author within 15 minutes**; `editedAt` is set, the UI shows "edited",
  and the previous body is kept in the audit `diff`.
- **Deletion is soft.** `comment:delete` (Admin+) sets `deletedAt` / `deletedByMembershipId` and the
  thread renders "comment removed by an admin". A hard delete would leave the audit log pointing at
  nothing — unacceptable in a product whose audit trail is a feature. `COMMENT_EDITED` and
  `COMMENT_DELETED` are audited with the previous body.
- Editing a comment never re-triggers a side effect: it does not resume a `PENDING` ticket, does not
  re-notify, and does not stop an SLA response clock that was already stopped.
- Attachments belong to a ticket, and optionally narrow to a comment on that ticket. Max 10 MB each
  (the number lives in `@patchgrid/contracts`, once), allow-listed MIME types verified by **byte
  sniffing** at completion rather than by the declared `Content-Type`. `image/svg+xml`, `text/html` and
  `application/xhtml+xml` are excluded — an SVG is a script-capable document, and this product's users
  upload files precisely because they are suspicious of them. Stored in S3-compatible object storage
  (ADR-0005), served from a separate origin with `Content-Disposition: attachment` except for a small
  inline image allow-list.
- An attachment on an `INTERNAL` comment inherits that visibility: a Requester can never download it,
  even on a ticket they can read.
- `AuditLog` records every mutation on a ticket: field diffs (`{ field: { from, to } }`), status
  transitions, comment added/edited/deleted (id and previous body, never the current body twice),
  attachment added/removed, link added/removed, watcher added/removed, SLA warning/breach, approval
  decisions. Written in the same database transaction as the change. Never deleted within its retention
  window; partitioned monthly and aged out per plan (`ARCHITECTURE.md` §Data model).
- Authorization-relevant changes across the whole org (role changes, invitations, team leadership, org
  settings, tokens, support sessions) are audited into the same log — the catalogue of actions is in
  `RBAC.md` §12.
- Every audit row records **what kind** of actor performed it (`MEMBER`, `SERVICE`, `SYSTEM`,
  `PLATFORM`), so a change made by an API token, an automation rule or a platform admin during a support
  session is never misread as a colleague's action.

## 8. Notifications

Events that notify (in-app always; email per `Membership.emailPrefs`, default on, with an org-level
`Organization.emailNotificationsEnabled` kill switch). Preferences live on the **membership**, not the
user: the same person may be on-call at one company and a casual requester at another, and wants
different behaviour in each.

| Event | Recipients |
| --- | --- |
| Ticket created | Requester (confirmation), team (in-app only) |
| Ticket raised on your behalf by an agent | Requester (email + in-app), named agent shown |
| Invited to the organization | Invitee (email only) |
| Plan limit reached (tickets, seats, storage) | Org admins and owners |
| Assigned | New assignee |
| Public comment | Requester (if author ≠ requester), assignee (if author ≠ assignee), watchers |
| Internal note | Assignee (if author ≠ assignee) |
| Status → `PENDING` / `RESOLVED` / `CLOSED` | Requester, watchers |
| Reopened | Assignee, team lead |
| Watcher added to a ticket | The added member |
| SLA warning / breach | See §4.3 |
| Change awaiting approval | Team lead + Admins |
| Change approved / rejected | Change requester, assignee |

In-app notifications are delivered live via SSE (ADR-0008) and persisted in `Notification` for the
bell/inbox — SSE is a hint, the table is the source of truth. A `dedupeKey` collapses bursts (ten
comments in a minute on one ticket produce one unread badge, not ten). The SSE fan-out applies the same
`scopeFor()` filter as a list query, so an `OWN_TEAM_ONLY` agent never receives an event — not even a
ticket id — for a ticket they may not read.

**The requester and the current assignee are implicit watchers** and cannot be removed. They are not
`TicketWatcher` rows, so every fan-out is a union of the implicit pair and the explicit rows, and the
watcher panel renders both. When the assignee changes, the previous assignee stops receiving updates;
the UI offers them "keep watching", which adds an explicit row.

## 9. Search, knowledge base and CMDB

### 9.1 Search

Search is not a polish item: an agent console without it is unusable, and retrofitting it touches the
schema, the scope filter and the pagination contract.

- `Ticket.searchVector` and `KnowledgeArticle.searchVector` are **generated** `tsvector` columns over
  title + body, with GIN indexes. A generated column avoids a trigger that a future migration could drop.
- The text search configuration is `english`, hard-coded. Multilingual search is an explicit non-goal.
- A query that looks like a ticket number (`INC-000042`, or a bare integer) short-circuits to a direct
  hit on `(orgId, type, number)` before any full-text work.
- **Search results pass through the same `PermissionService.scopeFor()` filter as list queries.** A
  search endpoint that forgets this is the classic agent-visibility leak; it is covered by the
  authorization suite.
- Ranking and keyset pagination do not compose (`ts_rank` is not a stable sort key), so search is the
  one documented exception to cursor pagination (ADR-0012): `ORDER BY ts_rank DESC, id DESC`, capped at
  100 results, with filters available to narrow rather than paginate.

### 9.2 Knowledge base

`KnowledgeArticle` has markdown `body`, optional category, and three-tier `visibility`:

| Visibility | Who can read |
| --- | --- |
| `DRAFT` | the author, plus Admin+ |
| `INTERNAL` | Agent+ — internal runbooks |
| `PUBLISHED` | everyone in the org, including Requesters |

"Published" means published *to the organization*; there is no anonymous or public-internet access to
any article. The portal suggests matching published articles while the requester types a ticket title.
Articles carry a `version` for optimistic concurrency — two agents editing the same runbook is normal.

### 9.3 CMDB

`Asset`: `type`, `status`, optional `ownerMembershipId`, `serialNumber` (unique per org when set),
`purchaseDate`, `warrantyExpiresAt`. Tickets ↔ assets are many-to-many via `TicketAsset`. "Tickets for
this asset" is a plain query on that join. A requester sees only assets they own.

## 10. Later-milestone domain additions (do not build yet)

- **LLM triage** writes a `TicketTriage { suggestedCategoryId, suggestedImpact, suggestedUrgency, summary, model, latencyMs }` row; an agent *accepts* or *dismisses* the suggestion (audit-logged). Suggestions never auto-apply.
- **Phishing subtype** is a `Category` (Security → Phishing) plus a `PhishingReport` 1:1 row. Routing to the Security team is the ordinary `defaultTeamId` rule; the risk score is extra data on the ticket.
- **Duplicate detection** stores an embedding per ticket (`pgvector`) and surfaces the top-3 similar open tickets in the same root category above a similarity threshold. Merging = closing the duplicate as `CANCELLED` with a `DUPLICATE_OF` link and copying its public comments as a system note on the survivor.
- **Automation rules**: `{ trigger: TICKET_CREATED | TICKET_UPDATED | SLA_WARNING | SLA_BREACHED, conditions: [{ field, op, value }] (AND-only), actions: [{ type: ASSIGN_TEAM | ASSIGN_USER | SET_IMPACT | SET_URGENCY | ADD_INTERNAL_NOTE | NOTIFY_EMAIL }] }`. Evaluated in a BullMQ job after the triggering transaction commits, never inline. Every rule execution is audit-logged with the rule id.
