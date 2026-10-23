import path from "node:path"
import process from "node:process"

import pg from "pg"

/**
 * The browser suite's test clock: rather than wait out a deadline, move it.
 * The same move the API's integration specs make with `nextAttemptAt` — the
 * sweep that acts on the deadline is the real one, on its real schedule.
 * The one place the suite writes to the database, as its owner: it never
 * reads around the API to assert anything.
 */
function databaseUrl(): string {
  try {
    process.loadEnvFile(path.join(import.meta.dirname, "../../../../.env"))
  } catch {
    // CI and other runners pass the environment directly.
  }
  const url = process.env.DATABASE_MIGRATION_URL
  if (url === undefined || url === "")
    throw new Error(
      "DATABASE_MIGRATION_URL is required to move a ticket's clock"
    )
  return url
}

/** The ticket's response deadline, a minute ago, as if nobody had answered in time. */
export async function responseDeadlinePassed(ticketId: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    const moved = await client.query(
      `UPDATE "Ticket"
          SET "responseClockStartedAt" = now() - interval '2 hours', "respondBy" = now() - interval '1 minute'
        WHERE id = $1 AND "respondedAt" IS NULL`,
      [ticketId]
    )
    if (moved.rowCount !== 1)
      throw new Error(
        `ticket ${ticketId} has no running response clock to move`
      )
  } finally {
    await client.end()
  }
}
