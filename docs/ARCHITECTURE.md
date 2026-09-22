# Patchgrid — Architecture

Tenancy rules live in `TENANCY.md`, ITSM rules in `DOMAIN.md`, working conventions in `ENGINEERING.md`. This file is about *shape*: what runs where, how a request flows, and what the data looks like. The "why" for each non-obvious choice is an ADR in `decisions/`.

## Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript, `strict`, no `any` | Everywhere, including scripts and config |
| Runtime / tooling | Node 24, pnpm 10, Turborepo 2 | pnpm only — never npm/yarn |
| Frontends | Next.js 16 (App Router), React 19, Tailwind 4, shadcn/ui (base-nova, hugeicons) | `apps/www` + `apps/app`. **Next 16 differs from training data** — read `node_modules/next/dist/docs/` before writing routing/caching code (`proxy.ts` replaces `middleware.ts`) |
| Backend | NestJS **11**, deliberately | `apps/api` — the only process that talks to the database. Nest 12 exists, but `nestjs-zod` peers `@nestjs/common ^10 \|\| ^11` and does not support it; staying on 11 is a decision, not neglect. Built with SWC, CommonJS output |
| Database | PostgreSQL 17 + Prisma **7.10.0, pinned exactly**, **Row-Level Security** + composite tenant keys | `packages/database`. **Prisma 7 removed `url` from the datasource block**: connection strings live in `prisma.config.ts` and the client takes a `@prisma/adapter-pg` driver adapter. Two adapters = two pools = the two roles. `pgvector` from day one; UUIDv7 + `timestamptz` (ADR-0023) |
| Tenant context | `nestjs-cls` (`AsyncLocalStorage`) + a Prisma client extension | ADR-0015, ADR-0022 |
| Queue / cache | Redis 7 + BullMQ | tenant-dispatched jobs, quota counters, tenant lookup cache, throttling |
| Object storage | S3-compatible — MinIO locally | attachments via presigned URLs, keyed `org/<orgId>/…` (ADR-0005) |
| Email | Resend in prod; **Mailpit** locally | behind a `MailProvider` interface |
| Validation / contracts | Zod 4 in `packages/contracts`; `nestjs-zod` pipe on the API | one schema, three apps, no codegen |
| Auth | JWT access (15 min, org-bound) + rotating refresh, **per-tenant** httpOnly cookies on `.patchgrid.xyz`; Argon2id; Redis revocation epoch | ADR-0004, ADR-0017, ADR-0024 |
| Realtime | Server-Sent Events, Redis fan-out per org | ADR-0008, ADR-0018 |
| Logging | `pino` via `nestjs-pino`; every line carries `reqId`, `orgId`, `membershipId` | |
| Later: LLM | Ollama (`qwen2.5:3b`, `nomic-embed-text`) in Compose | behind `TicketClassifier` / `EmbeddingProvider` |
| Later: phishing model | Python FastAPI `apps/phishing-svc` | behind `UrlRiskScorer` (ADR-0010) |
| Later: deployment | Coolify on Hetzner; wildcard DNS + wildcard TLS (DNS-01) | not being set up now |

## Monorepo layout

```
apps/
  www/                  # patchgrid.xyz        — marketing, docs, blog, signup (static/ISR)
  app/                  # <slug>.patchgrid.xyz — tenant workspace (fully dynamic)
  api/                  # api.patchgrid.xyz    — NestJS: business logic, data, workers
  phishing-svc/         # (later) Python FastAPI inference service
packages/
  database/             # Prisma schema, migrations, RLS migrations, client extension, seed
  contracts/            # Zod schemas + inferred types for every request/response
  ui/                   # shadcn components, tailwind preset, design tokens
  eslint-config/        # shared flat ESLint configs
  typescript-config/    # shared tsconfig bases
docs/                   # documentation + decisions/
docker-compose.yml      # postgres, redis, minio, mailpit (+ ollama later)
.github/workflows/      # CI
```

Package scope is **`@patchgrid/*`** (ADR-0001). The shadcn scaffold at `apps/web` becomes `apps/app`; `apps/www` is created fresh.

