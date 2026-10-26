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
| `pnpm aws:down`      | Destroys services, jobs and the platform. `docker compose --profile aws down` then stops Floci |

Images are tagged by commit, so a deploy of the same commit pushes nothing. With
uncommitted changes the tag is the commit plus a timestamp, and every deploy rebuilds.

`pnpm aws:run verify` is the release gate: the tenancy isolation suite, from
inside the VPC, as the app role through PgBouncer. The worker service is taken
out of service while it runs and restored however it ends. The suite must be the
only consumer of the outbox it writes, and the outbox keeps what the live
workspaces emit meanwhile.

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
  target when it stops. Floci keeps it, so after a task fails its health check, its
  target stays `unhealthy` for good and `aws:status` reports the group
  unhealthy. Deregister it by hand:
  `aws elbv2 deregister-targets --target-group-arn <arn> --targets Id=<ip>,Port=<port>`
  (with `AWS_ENDPOINT_URL=http://localhost:4566`).
- **The master user is a superuser.** The `provision` job never relies on it (ADR-0059).
- **The ALB sends no `X-Forwarded-For`.** Every client is the loopback here, so
  per-address limits are not exercised.

## What a real account still needs

Beyond pointing the provider at AWS instead of Floci:

- a registered domain, a public hosted zone, and the ACM certificate validated through it
- SES production access, out of the sandbox, and the DKIM records published
- the forwarded-header check: confirm the ALB's `X-Forwarded-For` reaches the API with `TRUST_PROXY_HOPS=1`
- RDS backups, Multi-AZ and deletion protection (`deletion_protection = true`, which the local roots turn off)
- a Terraform/OpenTofu state bucket created once, by hand or by a bootstrap account
