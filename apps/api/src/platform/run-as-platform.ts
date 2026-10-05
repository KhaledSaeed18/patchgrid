import { type Crossing, crossingLogger, requestContext } from "./crossing"

/**
 * Runs `fn` with NO tenant context (ADR-0022).
 *
 * Inside it only platform-class tables are reachable — `Organization`, `User`,
 * the token tables, the two projections. A tenant-owned query throws at the
 * client extension, and even a raw one gets zero rows from RLS. This is the
 * job dispatcher listing active organizations, login and the org picker, and
 * API-token authentication resolving a prefix to an org — the three questions
 * that must be answered before a tenant is known.
 *
 * The callback runs in a child context: the caller's tenant and any open
 * transaction are hidden from it and restored when it returns.
 *
 * Importable only by `src/platform`, `src/auth` and `src/jobs/dispatcher`; the
 * linter enforces it.
 */
export async function runAsPlatform<T>(crossing: Crossing, fn: () => Promise<T>): Promise<T> {
  const cls = requestContext()
  const from = cls.isActive() ? (cls.get("tenant")?.orgId ?? "platform") : "none"
  crossingLogger.log({ msg: "runAsPlatform", from, actor: crossing.actor, reason: crossing.reason })

  return cls.run({ ifNested: "inherit" }, async () => {
    cls.set("tenant", undefined)
    cls.set("prismaTransaction", undefined)
    return await fn()
  })
}