### Dependency rules (ESLint `no-restricted-imports` + review)

```
apps/www  ──▶ @patchgrid/contracts, @patchgrid/ui
apps/app  ──▶ @patchgrid/contracts, @patchgrid/ui
apps/api  ──▶ @patchgrid/contracts, @patchgrid/database
packages/contracts ──▶ zod only
packages/database  ──▶ prisma only
```

- Neither frontend ever imports `@patchgrid/database`. All data access — including server components and server actions — goes through the API over HTTP. SLA math, RBAC, quota checks, audit logging and tenant isolation live in exactly one place.
- `packages/contracts` declares its own Zod enums rather than importing Prisma's, so the wire contract is independent of the storage schema.
- Prisma imports are confined to `apps/api/src/**/repositories/**` and `packages/database`.

## Request pipeline (`apps/api`)

Order matters; this is the spine of the system. The cheapest defence runs first, and the credential —
not the host — carries the tenant (ADR-0024).

```
 1. helmet, CORS (origin validated against the slug regex, credentials on)
 2. Request id + pino logger                       → reqId on every log line
 3. Throttler, per IP                              → a flood is rejected before it costs a lookup
 4. Tenant resolution middleware                                              (ADR-0024)
      Bearer pg_… → ApiTokenIndex → orgId          (cookies ignored)          (ADR-0022)
      else        → access cookie pg_at_<slug>.orgId IS the tenant
      Origin present  → must resolve to that org,  else 403
      Origin absent   → X-Patchgrid-Tenant must match,  else 403
      unknown 404 · suspended 403 · pending-deletion 404 — before any handler
 5. ClsMiddleware                                  → AsyncLocalStorage: { orgId, userId,
                                                      membershipId, role, teamIds, reqId }
 6. Throttler, per org and per token
 7. Authentication strategy → Actor                (session cookie or API token)
      revocation epoch check: reject if iat < rev:<membershipId>              (ADR-0024)
 8. Guards: @Public / @TenantOptional / @RequirePermission(...) / @PlatformOnly
 9. nestjs-zod validation pipe                     → typed DTO
10. Controller → Service
      PermissionService.assert(actor, permission, subject)                    (ADR-0019)
      → Repository, with scopeFor() applied to every list query
        Repository → Prisma client extension
          opens a transaction, SELECT set_config('app.current_org_id', $1, true)
          → Postgres RLS filters and constrains every row                     (ADR-0015)
11. Response; exception filter maps anything thrown to RFC 9457 Problem Details
```

Two notes on the ordering, because both were wrong in an earlier draft:

- **Throttling precedes tenant resolution.** Resolution costs a Redis lookup and sometimes a database
  read; an unauthenticated flood must not be able to buy those.
- **The token is verified exactly once**, in step 7, which is what produces the `Actor`. Step 4 reads the
  cookie's `orgId` claim to route the request but does not trust it until the signature is checked.

Because step 4 answers before authentication, an anonymous caller can probe which slugs exist (404 vs
401). This is true of every subdomain SaaS, is accepted, and is recorded in the threat model rather than
left unremarked.

Tenant-less routes (`/auth/*`, `/orgs` creation, `/orgs/slug-available`, `/health`) are marked
`@TenantOptional` and skip steps 4–6. They reach other tenants only through `runAsPlatform` /
`runAsTenant` (ADR-0022).

## Layered architecture (NestJS)

Every domain module follows **Controller → Service → Repository**.

| Layer | Owns | Must not |
| --- | --- | --- |
| Controller | routes, DTO validation, guards, HTTP status, response mapping | business logic, Prisma |
| Service | rules from `DOMAIN.md` and `TENANCY.md`: transitions, priority, SLA math, permissions, quotas, orchestration, emitting domain events | import Prisma, know about HTTP |
| Repository | typed data access, the **only** Prisma importer, always takes an explicit `orgId` for tenant-owned models | contain business rules |

