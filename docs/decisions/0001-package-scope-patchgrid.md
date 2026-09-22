# 0001 — Package scope `@patchgrid/*`

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

The repo was scaffolded with `shadcn@latest init --monorepo`, which names workspace packages `@workspace/ui`, `@workspace/eslint-config`, `@workspace/typescript-config`. The spec docs refer to `@patchgrid/database` and `@patchgrid/contracts`. Two namespaces in one repo is confusing, and `@workspace` says nothing in a portfolio.

## Options considered

1. **Keep `@workspace/*`** — zero work now. Reads as unfinished scaffolding; docs would have to change.
2. **Rename to `@patchgrid/*`** — touch four `package.json` files, `components.json` aliases, tsconfig paths, and a handful of imports. Cheap while the app has one page.

## Decision

Rename everything to `@patchgrid/*` as the first M0 task, before any new package is added.

## Consequences

- Done together with the `apps/web` → `apps/app` rename and the creation of `apps/www` (ADR-0016), so the layout settles in one pass.

- `pnpm dlx shadcn add` continues to work because `components.json` aliases are updated.
- New packages (`database`, `contracts`) are created under `@patchgrid` from the start.
- No further renames; this is the permanent scope.
