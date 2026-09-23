/**
 * Fails when a migration drops a table or column without saying why it is safe
 * (ENGINEERING.md §Schema changes). Migrations are additive in the release that
 * introduces them, so a drop is only safe once an EARLIER release stopped
 * reading the thing — and the annotation is where that claim is written down:
 *
 *   -- safe: nothing has read "Ticket"."legacyRef" since 2026-11 (release 14)
 *   ALTER TABLE "Ticket" DROP COLUMN "legacyRef";
 *
 * The `-- safe:` line must be in the comment block directly above the statement.
 *
 *   pnpm --filter @patchgrid/database run migrations:check
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const DESTRUCTIVE = /\bDROP\s+(TABLE|COLUMN)\b/i
const SAFE = /^--\s*safe:\s*\S/i

export type Finding = { statement: string; line: number }

/** Pure, so it is unit-tested without a filesystem (migration-safety.test.ts). */
export function unsafeDrops(sql: string): Finding[] {
  const findings: Finding[] = []
  let comments: string[] = []
  let statement: string[] = []
  let startLine = 0

  sql.split("\n").forEach((raw, index) => {
    const line = raw.trim()
    if (statement.length === 0) {
      if (line === "") {
        comments = []
        return
      }
      if (line.startsWith("--")) {
        comments.push(line)
        return
      }
      startLine = index + 1
    }
    statement.push(line)
    if (line.endsWith(";")) {
      const text = statement.join(" ")
      if (DESTRUCTIVE.test(text) && !comments.some((c) => SAFE.test(c))) {
        findings.push({ statement: text, line: startLine })
      }
      statement = []
      comments = []
    }
  })
  return findings
}

async function main(): Promise<void> {
  const root = path.join(import.meta.dirname, "../prisma/migrations")
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory())
  let failures = 0
  for (const dir of dirs.map((d) => d.name).sort()) {
    const file = path.join(root, dir, "migration.sql")
    for (const finding of unsafeDrops(await readFile(file, "utf8"))) {
      failures += 1
      console.error(`${dir}/migration.sql:${finding.line}  ${finding.statement}`)
    }
  }
  if (failures > 0) {
    console.error(
      `\n${failures} destructive statement(s) without a \`-- safe:\` annotation. Say which earlier ` +
        "release stopped reading it, in a comment directly above the statement.",
    )
    process.exit(1)
  }
  console.log(`migration safety: ${dirs.length} migration(s), no unannotated drops`)
}

if (import.meta.filename === process.argv[1]) {
  await main()
}
