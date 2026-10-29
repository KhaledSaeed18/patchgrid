import { defineConfig, devices } from "@playwright/test"

import { chromiumArgs } from "./e2e/support/stack"

/**
 * The README's screenshots, regenerated from the running demo stack rather
 * than kept by hand. Not a test suite: nothing here asserts behaviour, and the
 * E2E config never matches these files.
 *
 *   pnpm db:seed -- --reset   # deadlines count from now; the operator has no factor yet
 *   pnpm dev
 *   pnpm --filter @patchgrid/app screenshots
 *
 * Every workspace page is taken twice, light and dark, from one navigation.
 * With `docker compose --profile observability up -d` and
 * OTEL_EXPORTER_OTLP_ENDPOINT set, the tenant dashboard is taken too.
 */
export default defineConfig({
  testDir: "./e2e/screenshots",
  testMatch: "*.screens.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  outputDir: "./test-results/screenshots",
  use: {
    ...devices["Desktop Chrome"],
    // The README's frame: a laptop viewport at retina density.
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    launchOptions: { args: chromiumArgs },
  },
})
