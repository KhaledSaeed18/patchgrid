# Patchgrid

[![CI](https://github.com/KhaledSaeed18/patchgrid/actions/workflows/ci.yml/badge.svg)](https://github.com/KhaledSaeed18/patchgrid/actions/workflows/ci.yml)
[![CodeQL](https://github.com/KhaledSaeed18/patchgrid/actions/workflows/codeql.yml/badge.svg)](https://github.com/KhaledSaeed18/patchgrid/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)](.nvmrc)

A **multi-tenant IT service management platform** — ticketing and operations for IT
and security teams, built as a production-grade reference rather than a tutorial.

Incidents, service requests, problems and changes are four different things with four
different lifecycles. Priority is computed from impact × urgency, never typed into a
dropdown. Each company gets its own subdomain, and its data is isolated at the
**database** level — not by remembering to add a `WHERE` clause.

```
patchgrid.xyz           marketing            apps/www    Next.js
<slug>.patchgrid.xyz    tenant workspace     apps/app    Next.js
api.patchgrid.xyz       everything else      apps/api    NestJS
```

## Isolation, in five layers

The thing this project is actually about:

0. **Schema shape** — composite `(orgId, id)` foreign keys, so a cross-tenant
   reference is _unrepresentable_. PostgreSQL runs referential-integrity checks with
   row security off, so this is the layer the other four cannot provide.
1. **Request context** — the tenant comes from the credential, never the host
2. **Repository arguments** — every method takes an explicit `orgId`
3. **Prisma client extension** — transaction-local `set_config`, throws without context
4. **Postgres RLS** — `FORCE ROW LEVEL SECURITY`, and an app role that holds no `BYPASSRLS`

## Running it

```bash
cp .env.example .env
pnpm install
docker compose up -d
pnpm db:bootstrap && pnpm db:generate && pnpm db:doctor
pnpm dev
```

`www` on `lvh.me:3000`, `app` on `<slug>.lvh.me:3001`, `api` on `api.lvh.me:4000`.
`db:doctor` asserts the isolation invariants actually hold — expect 6/6.

## Documentation

The docs are the specification, not a description written afterwards.

|                                                                                     |                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`docs/HANDOFF.md`](docs/HANDOFF.md)                                                | **Start here** — what is built, what is not, what comes next  |
| [`docs/PROJECT.md`](docs/PROJECT.md)                                                | What this is, and what it deliberately is not                 |
| [`docs/TENANCY.md`](docs/TENANCY.md) · [`docs/RBAC.md`](docs/RBAC.md)               | Isolation between tenants; authorization within one           |
| [`docs/DOMAIN.md`](docs/DOMAIN.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | ITSM rules; stack, pipeline and data model                    |
| [`docs/ENGINEERING.md`](docs/ENGINEERING.md) · [`docs/DNS.md`](docs/DNS.md)         | How we work; hostnames, TLS and mail                          |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)                                      | Assets, actors, trust boundaries, STRIDE — and accepted risks |
| [`docs/FEATURES.md`](docs/FEATURES.md)                                              | The backlog, milestone by milestone                           |
| [`docs/decisions/`](docs/decisions/)                                                | 31 ADRs — _why_ any of it is this way                         |

## Status

**M0 (foundation) complete. M1 (tenancy and identity) in progress**: the threat model, the identity
and tenancy schema with its CI-gated catalog assertions, and the tenant-isolating Prisma client are in;
tenant context, auth and provisioning are next. `docs/HANDOFF.md` has the detail. Screenshots, an
architecture diagram and a public demo arrive with the final milestone.

MIT licensed — the value of this repository is that people read it.