Cross-module effects run on **domain events** emitted after commit (`@nestjs/event-emitter` for cheap in-process work such as SSE pushes; BullMQ for anything slow or independently retryable). Audit-log writes happen inside the same transaction as the change they describe.

### Modules

```
src/
  common/       # zod pipe, Problem Details filter, guards, decorators, pagination, Clock, runAsPlatform
  config/       # zod-validated env
  tenancy/      # tenant resolution middleware, CLS setup, TenantContext, QuotaService
  prisma/       # PrismaService + tenant client extension
  platform/     # PlatformRepository, runAsPlatform / runAsTenant, org lifecycle, support sessions
  authz/        # PermissionService (pure can/assert/scopeFor), permission catalog, guards
  auth/         # signup, login, refresh, logout, verify email, reset, invites, org switch, API-token auth strategy
  orgs/         # org creation/provisioning, settings, slug change, domain verification
  memberships/ teams/ users/ api-tokens/
  categories/ sla-policies/
  tickets/      # CRUD, transitions, priority, linking, type details
  search/       # ticket + KB search, scopeFor-aware
  comments/ attachments/ audit/ notifications/ assets/ knowledge/
  health/       # liveness + readiness (@nestjs/terminus)
  mail/         # MailProvider + impls + BullMQ processor + templates
  jobs/         # queues, tenant dispatcher, processors
  triage/       # (later) classifier, url scorer, embeddings, duplicates
  automation/   # (later) rule engine
```

## Frontend architecture

### `apps/www` — marketing (`patchgrid.xyz`)

- Mostly static/ISR; MDX for docs and blog; full SEO surface (metadata, OG images, sitemap, robots, JSON-LD).
- Calls exactly three API endpoints: `POST /auth/signup`, `GET /orgs/slug-available`, `POST /contact`. It never renders tenant data and is the only publicly cacheable surface.
- Reads the shared session cookie only to swap "Get started" for "Go to your workspace".

### `apps/app` — product (`<slug>.patchgrid.xyz` and `app.patchgrid.xyz`)

- Fully dynamic. Nothing tenant-specific is statically generated.
- `proxy.ts` parses the host: apex `app.` → tenant-less routes (login, org picker, create workspace, accept invite); `<slug>.` → tenant routes, redirecting to login when the session is missing and to the org picker when the session's org does not match the host.
- Route groups: `(auth)`, `(select)` for the tenant-less org picker, `(portal)` for requesters, `(console)` for agents, `(admin)` for admins/owners.
- A `TenantProvider` holds `{ org, membership }` fetched server-side once per navigation; components read the current role from it rather than re-deriving it.
- Data: one typed `apiFetch()` in `apps/app/lib/api/` — selects and forwards the current tenant's cookie pair server-side, adds `X-Requested-With: patchgrid` and, when running server-side (no `Origin`), `X-Patchgrid-Tenant: <slug>` (ADR-0024); parses with `@patchgrid/contracts`, converts Problem Details to a typed `ApiError`, sends `Idempotency-Key` on entity-creating POSTs, and performs one refresh-and-retry on 401. TanStack Query wraps it on the client. No route handlers acting as a second API (ADR-0007).
- Live updates: `EventSource` on `/api/v1/notifications/stream` drives the notification bell and invalidates queries for changed tickets. A held-open stream consumes one of the browser's ~6 HTTP/1.1 connections per origin, so production terminates TLS with HTTP/2 (any modern ingress does) and the server closes streams after 30 minutes so reconnection is exercised routinely rather than discovered during an incident. `Last-Event-ID` is the `Notification.id`; the client replays from the table beyond the replay cap.
- Forms: `react-hook-form` + `@hookform/resolvers/zod` against the same contract schemas; `402` responses render upgrade prompts, `403` render a permission message.

Both frontends consume `@patchgrid/ui`, so the marketing site and the product look like one product.

## Data model

Prisma-flavoured, not exhaustive. **T** = tenant-owned (`orgId` + RLS policy); **P** = platform (no
tenant policy, listed exhaustively in `TENANCY.md` §7).

**Conventions, enforced by CI introspection tests (ADR-0023):**

