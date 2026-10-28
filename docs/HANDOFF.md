# Handoff — M14 complete: every planned milestone is done

Written 2026-10-26, at the M14 boundary. **This file is regenerated, not appended to.** It is rewritten at
every milestone boundary, and whenever enough has landed that the previous version would mislead. If it
disagrees with `FEATURES.md` or an ADR, they are right and this is stale.

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

**M0–M6 and M8–M14 are complete. There is no next planned milestone.** M7, the models and the automation
rule engine, is dropped (ADR-0056). Milestone numbers did not change.

**M14 (production rehearsal on emulated AWS): complete 2026-10-26.** Its exit holds, on a laptop and in
CI from nothing: the production images, pushed to ECR, run as ECS services behind an HTTPS ALB on
`*.patchgrid.test`; migrations run first as a one-off task; the database's roles are ones RDS itself could
create; the tenancy suite passes inside the VPC through PgBouncer, and the browser suite passes through
the ALB, passkeys included. A review closed it (`THREAT-MODEL.md` §11, TB13).

What M14 built:

- **RDS-compatible roles** (ADR-0059, #80). The bootstrap runs as a `CREATEROLE`/`CREATEDB` admin, never
  a superuser, in Compose and CI too. The owner holds no `BYPASSRLS`: ownership is what exempts it from
  the policies, and `FORCE` is gone. The app role is asserted to be no member of the owner.
- **The application ready for AWS** (#81). S3 and SES clients take the SDK's default credential chain
  and an endpoint override; SES is a second `MailProvider`; the outbox wake's `LISTEN` has its own URL,
  so it reaches the database past a transaction-mode pooler; HSTS at its first stage whenever served
  over https; the API boots without the owner's credentials.
- **The infrastructure** (`infra/`, #84). Modules written for real AWS: network (three tiers, a security
  group per role), secrets (KMS, Secrets Manager), data (RDS 17 with `force_ssl`, ElastiCache with TLS
  and an AUTH token, S3 with a TLS-only policy), registry (immutable tags, scan on push), edge (ALB with
  TLS 1.3/1.2, ACM wildcard, public and private Route 53 zones), mail (SES with DKIM, SPF, DMARC), cluster
  (ECS, Cloud Map, per-need task roles), ecs-service. Four roots per environment, split by lifetime:
  `bootstrap`, `platform`, `jobs`, `services` (ADR-0058 erratum).
- **One command** (`scripts/aws.mjs`). `pnpm aws:up | deploy | run <job> | status | e2e | down`. A deploy
  builds the production images once per commit, adds the environment's CA as one layer, pushes, runs
  `provision` and `migrate` as tasks, rolls the services and waits until they have settled: one
  deployment each, every task running, exactly that many healthy targets.
- **Verification** (#85). `aws:run verify` runs the tenancy suite as an ECS task with the worker out of
  service (it must be the only consumer of its outbox). `aws:e2e` runs the browser suite through the ALB
  with nothing changed on the machine: Chromium and the suite resolve the root domain to the ALB and
  trust Floci's CA by its key hash. `.github/workflows/aws.yml` does `aws:up`, `verify` and `aws:e2e` from
  nothing on `main` and on infrastructure PRs. `docker-compose.prod.yml` is retired (#86).
- **The runbook** (`infra/README.md`): the commands, the browser setup, every place Floci differs from
  AWS and what covers it, and what a real account still needs.

**Where Floci differs, and what covers it** (the detail is in the runbook and ADR-0058's errata):

| Gap | Covered by |
| --- | --- |
| No `X-Forwarded-For` / `-Proto` | The app falls back to its configured protocol; the browser suite rolls the rate limits off for its run |
| A stopped task's target stays registered | Each rollout deregisters targets that are not a running task |
| The private-zone wildcard matches only a literal `*` | `api.`, `app.`, `admin.` have their own records |
| No TLS on the cache proxy | The local root turns cache TLS and its token off; on by default |
| RDS parameters stored, not applied | Recorded; RDS applies them |
| The RDS master is a superuser | The provisioning never relies on it (ADR-0059) |

**CI is green on `main`.** The AWS rehearsal takes most of an hour, so it runs on `main` and on pull
requests that touch the infrastructure, not on every PR.

## Earlier milestones, in brief

- **M13** gave identity: passkeys that sign in alone and prove a step-up (ADR-0053), per-tenant OIDC
  routed by a DNS-proved domain with sessions scoped to their workspace (ADR-0054), and Keycloak under
  `--profile sso`. The open items after it were cleared in #63–#70 (external requesters, ADR-0055).
- **M12** gave insight: reports from a fact row per ticket refreshed by a consumer of the log and checked
  by a nightly reconcile (ADR-0051), saved views and bulk actions (ADR-0052).
- **M11** gave reliable delivery: the transactional outbox read as a per-tenant log below the snapshot
  horizon (ADR-0049), ticket notifications on it, outbound webhooks as its second consumer (ADR-0050).
- **M10** shipped without a public deployment (ADR-0047): the demo seed, the marketing site and docs,
  production images, `pnpm local:up`, and the README.
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
| `apps/api` integration | 278 (1 skipped) |
| `pnpm test:tenancy` | 14 catalog + 38 (3 pointers skipped) |
| `pnpm test:authz` | 402 |
| `packages/database` unit / integration | 11 / 26 |
| `packages/contracts` | 226 |
| `apps/app` unit | 69 |
| `apps/www` | 19 |
| `apps/app` browser suite | 12 scenarios on the development stack; 9 through the ALB (`sso` stays on the development stack) |
| `pnpm aws:run verify` | the 38 above, as an ECS task through PgBouncer |

## Decisions made in M14

| Decision | Where |
| --- | --- |
| M14 is a production rehearsal on Floci, provisioned by OpenTofu in plain HCL; the infrastructure is written for real AWS | ADR-0058 |
| Four roots per environment, split by lifetime | ADR-0058 erratum |
| The forwarded protocol decides the app's links; the app falls back to its configured one | ADR-0058 erratum |
| Database roles RDS could create: no superuser, no `BYPASSRLS`, no `FORCE` | ADR-0059 |
| The cache takes TLS and an AUTH token by default; its URL is a secret | `THREAT-MODEL.md` §11 |
| The deployment as trust boundary TB13: the Docker socket, the state, secrets by reference | `THREAT-MODEL.md` §3, §11 |

---

## Recommended next steps

Every planned milestone is done. What remains is a list to choose from, not a plan; any of it is a real
decision and wants an ADR first.

- **SSO through the ALB.** The browser suite's SSO spec needs an identity provider a task can reach and
  that production accepts: Keycloak as an ECS service behind the ALB with the environment's CA.
- **Floci upstream.** Three gaps are bugs worth reporting with a reproduction: the wildcard record, the
  stopped task's target, the parameter group read-back.
- **Move off the nightly.** Floci is pinned to `nightly-10222026` for ALB TLS termination; pin the first
  release that carries it.

## Still open

| Item | Needed by | Notes |
| --- | --- | --- |
| SAML, SCIM and IdP-initiated sign-in | out of scope | ADR-0048; deprovisioning at the provider ends nothing here (R-10) |
| Per-IP rate limits are not exercised on Floci | a real account | The runbook names the `X-Forwarded-For` check |

## If it is ever deployed

Dropped by ADR-0047, kept so that reversing it starts from a list rather than from memory. `infra/` now
covers most of the shape; `infra/README.md` §"What a real account still needs" is the account-side list.

| Item | Notes |
| --- | --- |
| Three registered domains: the product, attachments on their own registrable domain, an ops zone | ADR-0026, ADR-0037 |
| A public hosted zone, the ACM certificate validated through it; CAA | `DNS.md` §3; the edge module validates by DNS already |
| SES out of the sandbox; DMARC progressed on evidence; MX for `inbound.` | `DNS.md` §4, ADR-0027; the mail module publishes DKIM, SPF and DMARC |
| A production inbound adapter | Verify the provider's signature, re-sign in ADR-0039's shape |
| `MFA_ENCRYPTION_KEY`, `WEBHOOK_SECRETS_KEY` and `SSO_SECRETS_KEY` kept apart from the database and its backups | In Secrets Manager under KMS; keep them out of the database's backup path (ADR-0040, ADR-0050, ADR-0054) |
| The state bucket read only by the deploying role, under its own KMS key; CI by OIDC, no static keys | TB13 |
| `TRUST_PROXY_HOPS` set to the real hop count, and `X-Forwarded-For` confirmed at the API | Default 1 (the ALB); a CDN in front makes it 2 (THREAT-MODEL §7) |
| RDS backups, Multi-AZ and deletion protection on | The local root turns deletion protection off |
| A public demo needs a demo mode first (an ADR) | The seed shares one password: anyone could sign in as an owner |
| HSTS with a short max-age first, `preload` last | `DNS.md` §3 |

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
pnpm aws:up && pnpm aws:run verify && pnpm aws:e2e     # the production rehearsal on Floci (infra/README.md)
pnpm aws:down
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
Settings → Single sign-on. Passkeys need a secure context: on plain-http `lvh.me`, start Chrome with
`--unsafely-treat-insecure-origin-as-secure=http://app.lvh.me:3001,http://acme.lvh.me:3001`, or use the
AWS rehearsal, which is https.

To prove a domain locally, claim `globex.test` as Gus under Settings → Single sign-on, add the TXT line the
page shows to `docker/coredns/zones/db.globex.test` (raise the serial, save the file whole), and check
DNS, with the API started with `DNS_RESOLVERS=127.0.0.1:5354`. To see external requesters, turn on
"Take mail from people outside the workspace" under Settings → Workspace and send mail from an
address no member has with `inbound:send`.

Scripting the API with curl, use `api.lvh.me:4000`, not `localhost`. The session cookies are scoped to
`.lvh.me`, so a `localhost` cookie jar stays empty and every call is a `401`.

## Gotchas paid for in M14

- **HashiCorp is geo-blocked here** (`x-amzn-waf-reason: geo`): the CLI is OpenTofu, the registry
  `registry.opentofu.org`. The code stays plain HCL.
- **A full image build takes about 10 GB.** Check `df` first; `docker builder prune` after. The first one
  filled the disk and Docker's VM stopped booting.
- **gitleaks in CI scans every pushed branch, not only the PR's.** A false positive on another branch
  fails every PR; mark it inline (`# gitleaks:allow`) and rewrite that branch. A rerun keeps the old merge
  SHA, so rebase a PR onto a fixed `main` instead of rerunning it.
- **`merge()` keeps the last key.** Two secrets maps that both had `app` lost the API's keys silently.
- **`COPY --chmod` applies to the directories it creates.** A 0444 `/etc/ssl` left Node unable to open
  `openssl.cnf`, exit 13. Copy into a directory that exists.
- **Healthy is not settled.** Mid-rollout the old tasks are healthy too, and still serving the old
  settings. Wait for one deployment, running = desired, and exactly that many targets.
- **A live worker on the same database drains a suite's outbox.** The same rule as a dev API beside
  `test:integration`, now in an ECS service.
- **Playwright's `request` resolves through Node, not Chromium**, and through `dns.promises.lookup` per
  family; `--host-resolver-rules` does nothing for it.
- **WebAuthn refuses a page with a certificate error**, so `ignoreHTTPSErrors` is not enough for
  passkeys; trust the CA (`--ignore-certificate-errors-spki-list`).
- **AWS takes an ElastiCache AUTH token only with TLS.** Floci accepts it without; the AWS rule decides.

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

Older gotchas are in the previous handoffs in git history, and in the module headers where they bite.
