import swc from "unplugin-swc"
import { defineConfig } from "vitest/config"

// The tenancy isolation suite (ENGINEERING.md) — a release gate of its own,
// against a live, migrated database and Redis, as patchgrid_app. Kept apart
// from test:integration so CI reports it by name and never runs it twice.
export default defineConfig({
  test: {
    include: ["test/tenancy/**/*.int-spec.ts"],
    fileParallelism: false,
    globals: false,
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
})
