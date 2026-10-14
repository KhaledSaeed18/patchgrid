# Handoff — M6 complete, M8 next

Written 2026-10-15, at the M6 boundary, after the roadmap was re-ordered. **This file is regenerated, not appended to.** It is rewritten at every milestone boundary, and
whenever enough has landed that the previous version would mislead. If it disagrees with `FEATURES.md` or
an ADR, they are right and this is stale.

Read this first, then `CLAUDE.md`, then the documents it points at.

---

## What Patchgrid is

A **multi-tenant SaaS ITSM platform**: ticketing and operations for IT and security teams. It models four
ITIL record types (Incident, Service Request, Problem, Change), each with its own lifecycle. Priority is
_computed_ from impact × urgency, never typed into a dropdown.

It is a learning and portfolio project, built as though it were production: three deployables, tenants
addressed by subdomain, and tenant data isolated at the database level.

| Host                   | App        | What it is                                       |
| ---------------------- | ---------- | ------------------------------------------------ |
| `patchgrid.xyz`        | `apps/www` | Landing, pricing, signup                         |
| `<slug>.patchgrid.xyz` | `apps/app` | A tenant's workspace — the product               |
| `app.patchgrid.xyz`    | `apps/app` | Tenant-less: login, picker, create workspace     |
| `api.patchgrid.xyz`    | `apps/api` | NestJS — all business logic and data access      |

Locally: `lvh.me:3000`, `<slug>.lvh.me:3001`, `app.lvh.me:3001`, `api.lvh.me:4000`.

---

## Where we are

**M0** (Foundation): complete 2026-09-22. **M1** (Tenancy and identity) and **M2** (Incident lifecycle):
complete 2026-10-09. **M3** (Time and attention) and **M4** (Four record types): complete 2026-10-14.
**M5** (Context: assets, knowledge, attachments): complete 2026-10-15.

**M6 (Email intake): complete 2026-10-15.** Every item is checked. The exit criterion was walked with
the dev harness against the running stack and in headless Chromium, before and after the review's fixes:

- Rita's mail became an incident badged "Email", with its attached file.
- Her reply to the confirmation email threaded onto that incident, with the quoted text cut.
- A forged message (DMARC fail) and a stranger's were recorded, and nothing else happened.
- An admin's Settings → Inbound email shows each message, its verdict and what became of it.

**The build order changed on 2026-10-15: M0–M6, then M8 → M9 → M10, and M7 last.** M7 is the one
milestone that needs local models: Ollama, embeddings, the phishing service. So the platform layer,
hardening and shipping come first, and M7 lands on a running system. The milestone numbers did not
change: ADRs, the threat model and code comments cite them, so renumbering would have made them wrong.
`FEATURES.md` lists M7 last.

Three items moved into M7 with it: the prompt-injection review (from M9), and the `phishing-svc`
Dockerfile and Ollama deployment (from M10). ADR-0010 has an erratum. **Next is M8.**

**CI is green on `main`.** The secret scan needed the inbound webhook's public dev secret listed as a
reviewed false positive (`.gitleaksignore`).

The decisions taken before M6 started:
- the provider-neutral feed (ADR-0039);
- external requesters deferred;
- stop after M6.

---

## What M6 built — ADR-0027, ADR-0039

### The webhook — `apps/api/src/inbound/`

- **`POST /api/v1/inbound/email`** is `@Public` and `@SignedWebhook`. Its credential is a Standard
  Webhooks HMAC over the raw bytes. `main.ts` mounts `inboundBodyParser()` ahead of Nest's JSON parser
  so the bytes stay raw, and any spec that boots the app must do the same.
- **The body** is `{ type: "email.received", data: { recipients, raw } }`: the envelope recipients, and
  the base64 RFC 5322 message (25 MB at most).
- **Each recipient `<slug>@inbound.<root>`** (with or without `+tag`) resolves like a host: the exact
  slug, then a retired one inside its window, active orgs only. The answer is `202` whatever it
  resolved to.
- **Caps**: 500 messages a workspace an hour, in Redis, before anything is stored. The raw message goes
  to `org/<orgId>/inbound/<delivery>.eml`, then an `inbound-email` job carries it.

### The pipeline — `InboundIntakeService`, per tenant

