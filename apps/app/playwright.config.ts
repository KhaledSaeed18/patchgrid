import { defineConfig, devices } from "@playwright/test"

/**
 * End-to-end tests. Written in M9, against the seeded two-tenant stack.
 *
 * Deliberately configured now and deliberately empty: the config is where the
 * decisions live (which browsers, how retries work, what counts as a flake), and
 * making those choices while the suite is empty is easier than making them while
 * a flaky test is blocking a release.
 *
 * `turbo test` does not run this — `pnpm --filter @patchgrid/app test:e2e` does.
 * E2E runs on `main` only, to keep PR feedback under a few minutes (ADR-0011).
 */
const isCi = process.env.CI !== undefined

export default defineConfig({
  testDir: "./e2e",
  // A test that only passes sometimes is a test that tells you nothing. Retries
  // exist for CI's noisier environment, not to paper over a real race.
  retries: isCi ? 2 : 0,
  forbidOnly: isCi,
  // `workers` is omitted rather than set to `undefined`: under
  // `exactOptionalPropertyTypes` those are different things, and only the first
  // means "use the default".
  ...(isCi ? { workers: 1 } : {}),
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
