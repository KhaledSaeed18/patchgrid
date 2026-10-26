# 0058 — M14 is a production rehearsal on emulated AWS: Floci, provisioned by OpenTofu

- **Status:** Accepted
- **Date:** 2026-10-24
- **Amends:** [0047](0047-no-public-deployment.md), [0048](0048-roadmap-after-m10.md) (M14's content)

> **Erratum (2026-10-26).** "One root module per environment" in `infra/envs/local` became four roots
> per environment, split by lifetime, in `infra/live/local`: `bootstrap` (the state backend), `platform`,
> `jobs` and `services`. A deploy applies only the last two with the new image tag. See `infra/README.md`.

## Context

ADR-0047 keeps Patchgrid off the internet: no domain, no server, no bill. ADR-0048 planned M14 as a
production rehearsal on a laptop: Caddy with mkcert certificates, PgBouncer in transaction mode, and a
streaming replica. That proves TLS and pooling, but it rehearses a production nobody would run. A real
deployment of this system is a container platform behind a load balancer, with a managed database, a
managed Redis, object storage, a mail service, a secrets store and infrastructure as code. None of that
appears in a Caddyfile.

[Floci](https://floci.io/floci/) is an MIT-licensed AWS emulator. It serves AWS's APIs on one local
port, and much of it is backed by real containers rather than stored configuration. A spike on
2026-10-24 (Floci `nightly-10222026`) checked the path this system needs, end to end:

| Checked | Result |
|---|---|
| ECR: `docker push`, and ECS pulling from it | A real `registry:2` behind the ECR API |
| ECS services on `awsvpc`: desired count, rolling replacement, recovery after a Floci restart | Real containers |
| ALB: HTTPS on 443 with an ACM certificate, SNI, `host-header` rules, an 80 → 443 redirect, round robin across tasks | Real proxy. TLS termination arrived after 2.3.0 (floci#5959), hence the pinned nightly |
| ACM: a certificate for `patchgrid.test` and `*.patchgrid.test` | Issued at once, chained to Floci's local CA |
| Route 53 private zone: `*.patchgrid.test` resolved from inside a task | Floci is the tasks' DNS upstream |
| Secrets Manager and SSM injected into a task's environment (including a JSON key), `awslogs` to CloudWatch | Real |
| RDS PostgreSQL 17, ElastiCache Redis | Real containers behind TCP proxies |

It also found where Floci differs from AWS, and each difference has a decision below:

1. **The ALB rewrites `Host` to the target's address** unless `routing.http.preserve_host_header.enabled`
   is set. That is AWS's own attribute, so setting it is correct on both.
2. **The ALB adds no `X-Forwarded-For`, `-Proto` or `-Port`.** The attributes are stored and never
   applied.
3. **The RDS master user is a superuser.** On AWS it is not, and AWS's `rds_superuser` cannot grant
   `BYPASSRLS`. Our migration owner holds exactly that attribute (ADR-0015's erratum), so the role model
   as built cannot exist on RDS, and Floci would hide it.
4. **RDS read replicas are a `pg_dumpall` copy**, not streaming replication, and **RDS Proxy has no data
   plane**.
5. **Route 53 public zones answer only TXT, NS and SOA.** Private zones answer A records.

One more constraint, outside Floci: HashiCorp geo-blocks this network. `releases.hashicorp.com` and
`registry.terraform.io` answer `404` with `x-amzn-waf-reason: geo`, so neither the Terraform CLI nor its
provider registry can be reached. The OpenTofu registry can.

## Options considered

1. **The M14 of ADR-0048: Caddy, mkcert, PgBouncer and a replica in Compose.** Small, and it proves TLS
   and pooling. It teaches nothing about how this would actually be operated, and the replica has no
   workload: every report is far inside its budget (`ENGINEERING.md`, reports).
2. **The same system on emulated AWS, provisioned as code.** ECR, ECS, ALB, ACM, Route 53, RDS,
   ElastiCache, S3, SES, Secrets Manager, KMS and CloudWatch, created by Terraform-language code. It
   teaches the deployment as it would really be done, and the emulator's gaps become things to find,
   name and design around, which is the point.
3. **Option 2, and also rebuild the application around AWS-native services**: SQS for BullMQ, Lambda for
   sweeps, Cognito for auth, DynamoDB for counters. Each swap replaces tested architecture with
   provider-shaped code, and none answers a problem the system has.

## Decision

**Option 2.** M14 deploys Patchgrid to Floci with OpenTofu, and the rehearsal is run, not described.

- **OpenTofu, in plain HCL that Terraform also accepts.** The geo-block decides the CLI; the language
  stays Terraform's. No OpenTofu-only feature is used, so the same code plans under either.
- **AWS where a real deployment of this system would use it, and nowhere else.** The application keeps
  BullMQ, its own auth, its outbox and its jobs. It changes only where AWS changes what it talks to:
  - mail can go through SES as a second `MailProvider`
  - S3 credentials can come from the task role instead of static keys
- **The infrastructure is written for real AWS, with the endpoints overridden.** One root module per
  environment. `infra/envs/local` points the provider at Floci. Nothing in the modules knows it is
  emulated, so `plan` against a real account is meaningful.
- **Every Floci gap is closed in the design, never by trusting the emulator:**
  1. The ALB sets `preserve_host_header`.
  2. The missing forwarded headers matter only for the client address. Locally every client is the
     loopback, so per-IP limits are not tested here, and the runbook names the setting to check on AWS.
     The application already serves only HTTPS behind an HTTPS-only listener, so `X-Forwarded-Proto`
     decides nothing.
  3. The database is bootstrapped as a role with RDS's privileges and no more: `CREATEROLE` and
     `CREATEDB`, never `SUPERUSER`, in Compose and CI too. The migration owner stops needing `BYPASSRLS`
     ([0059](0059-rds-compatible-database-roles.md)).
  4. The replica is dropped: there is no lag to learn from a copy, and no workload that needs one.
     PgBouncer runs as its own ECS service in transaction mode, since RDS Proxy pools nothing here. The
     outbox's `LISTEN` connection, which is session-scoped, goes to the database directly.
  5. Workspace hosts resolve inside the VPC through a private zone. A browser on the laptop reaches the
     ALB on 127.0.0.1 through a one-line resolver rule (or Chromium's `--host-resolver-rules` in the
     browser suite).
- **Floci is pinned by digest**, to a nightly until a release carries ALB TLS termination, then to that
  release.
- **The deployment is one command and repeatable:**
  - build
  - push to ECR
  - `tofu apply`
  - migrations as a one-off ECS task before services roll
  - wait for every target to turn healthy
- **The repository keeps one production definition.** Once ECS runs the stack, `docker-compose.prod.yml`
  is retired, and CI's stack check deploys to Floci instead.

## Consequences

- M14's exit changes. The production images run on ECS behind an HTTPS ALB on `*.patchgrid.test`,
  through PgBouncer, on a database whose roles RDS could create, and the tenancy suite passes against
  it. The replica is gone from the plan, and passkeys work without the Chrome flag once Floci's CA is
  trusted.
- New, learnable surface: VPC and security groups, task and execution roles, KMS-encrypted secrets, ALB
  health checks and deregistration, rolling deploys with migrations first, CloudWatch log groups, remote
  state with locking.
- The local stack grows by one container (Floci), plus what it starts. The development loop is unchanged:
  `pnpm dev` and Compose remain the way to work, and the AWS stack is a separate, explicit rehearsal.
- Floci mounts the Docker socket, which is root on the host. That is acceptable for a local tool and
  recorded in the threat model.
- Where Floci is wrong, its behaviour is not the reference; AWS's documentation is. The runbook lists
  what a real account would still need beyond this code: real DNS and certificates, SES production
  access, the forwarded-header check, and backups and Multi-AZ.