1. Parse with mailparser. The text is cleaned of NUL, control characters and broken surrogates.
2. The verdict: exactly one `From:` header holding exactly one mailbox. Then the topmost
   `Authentication-Results` carrying `INBOUND_AUTHSERV_ID`, with DMARC `pass` aligned to that address's
   domain.
3. Record or find the row, keyed `(orgId, messageKey)`. A passing delivery takes over a row nothing was
   made of, so a forged copy cannot shadow the real message.
4. Claim the row (`processedAt`), so two deliveries of one message cannot both act on it.
5. Refuse, in this order:
   - not PASS → `UNAUTHENTICATED`, with no reply (no backscatter);
   - automatic mail → `AUTO_REPLY`;
   - more than 20 authenticated messages from this sender this hour → `RATE_LIMITED`;
   - workspace no longer active → `FAILED`;
   - no active human member at that address → `UNKNOWN_SENDER`.
6. Act as that member, through `TicketsService.createAs` or `CommentsService.addAs`:
   - A reply threads when it names the ticket — our Message-ID in `In-Reply-To`/`References`, or
     `[INC-…]` — and the sender may reply there. It becomes a public comment with the quote cut.
   - Otherwise it becomes a new Incident, `source: EMAIL`, linked `RELATES_TO` the ticket it named.
   - The row is marked `CREATED` or `THREADED` **inside** that transaction, so a retry never makes a
     second ticket.
7. Files go through `AttachmentsService.ingest`: the same allow-list, sniffing, size cap and quota,
   written straight to the final key. A refused file is listed on the row, never fatal.

**`inbound-sweep`** runs hourly per tenant. It fails a message claimed more than 10 minutes ago, or
never claimed within an hour. It deletes raw messages after 30 days. It drops the rows of mail nothing
was made of after 90.

### Outbound, so replies can thread — `apps/api/src/mail/`

Every message is `Auto-Submitted: auto-generated`. Ticket notifications also carry:
- `Reply-To` set to the inbound address;
- `Message-ID <t.<ticketId>.<uuid>@inbound.<root>>`;
- `References` with one thread root per ticket;
- the number bracketed where the headline says it (`We've received [INC-000042]: …`);
- a "Reply above this line" marker.

### Elsewhere

- The admin log is `GET /org/inbound-emails` (`org:read_audit`), Settings → Inbound email.
- The workspace settings show the inbound address.
- Ticket summaries carry `source`, and an email-raised ticket shows an "Email" badge.
- Role mailboxes (`postmaster`, `abuse`, `hostmaster`, `webmaster`, `administrator`, `mailer-daemon`,
  `noreply`, `no-reply`) are reserved slugs.
- **Dev harness**: `pnpm --filter @patchgrid/api run inbound:send -- --from rita@patchgrid.test --to acme
  [--dmarc fail] [--in-reply-to "<t.…>"] [--attach file] [--header "Auto-Submitted: auto-replied"]`. It
  shares `test/support/inbound-mail.ts` with the specs.
- **Seed**: four of each requester's incidents arrived by email, plus a threaded reply, a forged CEO, a
  stranger and an out-of-office in the log.

### Tests at the boundary

| Suite | Count |
| --- | --- |
| `apps/api` unit | 920 |
| `apps/api` integration | 154 |
| `pnpm test:tenancy` | 13 catalog + 32 (3 pointers) |
| `pnpm test:authz` | 380 |
| `packages/database` unit / catalog / integration | 8 / 13 / 23 |
| `packages/contracts` | 182 |
| `apps/app` | 53 |

Browser walkthroughs live in the git-ignored `apps/app/node_modules/.cache/shots/` (`inbound.mjs`,
`kb.mjs`, `assets.mjs`, `files.mjs`, `m4.mjs`), run with `node` from `apps/app` against `pnpm dev`.
`solo.mjs` creates a `solo-*` workspace owned by a demo user each run; remove it before
`db:seed --reset`, which otherwise fails on `UserOrgIndex_userId_fkey`.

---

## Earlier milestones, in brief

- **M5** gave:
  - attachments through staging and byte sniffing on their own domain (ADR-0037, ADR-0038);
  - the asset register and its ticket history (the `all` view);
  - the knowledge base with its one readable filter.
