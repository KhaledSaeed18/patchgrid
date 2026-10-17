/**
 * From a fresh clone to a running, seeded stack — and safe to run again on one
 * that already is (README §Running it):
 *
 *   pnpm install && pnpm local:up && pnpm dev
 *
 * Each step is idempotent: an existing .env is kept (and given any variable
 * .env.example gained since it was made), the containers are left
 * up, the roles and grants are re-asserted, applied migrations are skipped, and
 * the seed leaves existing demo workspaces alone. `pnpm db:reset` is the step
 * that starts over.
 */
import { execFileSync } from "node:child_process"
import { appendFileSync, closeSync, constants, copyFileSync, openSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const root = path.join(import.meta.dirname, "..")

function step(title, command, args) {
  console.log(`\n▸ ${title}`)
  execFileSync(command, args, { cwd: root, stdio: "inherit" })
}

/** The variable names dotenv text sets. */
const names = (text) => new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))

const env = path.join(root, ".env")
const example = path.join(root, ".env.example")
try {
  // Exclusive: created only if absent, so nothing between a check and the copy can be overwritten.
  copyFileSync(example, env, constants.COPYFILE_EXCL)
  console.log("▸ .env created from .env.example (local development values only)")
} catch (error) {
  if (error.code !== "EEXIST") throw error
  // One descriptor for the read and the append: the file read is the file extended.
  const fd = openSync(env, "a+")
  try {
    // A clone made before a new setting existed would otherwise refuse to boot on it.
    const have = names(readFileSync(fd, "utf8"))
    const missing = readFileSync(example, "utf8").split("\n").filter((line) => {
      const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]
      return name !== undefined && !have.has(name)
    })
    if (missing.length > 0) {
      appendFileSync(fd, `\n# Added by local:up from .env.example\n${missing.join("\n")}\n`)
      console.log(`▸ .env exists — keeping it, and adding ${missing.map((l) => l.split("=")[0]).join(", ")} from .env.example`)
    } else {
      console.log("▸ .env exists — keeping it")
    }
  } finally {
    closeSync(fd)
  }
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