- Every *entity* table has `id` (UUID v7, `String @db.Uuid`), `createdAt`, `updatedAt`. Join and counter
  tables have composite primary keys and no `id`; those that never change carry only `createdAt`.
- Every datetime column is `@db.Timestamptz(3)`. There are no `timestamp without time zone` columns.
- Every tenant-owned parent declares `@@unique([orgId, id])`; every child references the **pair**,
  `@relation(fields: [orgId, parentId], references: [orgId, id])`. A cross-tenant reference is
  unrepresentable, not merely rejected.
- **People are referenced by `membershipId`**, never `userId`, except where delivery to a human account
  is the point (`Notification.userId`) or the table is platform class.
- Ids are time-ordered and are **not secrets**. No authorization decision depends on an id being
  unguessable.

```
P  Organization      { id, name, slug (unique), status: ACTIVE|SUSPENDED|PENDING_DELETION,
                       plan: FREE|PRO, domain?, domainVerifiedAt?, allowDomainJoin,
                       defaultJoinRole?, agentVisibility: ALL_TICKETS|OWN_TEAM_ONLY,
                       emailNotificationsEnabled, deletionRequestedAt? }
P  OrganizationSlugHistory { id, orgId, slug (unique), releasedAt, redirectUntil }
P  User              { id, email (unique), passwordHash, name, avatarUrl?,
                       emailVerifiedAt?, lastLoginAt?, anonymisedAt? }
P  PlatformAdmin     { userId }
P  RefreshToken      { id, userId, orgId?, tokenHash, expiresAt, revokedAt?, replacedById?,
                       userAgent?, ip? }
P  PasswordResetToken{ id, userId, tokenHash, expiresAt, usedAt? }
P  EmailVerification { id, userId, tokenHash, expiresAt, usedAt? }

-- derived projections; written transactionally with their source, never used to authorize (ADR-0022)
P  UserOrgIndex      { userId, orgId, roleForDisplay, statusForDisplay,
                       orgSlug, orgName, orgStatus, updatedAt }               -- PK (userId, orgId)
P  ApiTokenIndex     { prefix (unique), orgId, revokedAt? }

T  Membership        { id, orgId, userId, role: OWNER|ADMIN|AGENT|REQUESTER,
                       status: ACTIVE|INVITED|DISABLED, kind: HUMAN|SERVICE_ACCOUNT,
                       displayName, avatarUrl?, emailPrefs: Json,
                       invitedByMembershipId?, joinedAt?, anonymisedAt? }
                                                     -- unique (orgId, userId), (orgId, id)
T  Team             { id, orgId, name, description?, isActive }               -- unique (orgId, name)
T  TeamMembership   { orgId, teamId, membershipId, isLead, joinedAt }         -- PK (orgId, teamId, membershipId)
                                                     -- partial unique (orgId, teamId) WHERE isLead
T  Invitation       { id, orgId, email, role, teamId?, tokenHash, expiresAt,
                      acceptedAt?, revokedAt?, invitedByMembershipId }        -- index (orgId, email)
T  ApiToken         { id, orgId, name, tokenHash, prefix (unique), scopes String[],
                      membershipId, createdByMembershipId, lastUsedAt?,
                      expiresAt?, revokedAt? }                                (ADR-0021)
T  SupportSession   { id, orgId, platformAdminId, grantedByMembershipId, reason,
                      grantedAt, expiresAt, firstUsedAt?, revokedAt?, endedAt? }   (ADR-0020)

T  TicketCounter    { orgId, type, nextValue }                                -- PK (orgId, type)
T  Ticket           { id, orgId, number, type: INCIDENT|SERVICE_REQUEST|PROBLEM|CHANGE,
                      title, description, status: TicketStatus, version Int,
                      impact: LOW|MEDIUM|HIGH, urgency: LOW|MEDIUM|HIGH,
                      priority: LOW|MEDIUM|HIGH|CRITICAL,
                      categoryId?, requesterMembershipId, assigneeMembershipId?, teamId?,
                      slaPolicyId?,
                      responseClockStartedAt, resolutionClockStartedAt,
                      respondBy?, resolveBy?, respondedAt?, resolvedAt?, closedAt?, cancelledAt?,
                      pausedAt?, pausedMinutes, responseBreached, resolutionBreached,
                      responseWarningSentAt?, resolutionWarningSentAt?,
                      reopenCount, source: PORTAL|CONSOLE|EMAIL|API,
                      searchVector (tsvector, generated) }
                                                     -- unique (orgId, type, number), (orgId, id)
T  ProblemDetails   { ticketId (PK), orgId, rootCause?, workaround?, knownErrorAt? }
T  ChangeDetails    { ticketId (PK), orgId, plannedStart?, plannedEnd?, risk?,
                      implementationPlan?, rollbackPlan?, outcomeNotes? }
T  ChangeApproval   { id, orgId, ticketId, approverMembershipId,
                      decision: APPROVED|REJECTED, selfApproved, reason?, decidedAt }
T  TicketLink       { id, orgId, fromTicketId, toTicketId,
                      relation: CAUSED_BY|RELATES_TO|RESOLVED_BY|DUPLICATE_OF,
                      createdByMembershipId }
                                  -- unique (orgId, fromTicketId, toTicketId, relation)
                                  -- CHECK (fromTicketId <> toTicketId)
T  Category         { id, orgId, name, parentId?, depth (1..3), defaultTeamId?,
                      isActive, sortOrder }
                                  -- unique (orgId, parentId, name); partial unique
                                  --   (orgId, name) WHERE parentId IS NULL
T  Comment          { id, orgId, ticketId, authorMembershipId?,
                      authorKind: MEMBER|SERVICE|SYSTEM|AUTOMATION,
                      body, visibility: PUBLIC|INTERNAL,
                      editedAt?, deletedAt?, deletedByMembershipId? }
                                  -- unique (orgId, ticketId, id)  -- lets Attachment key on all three
                                  -- CHECK (authorKind <> 'MEMBER' OR authorMembershipId IS NOT NULL)
T  Attachment       { id, orgId, ticketId, commentId?, uploadedByMembershipId,
                      storageKey, filename, mimeType, sniffedMimeType?, sizeBytes,
                      status: PENDING|READY, scannedAt?, scanVerdict? }
                                  -- ticketId is always present; commentId narrows it.
                                  -- FK (orgId, ticketId, commentId) → Comment(orgId, ticketId, id)
T  Asset            { id, orgId, name, type, status, ownerMembershipId?, serialNumber?,
                      purchaseDate?, warrantyExpiresAt?, notes? }             -- unique (orgId, serialNumber)
T  TicketAsset      { orgId, ticketId, assetId, createdAt }                   -- PK (orgId, ticketId, assetId)
T  TicketWatcher    { orgId, ticketId, membershipId, addedByMembershipId, addedAt }
                                                                              -- PK (orgId, ticketId, membershipId)
T  SLAPolicy        { id, orgId, ticketType, priority,
                      responseTargetMinutes, resolutionTargetMinutes,
                      responseWarningMinutes, resolutionWarningMinutes }
                                                     -- unique (orgId, ticketType, priority)
T  KnowledgeArticle { id, orgId, categoryId?, authorMembershipId, title, slug, body, version Int,
                      visibility: DRAFT|INTERNAL|PUBLISHED, publishedAt?, viewCount,
                      searchVector (tsvector, generated) }                    -- unique (orgId, slug)
T  AuditLog         { id, orgId, entityType, entityId, action, diff: Json,
                      actorKind: MEMBER|SERVICE|SYSTEM|PLATFORM,
                      actorMembershipId?, actorPlatformAdminId?, supportSessionId?, createdAt }
                                                     -- PARTITION BY RANGE (createdAt), monthly
T  Notification     { id, orgId, userId, membershipId, type, title, body?,
                      ticketId?, dedupeKey?, readAt? }
T  UsageCounter     { orgId, period, metric, value, updatedAt }               -- PK (orgId, period, metric)

// later milestones
T  TicketTriage     { ticketId (PK), orgId, suggestedCategoryId?, suggestedImpact?, suggestedUrgency?,
                      summary, model, latencyMs, status: SUGGESTED|ACCEPTED|DISMISSED,
                      decidedByMembershipId?, decidedAt? }
T  TicketEmbedding  { ticketId (PK), orgId, embedding vector(768), model }
T  PhishingReport   { ticketId (PK), orgId, submittedUrl, riskScore,
                      verdict: SAFE|SUSPICIOUS|MALICIOUS|UNKNOWN, modelVersion, analyzedAt? }
T  AutomationRule   { id, orgId, name, trigger, conditions: Json, actions: Json,
                      isActive, sortOrder }
T  InboundEmail     { id, orgId, messageId, fromAddress, senderMembershipId?,
                      authVerdict: PASS|FAIL|NONE, subject, rawStorageKey,
                      ticketId?, processedAt?, error? }
```

