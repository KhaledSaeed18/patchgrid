import { defineConfig } from "vitest/config"

// Behaviour against a live, migrated database — the tenant client extension and
// the RLS policies underneath it. Needs DATABASE_URL (the app role) and
// DATABASE_MIGRATION_URL (the owner, to seed and clean up).
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    // Files share one database; the rows they seed must not interleave.
    fileParallelism: false,
  },
})
