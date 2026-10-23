# Handoff — M13 complete, its open items cleared, M14 next

Written 2026-10-23, after the pass that cleared the M13 boundary's open items. **This file is regenerated, not appended to.** It is rewritten at every milestone boundary, and
whenever enough has landed that the previous version would mislead. If it disagrees with `FEATURES.md` or
an ADR, they are right and this is stale.

Read this first, then `CLAUDE.md`, then the documents it points at.

---

## What Patchgrid is

A **multi-tenant SaaS ITSM platform**: ticketing and operations for IT and security teams. It models four
ITIL record types (Incident, Service Request, Problem, Change), each with its own lifecycle. Priority is
_computed_ from impact × urgency, never typed into a dropdown.

It is a learning and portfolio project, built as though it were production: three deployables, tenants
addressed by subdomain, and tenant data isolated at the database level. **It is not deployed publicly**
(ADR-0047): it runs locally, and the hostnames below are the design, served locally under `lvh.me`.

| Host                   | App        | What it is                                       |
| ---------------------- | ---------- | ------------------------------------------------ |
| `patchgrid.xyz`        | `apps/www` | Landing, pricing, signup                         |
| `<slug>.patchgrid.xyz` | `apps/app` | A tenant's workspace — the product               |
| `app.patchgrid.xyz`    | `apps/app` | Tenant-less: login, picker, create workspace     |
| `admin.patchgrid.xyz`  | `apps/app` | The operators' back-office (ADR-0040)            |
| `api.patchgrid.xyz`    | `apps/api` | NestJS — all business logic and data access      |

Locally: `lvh.me:3000`, `<slug>.lvh.me:3001`, `app.lvh.me:3001`, `admin.lvh.me:3001`, `api.lvh.me:4000`.

---

## Where we are

**M0–M6 and M8–M13 are complete. M14 (production rehearsal, locally) is next**, then M7 last
(ADR-0048). Milestone numbers did not change.

**M13 (Identity): complete 2026-10-23.** Its exit holds: a member signs in with a passkey and uses it
for step-up; a workspace with SSO configured sends its members to their identity provider, and a new
member is provisioned on first sign-in. Passkeys landed as #61; per-tenant SSO, the review and this
handoff as the PR after it. A review closed it (`THREAT-MODEL.md` §10).

What M13 built:

- **Passkeys** (ADR-0053). `UserPasskey`, platform-class beside the TOTP factor: one relying party,
  the root domain, with the origin partitioned by `classifyOrigin` so `admin.` and `www.` never count.
  UV required, discoverable credentials, challenges in Redis under a purpose and spent with `GETDEL`. A
  passkey signs in alone, completes the second step of a password login, and proves a step-up. "Has a
  factor" now means TOTP or a passkey everywhere it is asked, and recovery codes belong to the person's
  factors, not to one kind. Adding one takes a fresh proof, never a recovery code (erratum).
- **The domain proof** (ADR-0054). An owner claims `Organization.domain` and publishes one TXT record,
  `_patchgrid-verify.<domain>`. First verified wins by the partial unique index; free-mail domains are
  refused in the contracts.
- **Per-tenant OIDC** (ADR-0054). `SsoConnection` and `SsoIdentity`, tenant-owned. Authorization code
  with PKCE through `openid-client`, every request to the provider through the guarded fetch webhooks
  use, the ID token's signature checked against its keys. The callback holds the state to the browser's
  `pg_sso` cookie and the address to the proved domain, links an existing member or provisions one at
  the default role (never above agent), and never revives a removed one.
- **The scope of an SSO session.** `RefreshToken.ssoOrgId` and an `sso` claim on the access token: the
  session opens its workspace and no other, satisfies that workspace's `requireMfa`, and every
  tenant-less route refuses it unless it admits it (only "who am I" and "open my workspace"). Step-up is
  at the provider, never for an owner. "SSO required" spares owners, who are the way back in when the
  provider is down. Withdrawing the connection ends what it started.
