/** The one thing the lock needs from a transaction client, whichever client opened it. */
type RawQuerying = { $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown> }

/**
 * Locks a person's `User` row for the rest of the transaction: the invariant
 * "recovery codes exist exactly while some factor does" spans two tables and
 * any number of rows, so every change to the set of factors serialises here
 * rather than reading and then writing (ADR-0053).
 */
export async function lockPerson(tx: RawQuerying, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`
}