`TicketStatus`: `NEW, ASSIGNED, IN_PROGRESS, PENDING, RESOLVED, CLOSED, CANCELLED, KNOWN_ERROR, DRAFT,
AWAITING_APPROVAL, APPROVED, IMPLEMENTED, ROLLED_BACK` — per-type validity is enforced by the service
(ADR-0002) **and** by a `CHECK` constraint enumerating the valid `(type, status)` pairs. The service is
the readable rule; the constraint is the one that cannot be forgotten.

**Uniqueness is per-org**, never global, for ticket numbers, team names, asset serials and KB slugs.
Category names are unique **per parent** (`(orgId, parentId, name)`), because a real taxonomy has
`Hardware → Other` *and* `Software → Other`. `User.email` and `Organization.slug` are the only globally
unique values.

### Indexes

Every tenant-owned index is `orgId`-first, because every query is tenant-filtered. A sort option without
a matching index is not a supported sort option.

```
Ticket(orgId, createdAt DESC, id DESC)          -- the default list + keyset cursor
Ticket(orgId, status, createdAt DESC)
Ticket(orgId, assigneeMembershipId, status)
Ticket(orgId, teamId, status)
Ticket(orgId, requesterMembershipId, createdAt DESC)
Ticket(orgId, categoryId)
Ticket(orgId, resolveBy)  WHERE status IN (open states) AND resolveBy IS NOT NULL   -- SLA scan
Ticket(orgId, respondBy)  WHERE respondedAt IS NULL                                  -- SLA scan
GIN Ticket(orgId, searchVector)
Comment(orgId, ticketId, createdAt)
Attachment(orgId, ticketId)
TicketWatcher(orgId, membershipId)              -- "tickets I watch"
Membership(orgId, userId) · Membership(orgId, role, status) · Membership(userId)
TeamMembership(orgId, membershipId)
Invitation(orgId, email)
AuditLog(orgId, createdAt DESC, id DESC)
AuditLog(orgId, entityType, entityId, createdAt DESC)
AuditLog(orgId, actorMembershipId, createdAt DESC)
AuditLog(orgId, action, createdAt DESC)
Notification(orgId, userId, readAt, createdAt DESC)
GIN KnowledgeArticle(orgId, searchVector)
HNSW TicketEmbedding(embedding)                 -- later
```