- **Keycloak** under `docker compose --profile sso`, with an `acme` realm the seed points Acme at; an
  in-process OpenID provider for the integration specs; an SSO scenario in the browser suite, which CI
  runs against Keycloak.

**The open items, cleared (2026-10-23, #63–#70).** Every item the M13 handoff left open was built,
settled or re-filed as out of scope before starting M14:

- **Reliability.** Notification email is at least once, queued with the `notify` cursor (ADR-0049
  erratum). Parked events can be replayed by an admin (`org:manage_events`, Settings → Event
  delivery). A webhook turned off for failing emails the workspace's admins. Raw SQL on tenant tables
  goes through `PrismaService.tx`, and locks on platform rows through `lockTx`; both throw outside a
  transaction. A transaction's statements reach its connection one at a time (`SerialPrismaPg`), which
  removes the `pg` "query while executing" warning.
- **Plans.** A nightly `usage-reconcile` recounts the counters from their rows. A FREE workspace's audit
  log is kept two years. A limit reached tells the admins and owners (`PLAN_LIMIT_REACHED`). API tokens
  are a plan limit. `org:manage_plan` left the catalogue (plans are the back-office's).
- **People.** Keep watching on reassignment; starter knowledge-base articles; per-member capabilities on
  the members page; erasure by a link for accounts with no password (ADR-0044 erratum); joining by
  verified domain (TENANCY §5); external requesters as memberships without an account (ADR-0055).
- **Rules.** Rule 3 can no longer be engineered: an owner self-approves only when they alone can decide,
  and an undecidable change is refused at `submit` (DOMAIN §2.3). Google's `hd` is checked (ADR-0054
  erratum). Comments honour `Idempotency-Key`, keyed to the path. The cookie pairs are pruned to five.
- **Operations.** Exports list files a page at a time; the API image is 778 MB, down from 1.11 GB;
  CoreDNS makes the domain proof walkable; the SLA browser spec moves its deadline instead of waiting;
  the marketing page no longer inlines its stylesheet four times. Prettier formats the whole repository
  (the backend at 140 columns), so commits run the format hook again.

**CI is green on `main`** through #68; #69 (external requesters) and #70 (the format pass) are the
check for the rest.

## Earlier milestones, in brief

- **M12** gave insight: reports from a fact row per ticket refreshed by a consumer of the log and checked
  by a nightly reconcile (ADR-0051), saved views and bulk actions (ADR-0052), §9 of the threat model.
- **M11** gave reliable delivery: the transactional outbox read as a per-tenant log below the snapshot
  horizon (ADR-0049), ticket notifications on it, outbound webhooks as its second consumer (ADR-0050),
  retention, and the event-age dashboard (`THREAT-MODEL.md` §8).
- **M10** shipped without a public deployment (ADR-0047): the demo seed, the marketing site and docs,
  production images and `docker-compose.prod.yml`, `pnpm local:up`, and the README.
- **M9** gave hardening: member MFA with step-up (ADR-0045), the browser suite, OpenTelemetry per tenant
  (ADR-0046), the security review (`THREAT-MODEL.md` §7), OpenAPI and the 100k load check.
- **M8** gave the platform layer: the back-office, support sessions, API tokens, deletion and data
  protection.
- **M6** gave email intake; **M5** attachments, assets and the knowledge base; **M4** the four record
  types; **M3** notifications, the live stream and the per-tenant sweeps.

The detail is in the git history of this file, at those boundaries.

## Tests at the boundary

| Suite | Count |
| --- | --- |
| `apps/api` unit | 1232 |
| `apps/api` integration | 278 |
| `pnpm test:tenancy` | 13 catalog + 38 (3 pointers skipped) |
| `pnpm test:authz` | 410 |
| `packages/database` unit / catalog / integration | 11 / 13 / 24 |
| `packages/contracts` | 228 |
| `apps/app` unit | 69 |
| `apps/www` | 19 |
| `apps/app` browser suite | 12 scenarios (`passkeys` and `sso` are M13's) |

## Decisions made in M13

| Decision | Where |
| --- | --- |
| A passkey is a credential that signs in alone and a factor; one RP across the workspace hosts, the origin partitioned; recovery codes belong to the person | ADR-0053 (errata: as built; the review's settlements) |
| Per-tenant OIDC routed by a DNS-proved domain; a session an IdP starts is scoped to its workspace; owners exempt from "SSO required" and never step up at the IdP | ADR-0054 (erratum: the review's settlements) |
| The identity provider as trust boundary TB12 | `THREAT-MODEL.md` §6, §10 |

## Decisions made clearing the open items

| Decision | Where |
| --- | --- |
| External requesters are memberships of kind `EXTERNAL`, with no account; an `external` actor built by the intake alone | ADR-0055; erratum on ADR-0039 |
| Notification email is queued in the cursor's transaction: at least once | ADR-0049 erratum |
| A disabled webhook emails its admins | ADR-0050 erratum |
| Google's `hd` must name the proved domain | ADR-0054 erratum |
| Erasure by a single-use link to the address | ADR-0044 erratum |
| FREE's two-year audit window is a per-tenant delete; the archival keeps seven | ADR-0028 erratum |
| `db_transactions_per_request` counts the extension's own transactions | ADR-0046 erratum |
| `org:manage_plan` is not a permission | Errata on ADR-0029, ADR-0045 |
| The crossing helpers take a `crossing` | ADR-0022 erratum |

---

## Recommended next steps — M14

`FEATURES.md` §M14, production rehearsal, locally. Its exit: `pnpm local:prod` serves the production
images over HTTPS on `*.patchgrid.test`, through PgBouncer in transaction mode, with reads optionally
served by a replica, and the tenancy suite passes through all of it. In order:

1. **An ADR for the shape**: Caddy in front of `docker-compose.prod.yml` with a locally trusted
   wildcard (mkcert) for `*.patchgrid.test`; what HTTPS changes (`Secure` cookies, HSTS short first,
   passkeys without the Chrome flag, `SSO_ALLOW_PRIVATE_ISSUERS` off against a Keycloak behind Caddy).
2. **PgBouncer in transaction mode** between the API and Postgres. ADR-0015's transaction-local
   `set_config` is exactly what makes this safe; prove it by running `pnpm test:tenancy` through the
   pooler, and look for anything session-scoped (advisory locks are transaction-scoped already; `LISTEN`
   for the outbox is session-scoped and must bypass the pooler).
3. **A streaming replica**, with only reads that tolerate lag routed to it (reports are the candidate),
   and RLS checked on the replica too.
4. **A short runbook**: what a real deployment would still need (ADR-0047's list below).

Then M7, per `FEATURES.md`.

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| Passkeys need a secure context; locally that is Chrome with a flag until M14's HTTPS | M14 | ADR-0053 |
| An external requester who later gets an account keeps two memberships | when asked for | ADR-0055: the external one keeps its tickets; merging them is not built |
| SAML, SCIM and IdP-initiated sign-in | out of scope | ADR-0048; deprovisioning at the provider ends nothing here (R-10) |
| Automation rules have a plan limit and no rows | M7 | `usage-reconcile` leaves their counter alone until M7 gives them rows |

## If it is ever deployed

Dropped by ADR-0047, kept so that reversing it starts from a list rather than from memory. None of it
blocks M7.

| Item | Notes |
| --- | --- |
| Three registered domains: the product, attachments on their own registrable domain, an ops zone | ADR-0026, ADR-0037 |
| Wildcard certificate by DNS-01 through the delegated `_acme-challenge`; CAA; the renewal canary | `DNS.md` §3 |
| SPF, DKIM and DMARC progressed on evidence; MX for `inbound.` | `DNS.md` §4, ADR-0027 |
| SMTP has no credentials or TLS setting | `SMTP_HOST`/`SMTP_PORT` only; every real provider needs both |
| A production inbound adapter | Verify the provider's signature, re-sign in ADR-0039's shape |
| `MFA_ENCRYPTION_KEY`, `WEBHOOK_SECRETS_KEY` and `SSO_SECRETS_KEY` kept apart from the database and its backups | A dump without them yields no second factors, signs no webhooks and authenticates to no identity provider (ADR-0040, ADR-0050, ADR-0054) |
| `SSO_ALLOW_PRIVATE_ISSUERS` off (boot refuses it in production) and `DNS_RESOLVERS` unset or trusted | ADR-0054 |
| `TRUST_PROXY_HOPS` set to the real hop count | Default 1; with a CDN in front it is 2, and a wrong value makes every per-IP limit attacker-chosen (THREAT-MODEL §7) |
| Production storage needs the `staging/` lifecycle rule and the edge headers ADR-0037 names | Local MinIO sets the rule in `docker/minio/init.sh` |
| A public demo needs a demo mode first (an ADR) | The seed shares one password: anyone could sign in as an owner, enrol a factor, request deletion or send invitations |
| Postgres that allows a `BYPASSRLS` migration role and `pgvector` | Many managed services refuse the first; self-hosted needs backups |
| HSTS with a short max-age first, `preload` last | `DNS.md` §3 |
| Ollama and `phishing-svc` sized for a server | M7 sizes them for a laptop |


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
pnpm --filter @patchgrid/app exec playwright install chromium
pnpm dev                         # www :3000, app :3001, api :4000; Mailpit UI :8025
pnpm --filter @patchgrid/app test:e2e                  # the browser suite, against the running stack
docker compose --profile observability up -d           # collector, Tempo, Prometheus, Grafana :3100
docker compose --profile sso up -d                     # Keycloak :8180, Acme's identity provider (ADR-0054)
docker compose --profile dns up -d                     # CoreDNS :5354 for the domain proof; DNS_RESOLVERS=127.0.0.1:5354
pnpm --filter @patchgrid/api run inbound:send -- --from carla@contractor.test --to acme --subject "…" --text "…"
```

To see traces and the tenant dashboard, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in
`.env` and restart `pnpm dev`. The OpenAPI document is at `http://api.lvh.me:4000/api/docs`.

Sign in at `http://app.lvh.me:3001` as `dana@patchgrid.test` to see two workspaces; Dana is also the
seeded operator at `http://admin.lvh.me:3001` (she enrols a TOTP factor on first sign-in). `rita@` is a
requester at Acme and `sam@` an agent. Notification email lands in Mailpit at `http://localhost:8025`;
files are served by MinIO at `http://localhost:9000`, a different site from `lvh.me` on purpose.

With `--profile sso` up, "Sign in with SSO" on the login page takes `kim@acme.test` or `lee@acme.test`
(password `patchgrid-demo`) through Keycloak into Acme, provisioned as requesters on first sign-in.
`nora@acme.test` is unverified at the provider and is refused. Alice (Acme's owner) manages it under
Settings → Single sign-on. Passkeys need a secure context: start Chrome with
`--unsafely-treat-insecure-origin-as-secure=http://app.lvh.me:3001,http://acme.lvh.me:3001` until M14.

To prove a domain locally, claim `globex.test` as Gus under Settings → Single sign-on, add the TXT line the
page shows to `docker/coredns/zones/db.globex.test` (raise the serial, save the file whole), and check
DNS, with the API started with `DNS_RESOLVERS=127.0.0.1:5354`. To see external requesters, turn on
"Take mail from people outside the workspace" under Settings → Workspace and send mail from an
address no member has with `inbound:send`.

Scripting the API with curl, use `api.lvh.me:4000`, not `localhost`. The session cookies are scoped to
`.lvh.me`, so a `localhost` cookie jar stays empty and every call is a `401`.

## Gotchas paid for clearing the open items

- **A dev API is a second worker on the test database.** Its outbox listener drains the specs' events
  and its workers attempt their webhooks; stop it before `test:integration`, every time.
- **Prisma 7 loads an `include`'s relations with `Promise.all`**, which inside an interactive
  transaction overlaps queries on one `pg` client. `SerialPrismaPg` queues them; our own `Promise.all`
  inside a transaction bought nothing either.
- **A test helper that writes a row and its counter apart races `usage-reconcile`** in another spec's
  worker; it upserts. Provisioning writes both in one transaction.
- **A new enum value cannot be used in the migration that adds it**; split it, as `API_TOKENS` and
  `EXTERNAL` are. A failed `migrate deploy` must be marked rolled back before it is rewritten.
- **`pnpm add` can prune a store package another lockfile entry still links** (a dangling `zod` under
  ESLint's React hooks plugin). `pnpm install --force` relinks; it takes a while.
- **CoreDNS drops a zone it reads half-written.** Save zone files whole, as editors do.
- **Prettier now runs on every commit**; the docs are ignored, because the contracts' tests read their
  tables cell by cell.

## Gotchas paid for in M13

- **`openid-client` checks an ID token's signature only when asked** (`enableNonRepudiationChecks`); by
  default it trusts TLS to the token endpoint.
- **`openid-client` hands a custom fetch a `Headers` object**, whatever its type says; spreading one
  copies nothing, and the token request went out without client authentication.
- **RFC 6749 form-encodes both halves of client-secret Basic auth** before base64, so a `-` in a client
  id arrives as `%2D`. A test provider that compares raw strings refuses a correct client.
- **The server render has no `window`.** A dialog that reads the host while closed fails every page that
  offers it; read it only when open.
- **`Sec-Fetch-Site` tells a navigation another site started from one the app made**; the `state`
  cookie cannot, because the victim's own browser holds it.
- **A recovery code ends every session, including the one the next request needs.** Never take one as
  the proof for a two-request flow.
- **Killing `nest start --watch` stops `pnpm --filter … dev` too, and the app dev server can go with
  it.** Check both ports before a browser run; eight connection refusals are not eight bugs.

## Gotchas paid for in M12

- **`FULL JOIN` needs an equality Postgres can hash.** `IS NOT DISTINCT FROM` is refused; join on
  `COALESCE(key, '')`.
- **A void function cannot be read by `$queryRaw`.** `pg_advisory_xact_lock` goes through `$executeRaw`.
- **`crypto.randomUUID()` exists only in secure contexts**, and development is plain http on `lvh.me`.
  `lib/idempotency.ts` builds ids from `getRandomValues`.
- **A component that owns a dialog unmounts with its parent's state.** Clear a selection after its
  results are read, not when they arrive.
- **The React compiler's lint refuses `setState` in an effect.** Derive what can be derived during render.
- **A base64url secret can contain `_`.** Split a token by its pattern, never by the separator; it failed
  one run in eight, twice, in two specs.
- **commitlint wants a lowercase subject** (`SLA` fails). Chain a push after `&&`, never `;`, or a
  rejected commit still pushes a partial series.

## Gotchas paid for in M11

- **Ids are assigned at insert, rows appear at commit.** An id-ordered cursor skips an event whose
  transaction commits after a later one's; read in transaction-id order below `pg_snapshot_xmin`.
- **A transaction that writes holds an id, and its own id is a horizon.** Take the drain's lock with an
  advisory lock (no id) and read before writing.
- **BullMQ deduplicates a job id until the job completes**, which drops exactly the wake that arrives
  mid-drain. Clear a pending flag when the work starts, not when it ends.
- **Raw SQL outside a transaction runs with no tenant and RLS answers "nothing"**, not an error. Use
  `PrismaService.tx`.
- **`pg_advisory_xact_lock` returns `void`**, which `$queryRaw` cannot decode; use `$executeRaw`.
- **A dev API is a second worker on the same database.** Its listener drains test events. `nest start
  --watch` respawns a killed server: stop the `pnpm … dev` process.
- **gitleaks fingerprints carry the commit SHA**, and a rebase-merge rewrites it. Use values no scanner
  flags (the webhook dev key is all zero bytes) or `// gitleaks:allow` on a public test vector.
- **CI's integration job does not read `.env.example`.** A spec that needs a non-default setting sets
  `process.env` itself.
- **A delayed job's id is a promise to BullMQ**: a failed job with the same id is kept and silently blocks
  a later add. Name jobs by what they are for (the scheduled time) and do not keep failed ones.

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
