/**
 * Prints the tenant-isolation policy SQL for one or more tables, to append to the
 * migration that creates them (created with `prisma migrate dev --create-only`).
 *
 *   pnpm --filter @patchgrid/database run policy Team TeamMembership
 */
import process from "node:process"

import { tenantPolicySql } from "../src/rls.ts"

const tables = process.argv.slice(2)
if (tables.length === 0) {
  console.error("usage: policy <Table> [<Table> …]")
  process.exit(1)
}
console.log(tables.map(tenantPolicySql).join("\n\n"))
