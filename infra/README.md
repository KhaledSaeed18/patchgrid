# infra: the production rehearsal on emulated AWS

Patchgrid's production images on ECS behind an HTTPS load balancer, on
[Floci](https://floci.io/floci/), provisioned by OpenTofu (ADR-0058). It is a
separate, explicit rehearsal: `pnpm dev` and Compose remain the way to work.

## Prerequisites

- Docker, with about 20 GB free for the first build (the images, and BuildKit's
  cache, which `docker builder prune` reclaims afterwards)
- OpenTofu: `brew install opentofu`. Terraform would read the same code, but
  HashiCorp's registry is geo-blocked from here (ADR-0058)
- `pnpm install`. The script talks to AWS through the SDK, so it needs no AWS CLI

## Commands

| Command              | What it does                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm aws:up`        | Floci and Mailpit, the state backend, the platform, then a deploy. Safe to run again           |
| `pnpm aws:deploy`    | build → push to ECR → jobs → `provision` → `migrate` → services → every target healthy → smoke |
| `pnpm aws:run <job>` | One job and its logs: `provision`, `migrate`, `seed` (the demo workspaces) or `verify`         |
| `pnpm aws:status`    | Every service's running count and every target's health; exits non-zero unless all are healthy |
| `pnpm aws:e2e`       | Seeds, then the browser suite through the load balancer, passkeys included (below)             |
| `pnpm aws:down`      | Destroys services, jobs and the platform. `docker compose --profile aws down` then stops Floci |

Images are tagged by commit, so a deploy of the same commit pushes nothing. With
uncommitted changes the tag is the commit plus a timestamp, and every deploy rebuilds.

`pnpm aws:run verify` is the release gate: the tenancy isolation suite, from
inside the VPC, as the app role through PgBouncer. The worker service is taken
out of service while it runs and restored however it ends. The suite must be the
only consumer of the outbox it writes, and the outbox keeps what the live
workspaces emit meanwhile.

`pnpm aws:e2e` is the browser suite against the deployed stack, every spec but
SSO (its Keycloak runs on this machine, which a task cannot reach, and
production refuses a private issuer). Chromium and the suite's own requests send
the root domain and every subdomain to 127.0.0.1 and trust Floci's CA by its key
hash, so nothing on the machine changes, and passkeys work as on any https site.
The API's rate limits are rolled off for the run and back on however it ends,
as CI's development-stack suite runs them off: with no `X-Forwarded-For`, every
client shares one address and one per-IP budget.

CI runs `aws:up`, `aws:run verify` and `aws:e2e` from nothing on every change to
`main` and on pull requests that touch the infrastructure (`.github/workflows/aws.yml`).

## Layout

```
infra/
  modules/        written for real AWS; nothing in them knows it is emulated
    network       VPC, subnets, security groups
    secrets       KMS key, the API's keys in Secrets Manager
    data          RDS PostgreSQL 17, ElastiCache, the files bucket, the database secrets
    registry      ECR repositories
    edge          ALB, ACM wildcard certificate, Route 53 zones
    mail          the SES identity, DKIM, SPF and DMARC records
    cluster       ECS cluster, Cloud Map namespace, task and execution roles, log groups
    ecs-service   one task definition, optionally a service
  live/local/     the roots, pointed at Floci
    bootstrap     the state bucket and lock table (local state: something has to exist first)
    platform      everything that outlives a release
    jobs          the one-off task definitions, per image tag
    services      pgbouncer, api, worker, app, www, per image tag
    shared/       provider, versions and runtime environment, symlinked into each root
  images/         the layers this environment adds over the production images
```

The roots split by lifetime. `platform` changes rarely. `jobs` and `services`
are applied by every deploy with the new image tag.

## In a browser

1. Trust Floci's CA, which signed the ACM certificate. `pnpm aws:up` writes it to `infra/.floci/ca.pem`:

   ```sh
   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain infra/.floci/ca.pem
   ```

2. Resolve the product's hosts to the load balancer on 127.0.0.1. For Chromium, one flag covers every workspace:

   ```sh
   --host-resolver-rules="MAP patchgrid.test 127.0.0.1, MAP *.patchgrid.test 127.0.0.1"
   ```

   Otherwise, add the hosts you use to `/etc/hosts`: `patchgrid.test`, `app.`, `api.`, `admin.`, `acme.`, `globex.`.

3. Open `https://app.patchgrid.test`. After `pnpm aws:run seed`, every demo account's password is `patchgrid-demo`.

From a terminal, the same thing:
`curl --cacert infra/.floci/ca.pem --resolve api.patchgrid.test:443:127.0.0.1 https://api.patchgrid.test/health/ready`.

## Where Floci differs from AWS

AWS's documentation is the reference, not the emulator. The gaps from the spike
are closed in the design (ADR-0058). These are the ones running the deploy found:

- **Targets of a stopped task stay registered.** ECS deregisters a task's
  target when it stops; Floci keeps it, unhealthy for good, after every rollout
  and every crash. Each rollout in the script deregisters every target that is
  not a running task of its service, which is what ECS would have done.
- **The private zone's wildcard is matched only as a literal `*`.** The AWS
  provider sends `\052`, as Route 53 itself writes it, and Floci then answers
  nothing for `api.` inside the VPC. The fixed hosts (`api.`, `app.`, `admin.`)
  have their own records, which change nothing on AWS.
- **RDS parameters are stored, not applied.** `idle_in_transaction_session_timeout` and the slow-query
  log are not in force locally, and every `platform` plan shows the parameter group as changing.
- **The cache proxy speaks AUTH but not TLS.** AWS takes an AUTH token only with TLS, so the local root
  turns both off (`cache_transit_encryption = false`); they are on by default.
- **The master user is a superuser.** The `provision` job never relies on it (ADR-0059).
- **The ALB sends no `X-Forwarded-For` or `X-Forwarded-Proto`.** Every client
  shares one address here, so per-address limits are not exercised. The app
  builds its links with the configured protocol when no proxy names one.

## What a real account still needs

Beyond pointing the provider at AWS instead of Floci:

- a registered domain, a public hosted zone, and the ACM certificate validated through it
- SES production access, out of the sandbox, and the DKIM records published
- the forwarded-header check: confirm the ALB's `X-Forwarded-For` reaches the API with `TRUST_PROXY_HOPS=1`
- RDS backups, Multi-AZ and deletion protection (`deletion_protection = true`, which the local roots turn off)
- a Terraform/OpenTofu state bucket created once, by hand or by a bootstrap account, read only by the
  deploying role under its own KMS key; CI credentials by OIDC federation, never static keys
- the hardening a single machine cannot show: load balancer access logs and a WAF, VPC flow logs, RDS
  log exports to CloudWatch, ElastiCache snapshots and a replica, DMARC moved past `p=none` once DKIM
  verifies, per-tier execution roles, and read-only, non-root containers
