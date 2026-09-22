# 0011 — Testing strategy

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

"Production-ready" for a portfolio means tests that would catch real regressions in the rules that matter (state machine, SLA, permissions), not coverage theatre. NestJS defaults to Jest; the frontend ecosystem has moved to Vitest; integration tests need a real database because Prisma behaviour (transactions, unique violations, tsvector) cannot be faked meaningfully.

## Options considered

- **Jest for api, Vitest for web** — two runners, two configs, two mocking APIs to learn. Nest's Jest default is convention, not a requirement.
- **Vitest everywhere** (`unplugin-swc` for Nest decorators) — one runner, native ESM/TS, same `vi` mocking in every package, fast watch mode.
- **Integration DB**: mock Prisma (`vitest-mock-extended`) vs Testcontainers vs a dedicated `patchgrid_test` database in the same Compose Postgres. Mocks give false confidence for repository code; Testcontainers is elegant but slow to start on every run; a dedicated database in the already-running Compose stack is instant locally and maps directly to a GitHub Actions service container.
- **E2E**: Cypress vs Playwright — Playwright: faster, multi-browser, better TS story.

## Decision

Vitest in every package. Unit tests replace repositories with in-memory fakes implementing the repository interfaces (so services are tested without Prisma). Integration tests boot the Nest app against `patchgrid_test` in the Compose Postgres (CI: service container), run migrations once, and truncate all tables between test files. Playwright E2E in `apps/app/e2e`, written in M8 against the seeded stack. A `Clock` provider is injected everywhere time is read, so SLA and auto-close tests use `vi.useFakeTimers()` and never sleep. Integration and E2E fixtures always create **two** organizations so cross-tenant leaks surface as test failures (ADR-0015).

## Consequences

- Repository interfaces must be defined explicitly (not inferred from Prisma) — a small cost that also enforces the layering rule.
- The transition table gets a table-driven test that enumerates every `(type, from, action)` and asserts allowed/denied, so adding a state without updating tests fails loudly.
- CI runs unit + contract tests without services, then integration with services; E2E runs on `main` only to keep PR feedback under a few minutes.
