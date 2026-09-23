import { defineConfig } from "vitest/config"

// Catalog assertions against a migrated database (test/schema.test.ts). Kept out
// of `pnpm test`, which runs in CI's `verify` job with no services.
export default defineConfig({
  test: {
    include: ["test/schema.test.ts"],
  },
})