`OWN_TEAM_ONLY` agent visibility is an `OR` across four different columns (my teams · no team · assigned
to me · watched by me), which Postgres cannot serve from any single index. `scopeFor()` therefore returns
a **list of branches** rather than one predicate (ADR-0025), so list repositories emit a `UNION ALL` of
index-friendly queries. That return type is the expensive thing to change later; the table behind it is
not.

`AuditLog` is declaratively partitioned by month (`PARTITION BY RANGE (createdAt)`). The parent is
created in hand-written SQL alongside the policies; RLS policies declared on the parent are inherited by
every partition. A monthly job creates the next partition and detaches partitions past the plan's
retention window.

**RLS migrations** live alongside the Prisma migrations as hand-written SQL
(`packages/database/migrations/**/rls.sql`), because Prisma models neither policies, partitions,
partial unique indexes, `CHECK` constraints, nor generated `tsvector` columns. Five introspection tests
gate CI: every tenant-owned table has `relrowsecurity` + `relforcerowsecurity` + a policy; every
tenant-to-tenant foreign key is composite on `orgId`; zero `timestamp without time zone` columns; every
id column is `uuid`; and `patchgrid_app` holds `SELECT` on every tenant-owned table.

## Background jobs (BullMQ, inside `apps/api`)

| Queue | Trigger | Scope |
| --- | --- | --- |
| `tenant-dispatch` | repeat every 60 s | `runAsPlatform` → list active orgs → fan out per-tenant jobs (ADR-0018) |
| `sla-scan` | per tenant, from the dispatcher | `DOMAIN.md` §4.3 |
| `auto-close` | per tenant, hourly | resolved > 7 days → closed |
| `provision-org` | on signup | idempotent extended seeding |
| `mail` | enqueued by services | render + send, backoff retries |
| `usage-reconcile` | nightly, per tenant | recompute `UsageCounter` from source data |
| `org-purge` | daily | hard-delete orgs past the 30-day window, under `runAsTenant` |
| `attachment-sweep` | hourly, per tenant | delete `PENDING` attachments older than 1 h — row **and** object — and decrement `storage_bytes` |
| `projection-reconcile` | nightly, per tenant | recompute `UserOrgIndex` / `ApiTokenIndex` from source; drift is a bug, not a state (ADR-0022) |
| `audit-partition` | monthly, platform | create next month's `AuditLog` partition, detach partitions past retention |
| `triage`, `automation` (later) | per ticket / per event | tenant-scoped |