- **M4** gave:
  - transition tables as data;
  - change approval (rules 1–3);
  - versioned detail fields;
  - links stored once and read from both ends.
- **M3** gave notifications (one `mayRead`), the live stream and the per-tenant sweeps.

The detail is in the git history of this file, at those boundaries.

## Decisions made in M6

| Decision | Where |
| --- | --- |
| Inbound mail is signed raw MIME (Standard Webhooks); the verdict is our receiver's `Authentication-Results`; a provider is an adapter in front | ADR-0039 |
| An authenticated sender acts through explicit-actor entry points (`createAs`, `addAs`) — no context writing, no "act as" helper | ADR-0039 |
| External requesters are deferred; unknown senders are always dropped and recorded | ADR-0039 |
| One `From:` and one mailbox, or no verdict | `InboundIntakeService`, review fix |
| Rate limits count only authenticated mail; a workspace cap runs before storage | review fixes |
| Acting is recorded in the create's own transaction; what follows is best effort | `createAs`/`addAs` `within` |
| Email never writes an internal note; a sender who may not reply gets a related ticket of their own | DOMAIN.md §7.1 |
| A signed webhook is exempt from the CSRF header; it carries no cookie | `@SignedWebhook`, `RequestedWithGuard` |
| Raw mail is kept 30 days; the log of unacted mail 90 | `inbound-sweep` |

---

## Recommended next steps — M8

`FEATURES.md` §M8, the platform layer. Its exit: an operator can run the platform without being able to
read anyone's mail; an owner can grant a time-boxed read-only support session and see exactly what was
looked at; a monitoring system can raise incidents through a scoped token. In order:

1. **Resolve TM-2 first** (`THREAT-MODEL.md`). The platform actor is "resolved from the host" in
   `RBAC.md` §2, which is the inversion ADR-0024 fixed for tenants: `api.patchgrid.xyz` never sees
   `admin.` in its `Host`. Decide the platform credential in an ADR before any back-office code: its own
   cookie and token audience, and how `admin.` reaches the API.
2. **Platform admins and the back-office** (`admin.patchgrid.xyz`, `RBAC.md` §8). Admins are created by
   CLI only. The back-office lists orgs and can suspend, unsuspend, set a plan, and request or restore
   deletion. It shows metadata only, never tenant content. Suspension must bump every member's
   revocation epoch (Still open).
3. **Consent-based support access** (ADR-0020):
   - an owner grants a read-only session, time-boxed;
   - one `SUPPORT_READ` audit row per request, in the tenant's own log;
   - an in-app banner;
   - owner email on grant, first use and expiry;
   - revocation through the epoch;
   - reads through `runAsTenant`, so RLS keeps enforcing.
4. **Scoped API tokens** (ADR-0021):
   - `ApiToken` beside the existing `ApiTokenIndex`;
   - the bearer path `AuthGuard` already stubs;
   - `SCOPE_GRANTS` is already in contracts and honoured by `PermissionService`;
   - once-only secret display, per-token rate limits, `lastUsedAt`;
   - `source: API` and `actorKind: SERVICE` attribution.
5. **Org deletion**: an owner's request, a 30-day soft window, then a hard purge under `runAsTenant`,
   object storage included (attachments, inbound mail). The slug stays reserved for good.
