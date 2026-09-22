# Contributing

This is a personal learning and portfolio project, so it is not looking for feature
contributions — but the conventions below are what the repository actually enforces,
and they are worth knowing if you are reading the code or running it.

## Running it

```bash
cp .env.example .env            # ports are overridable; 5432 is often already taken
pnpm install
docker compose up -d            # postgres, redis, minio, mailpit
pnpm db:bootstrap               # roles, grants, default privileges, extensions
pnpm db:generate                # Prisma client
pnpm db:doctor                  # asserts the above actually took effect
pnpm dev                        # www :3000, app :3001, api :4000
```

`docs/ENGINEERING.md` §Local development has the detail, including the three
local-hostname tiers and why `db:reset` runs the bootstrap _after_ the reset.

## Where the rules live

The documentation is the specification, not a description written afterwards:

| Question                                                | Document               |
| ------------------------------------------------------- | ---------------------- |
| What are we building, and what are we deliberately not? | `docs/PROJECT.md`      |
| How are tenants isolated?                               | `docs/TENANCY.md`      |
| Who may do what?                                        | `docs/RBAC.md`         |
| What are the ITSM rules?                                | `docs/DOMAIN.md`       |
| What runs where, and what does the data look like?      | `docs/ARCHITECTURE.md` |
| How do we write and ship code?                          | `docs/ENGINEERING.md`  |
| What are we building next?                              | `docs/FEATURES.md`     |
| _Why_ is any of it this way?                            | `docs/decisions/`      |

If code and a document disagree, one of them is wrong — fix it, do not work around
it. A change to a rule ships in the same PR as the code that changes it.

## Commits

Conventional Commits, scoped, enforced by `commitlint` on a `commit-msg` hook. The
allowed scopes are in `commitlint.config.mjs`; a scope that is not on the list is a
rejected commit rather than a new convention.

```
feat(api): add the ticket transition endpoint
fix(app): stop the SLA countdown hydrating twice
docs: record why support sessions are read-only
```

One PR per task, small enough to review in ten minutes. `main` is always green.

## What CI will not let through

Worth knowing before you push:

- **Lint can fail.** `--max-warnings 0`, and the architectural boundaries in
  `@patchgrid/eslint-config/boundaries` are errors — a frontend importing the
  database package, a service importing Prisma, raw SQL outside a repository.
- **`db:doctor` runs in CI** and asserts the application role holds neither
  `BYPASSRLS` nor `CREATE`, and that default privileges are in place.
- **The whole stack is smoke-tested**: Compose up, API booted, `/health/ready`
  asserted.
- **Secrets are scanned across the full history**, not just the diff.

## Adding a tenant-owned table

The part that is easy to get half-right. It is not finished until it has:

1. `orgId`, and `@@unique([orgId, id])` so it can be a composite-FK target
2. an RLS policy from the shared template, with `FORCE ROW LEVEL SECURITY`
3. composite foreign keys — `references: [orgId, id]` — to every tenant-owned parent
4. `orgId`-first indexes
5. an entry in the schema-coverage test

Steps 1–4 without 5 is how the next table silently ships without a policy.