Workers run in the same Nest process in development; `WORKER_MODE=all|api|worker` allows splitting later without code changes.

## Integration boundaries (later milestones)

```ts
interface TicketClassifier { classify(i: { title: string; description: string; categories: CategoryOption[] })
  : Promise<{ categoryId?: string; impact?: Impact; urgency?: Urgency; summary: string }>; }
interface UrlRiskScorer   { score(url: string): Promise<{ riskScore: number; verdict: PhishingVerdict; modelVersion: string }>; }
interface EmbeddingProvider { embed(text: string): Promise<number[]>; }
interface MailProvider    { send(m: OutboundMail): Promise<{ providerMessageId: string }>; }
```

Each is a Nest injection token with a real implementation and a `Noop`/`Fake` one selected by env. Ticket creation never waits on or fails because of triage: commit first, enqueue after commit, write results when they arrive. Timeouts 20 s / 5 s / 5 s, then log and continue. Tenant data never leaves the deployment — a significant reason the LLM is local (ADR-0010).

## Local infrastructure (Docker Compose)

| Service | Image | Port | Purpose |
| --- | --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg17` | 5432 | main DB + `patchgrid_test`; init script creates extensions, the migration owner (**with** `BYPASSRLS`), and `patchgrid_app` (**without**), transfers database and schema ownership to the owner role, and issues the `GRANT`s + `ALTER DEFAULT PRIVILEGES` the app depends on |
| `redis` | `redis:7-alpine` | 6379 | BullMQ, throttler, tenant cache, quota counters |
| `minio` | `quay.io/minio/minio` | 9000 / 9001 | S3 API / console. **quay.io, not Docker Hub** — `docker.io/minio/minio` is no longer publicly pullable. Bucket `patchgrid-attachments` created by an init container; **CORS is a server setting** (`MINIO_API_CORS_ALLOW_ORIGIN`), not per-bucket — `mc cors set` reports "functionality that is not implemented" |
| `mailpit` | `axllent/mailpit` | 1025 / 8025 | SMTP sink + web inbox |
| `ollama` (later) | `ollama/ollama` | 11434 | triage + embeddings |

Every published port is env-overridable (`POSTGRES_PORT`, `REDIS_PORT`, …) defaulting to the values
above, because another project already owning 5432 is common and "port is already allocated" is an easy
error to misread.

The Compose init script only runs against an **empty data volume**, so the same role/grant/extension SQL
ships as `pnpm db:bootstrap`, which shares `packages/database/sql/bootstrap.sql` with it so the two
cannot drift. Without it, a developer with a pre-existing volume
gets `permission denied for table …` the first time a migration adds a table — see `ENGINEERING.md`
§Local development for why `ALTER DEFAULT PRIVILEGES` is the line that matters.

The three apps run on the host via `pnpm dev` for fast HMR, reachable at `lvh.me:3000` (www),
`<slug>.lvh.me:3001` (app) and `api.lvh.me:4000` — wildcard subdomains work locally with no `/etc/hosts`
edits (ADR-0014). Production-style Dockerfiles are a final-milestone task.

## Security posture

- **Two database roles.** An owner/migration role (holds `BYPASSRLS`, reachable only via
  `DATABASE_MIGRATION_URL`, never by the running app) and `patchgrid_app` with **no** `BYPASSRLS` and no
  table ownership. `FORCE ROW LEVEL SECURITY` means ownership alone does not exempt anyone. The API
  asserts at boot that its own role lacks `BYPASSRLS` and refuses to start otherwise; the config
  validator refuses to start if the two URLs are equal.
- **The schema itself resists cross-tenant data.** Composite foreign keys on `(orgId, id)` make a
  cross-tenant reference unrepresentable, which matters because PostgreSQL runs referential-integrity
  checks with row security disabled (ADR-0023).
- **Cookies** are per tenant (`pg_at_<slug>`, `pg_rt_<slug>`) plus a tenant-less `pg_id`, all `httpOnly`,
  `SameSite=Lax`, `Secure` outside dev, `Domain=.patchgrid.xyz`; the refresh cookie is path-scoped.
  Mutating requests require `X-Requested-With: patchgrid` and an `Origin` matching the resolved tenant —
  subdomains are same-site, so `SameSite` alone does not separate them (ADR-0024).
- **Cookie tossing is a recorded residual risk**: any tenant subdomain can set cookies on the shared
  domain. Signed tokens cap the impact at denial of service; per-tenant names prevent silently switching
  which tenant a user acts in.
- **Revocation is immediate**, not immediate-in-15-minutes: a Redis epoch per membership is checked on
  every authenticated request and bumped on disable, role change, suspension, password change, token
  revoke and support-session revoke.
- Access tokens are org-bound; a token presented for a different org is `403`.
- `@nestjs/throttler` on Redis, per IP **before** tenant resolution and per org/per token after, with
  tight limits on `/auth/*`, signup, slug lookup and portal submission.
- **Attachments**: presigned PUT signing an exact `Content-Length` and `Content-Type` (a PUT cannot
  express a length *range* — only a presigned POST policy can); server-side magic-number sniffing at
  `complete`; `image/svg+xml`, `text/html` and `application/xhtml+xml` excluded from the allow-list;
  `Content-Disposition: attachment` on every presigned GET except a small inline image allow-list; served
  from a separate origin so an uploaded document is never same-site with a session cookie (ADR-0005).
- Env validated by Zod at boot; the process refuses to start on a missing or invalid variable.
- **No PII in logs**: `reqId`, `orgId`, `membershipId`, `userId` only — never emails, ticket bodies or
  tokens. Failed logins log a truncated SHA-256 of the email so abuse is still correlatable.
- Every `runAsPlatform` / `runAsTenant` call logs who, why and from where. Support sessions add a second
  layer: reads are recorded in the tenant's own audit log, per request rather than per row (ADR-0020).
- API tokens are Argon2id-hashed, prefixed for log identification and leak scanning, shown once,
  rate-limited per token, and can never grant `member:*`, `org:*`, `token:*`, `support:*` or
  `comment:read_internal` (ADR-0021).
- Authorization is deny-by-default and enforced in services; a CI route-coverage test fails the build if
  any controller route lacks both a public marker and a permission assertion (ADR-0019).
- **Ids are not secrets.** UUIDv7 is time-ordered by design; nothing authorizes on unguessability.
