import { defineConfig, devices } from "@playwright/test"

/**
 * End-to-end tests, against the seeded two-tenant stack (`pnpm db:seed`) with
 * the API, the app and Mailpit running. `e2e/README.md` says what each spec
 * covers and why the negatives are the point.
 *
 * `turbo test` does not run this — `pnpm --filter @patchgrid/app test:e2e` does.
 * E2E runs on `main` only, to keep PR feedback under a few minutes (ADR-0011).
 */
const isCi = process.env.CI !== undefined

export default defineConfig({
  testDir: "./e2e",
  // Every spec drives the one shared stack: one worker, in order, everywhere.
  workers: 1,
  fullyParallel: false,
  // A test that only passes sometimes is a test that tells you nothing. Retries
  // exist for CI's noisier environment, not to paper over a real race.
  retries: isCi ? 2 : 0,
  forbidOnly: isCi,
  // Mail goes through a queue and the SLA sweep runs once a minute; the
  // specs poll for both, so a step may legitimately take a while.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: isCi ? ([["list"], ["html", { open: "never" }]] as const) : "list",

  use: {
    // Tenants are addressed by subdomain, so the base URL is a tenant host and
    // cross-tenant navigation is part of what the suite exercises.
    baseURL: process.env.E2E_BASE_URL ?? "http://acme.lvh.me:3001",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
