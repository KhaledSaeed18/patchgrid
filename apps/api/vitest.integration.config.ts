import swc from "unplugin-swc"
import { defineConfig } from "vitest/config"

// Behaviour against a live, migrated database as patchgrid_app — the request
// context, the scoped Prisma client and the crossing helpers with RLS underneath.
// Needs DATABASE_URL (the app role) and DATABASE_MIGRATION_URL (the owner, to
// seed and clean up). Run by the CI `schema` job, never by `verify`.
export default defineConfig({
  test: {
    include: ["test/**/*.int-spec.ts"],
    // The isolation suite is its own gate: `test:tenancy`.
    exclude: ["test/tenancy/**"],
    // Files share one database; the rows they seed must not interleave.
    fileParallelism: false,
    globals: false,
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
})
