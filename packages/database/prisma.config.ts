import path from "node:path"
import process from "node:process"

import { defineConfig } from "prisma/config"

// Prisma 7 removed `url` from the datasource block — connection strings live here,
// and the client takes a driver adapter instead (see src/index.ts).
//
// Node 24 loads .env natively, so no dotenv dependency. CI supplies the variables
// directly, so a missing file is not an error.
try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../.env"))
} catch {
  // no local .env — variables come from the environment
}

// Migrations run as the OWNER role, which holds BYPASSRLS. The application never
// sees this URL (ADR-0015, ADR-0022).
//
// The datasource is omitted entirely when the variable is unset rather than passed
// as `undefined` — `exactOptionalPropertyTypes` draws that distinction, and it
// matters here: `prisma generate` needs no database, so CI must be able to run it
// without one.
const migrationUrl = process.env.DATABASE_MIGRATION_URL
// A scratch database Prisma wipes while diffing (`migrate dev`, the CI drift
// check). The owner role lacks CREATEDB, so the bootstrap provisions one for it.
const shadowUrl = process.env.DATABASE_SHADOW_URL

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: { path: path.join("prisma", "migrations") },
  ...(migrationUrl === undefined || migrationUrl === ""
    ? {}
    : {
        datasource: {
          url: migrationUrl,
          ...(shadowUrl === undefined || shadowUrl === "" ? {} : { shadowDatabaseUrl: shadowUrl }),
        },
      }),
})
