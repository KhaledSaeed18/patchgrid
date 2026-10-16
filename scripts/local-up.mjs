/**
 * From a fresh clone to a running, seeded stack — and safe to run again on one
 * that already is (README §Running it):
 *
 *   pnpm install && pnpm local:up && pnpm dev
 *
 * Each step is idempotent: an existing .env is kept, the containers are left
 * up, the roles and grants are re-asserted, applied migrations are skipped, and
 * the seed leaves existing demo workspaces alone. `pnpm db:reset` is the step
 * that starts over.
 */
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const root = path.join(import.meta.dirname, "..")

function step(title, command, args) {
  console.log(`\n▸ ${title}`)
  execFileSync(command, args, { cwd: root, stdio: "inherit" })
}

const env = path.join(root, ".env")
if (existsSync(env)) {
  console.log("▸ .env exists — keeping it")
} else {
  copyFileSync(path.join(root, ".env.example"), env)
  console.log("▸ .env created from .env.example (local development values only)")
}

try {
  step("Postgres, Redis, MinIO and Mailpit, waiting for each to be healthy", "docker", [
    "compose", "up", "-d", "--wait", "postgres", "redis", "minio", "mailpit",
  ])
  step("The attachments bucket and its lifecycle rule", "docker", ["compose", "run", "--rm", "minio-init"])
  step("Database roles and grants (ADR-0015, ADR-0022)", "pnpm", ["db:bootstrap"])
  // `deploy`, not `migrate dev`: apply what is committed, never author a migration.
  step("Migrations, RLS policies included", "pnpm", ["--filter", "@patchgrid/database", "run", "migrate:deploy"])
  step("The Prisma client", "pnpm", ["db:generate"])
  step("The isolation invariants, asserted against the live database", "pnpm", ["db:doctor"])
  step("The demo workspaces, acme and globex", "pnpm", ["db:seed"])
} catch {
  console.error("\nlocal:up stopped at the step above; its output says why. Fix it and run again — every step is safe to repeat.")
  process.exit(1)
}

console.log(`
✔ Ready. Start the three apps with:  pnpm dev

  marketing   http://lvh.me:3000
  sign in     http://app.lvh.me:3001   (sam@patchgrid.test / patchgrid-demo)
  api         http://api.lvh.me:4000/api/docs
  mail        http://localhost:8025
`)
