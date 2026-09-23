import { defineConfig } from "vitest/config"

// Unit tests only — no database. The catalog assertions need a migrated database
// and run separately: `pnpm test:schema` (vitest.schema.config.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
})
