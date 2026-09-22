# End-to-end tests

Empty until M9, on purpose. `docs/ENGINEERING.md` §Testing: E2E is written once a
milestone's feature is functionally complete, not before — a browser test against a
half-built screen tests the scaffolding.

What lands here (`docs/FEATURES.md` M9):

- signup → provisioning → invite → full incident lifecycle
- an SLA breach, using a one-minute policy rather than waiting
- a Change going submit → approve → implement → close
- **a cross-tenant negative test** — a session for one workspace must not reach
  another's, in a real browser rather than a mocked request
- **a role-escalation negative test**
- **two tabs, two tenants**, both staying usable — the property per-tenant cookies
  exist to provide (ADR-0024)

The last three are the point. The happy path is the easy part.

Run with `pnpm --filter @patchgrid/app test:e2e` against a seeded stack. Browsers
are not installed by `pnpm install`; run `pnpm exec playwright install chromium`
when the suite arrives.