6. **Data protection** (ADR-0028): `GET /org/export` as an async owner-only job, pseudonymised user
   erasure, and retention per entity (inbound mail's 30/90 days are the first).

---

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| **External requesters** (`allowExternalRequesters`) | when asked for | Deferred by ADR-0039: needs a requester who is not a membership |
| **A production inbound adapter** | deploy | Verify the provider's signature, re-sign in ADR-0039's shape; the receiving MTA must add `Authentication-Results` with a stable authserv-id |
| **TM-2** platform actor resolved from the host | M8 | Same inversion ADR-0024 fixed for tenants |
| Plan-limit-reached notification (`DOMAIN.md` §8) | M8 | Needs its own event, a `NotificationType`, and a dedupe key per metric and period |
| Org suspension must bump every member's revocation epoch | M8 | Until then a running stream outlives a suspension by at most one token (≤ 15 min) |
| A usage-counter reconcile | M8 | Nothing recomputes `KB_ARTICLES` or `STORAGE_BYTES` after a bug |
| Production storage needs the `staging/` lifecycle rule and the edge headers ADR-0037 names | deploy | Local MinIO sets the rule in `docker/minio/init.sh` |
| The webhook is under the global throttler | deploy | A provider delivering a burst from one IP may be throttled; give the route its own limit or exempt it |
| CLAUDE.md says no raw SQL outside `packages/database`, but the lint allows `src/**/repositories/**` | docs | Align the rule with the lint |
| Requester receipt can repeat if a notify job stalls after commit | any time | Email-only, so there is no row to fold against |
| `ProjectionRepository` duplicates part of `UserOrgIndexRepository` | any time | Merge them |
| `pg` "client.query() while executing" deprecation warning in integration runs | any time | Present since M2 |
| Rule 3 can be engineered: an owner may assign their change to the only other admin | spec decision | What DOMAIN.md §2.3 says today |
| The owner's approval inbox omits changes only they could approve (rule 3) | UX | They see them on the ticket |
| Per-member capabilities in the admin UI | any time | Member actions are offered by role |
| `next-themes` inline-script warning under React 19 | any time | Dev-only |
| Doc formatting drift | any time | Docs and API code are not Prettier-clean at 80 cols; commits skip the format hook |

## Running it

```bash
cp .env.example .env
pnpm install
docker compose up -d && docker compose up minio-init
pnpm db:bootstrap && pnpm db:migrate && pnpm db:generate
pnpm db:doctor                   # 6/6
pnpm db:seed                     # acme + globex: tickets of every type, assets, articles, inbound mail; password "patchgrid-demo"
pnpm test:schema
pnpm test:tenancy
pnpm test:authz
pnpm --filter @patchgrid/api run test:integration      # on Redis db 1, beside a dev API
pnpm --filter @patchgrid/database run test:integration
pnpm dev                         # www :3000, app :3001, api :4000; Mailpit UI :8025
```

Sign in at `http://app.lvh.me:3001` as `dana@patchgrid.test` to see two workspaces. `rita@` is a
requester at Acme and `sam@` an agent. Notification email lands in Mailpit at `http://localhost:8025`;
files are served by MinIO at `http://localhost:9000`, a different site from `lvh.me` on purpose.

Scripting the API with curl, use `api.lvh.me:4000`, not `localhost`. The session cookies are scoped to
`.lvh.me`, so a `localhost` cookie jar stays empty and every call is a `401`.

## Gotchas paid for in M6

- **A signature is over bytes.** Mount the raw body parser for the webhook path before Nest's JSON
  parser. In specs, send the signed body as a string: supertest JSON-encodes a `Buffer` when the content
  type is JSON, and the signature then fails.
- **mailparser takes the last of two `From:` headers**, and returns `In-Reply-To` with several ids as
  one string. Count the header lines; split on whitespace.
- **Postgres `text` refuses NUL.** An encoded-word in a subject decodes to one, and the insert fails
  every attempt.
- **Anything a sender chooses can be pre-claimed by a forger.** The Message-ID, the From address: key
  limits and duplicates on authenticated facts.
- **A retry after the commit repeats the commit's work.** Record "done" inside the transaction that does
  it, and make everything after it best effort.
- **gitleaks scans history.** A high-entropy dev fixture needs a reviewed fingerprint in
  `.gitleaksignore` with a reason.

## Gotchas paid for in M5

- **A raw query outside `prisma.transaction` has no tenant.** The extension sets
  `app.current_org_id` only for model calls and transactions, so a bare `$queryRaw` under RLS returns
  nothing — the knowledge search came back empty until it was wrapped.
- **A presigned PUT is reusable until it expires.** Anything decided about "the uploaded object" must be
  about a copy the URL cannot reach (ADR-0038).
- **react-markdown hands every custom component a `node` prop.** Spreading props onto a DOM element
  passes it through; take `children` (and `href`, `alt`) only.
- **A static route shadows a dynamic one.** `/knowledge/new` would hide an article slugged `new`, so
  those slugs are reserved.
- **CI's service containers cannot run MinIO** (no `command`); the integration job starts the compose
  file's instead.

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
